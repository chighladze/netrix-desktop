use tauri::{ipc::Channel, webview::PageLoadPayload, Webview, WebviewWindow};

/// Watch the next file access request made by the Files destination picker.
/// Unsupported runtimes keep their own permission prompt.
#[tauri::command]
pub async fn watch_sftp_save_access(
    window: WebviewWindow,
    on_request: Channel<()>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("File save confirmation belongs to the main window".into());
    }
    #[cfg(windows)]
    {
        platform::watch(window, on_request).await
    }
    #[cfg(not(windows))]
    {
        let _ = on_request;
        Ok(false)
    }
}

#[tauri::command]
pub fn finish_sftp_save_access(window: WebviewWindow, id: u32, allow: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("File save confirmation belongs to the main window".into());
    }
    #[cfg(windows)]
    {
        window
            .run_on_main_thread(move || platform::finish(Some(id), allow))
            .map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (id, allow);
        Ok(())
    }
}

pub fn cancel_on_navigation(webview: &Webview, payload: &PageLoadPayload<'_>) {
    #[cfg(windows)]
    if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
        let _ = webview.run_on_main_thread(|| platform::finish(None, false));
    }
    #[cfg(not(windows))]
    let _ = (webview, payload);
}

#[cfg(windows)]
mod platform {
    use std::{cell::RefCell, time::Duration};

    use tauri::{ipc::Channel, Manager, Url, WebviewWindow};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2Deferral, ICoreWebView2PermissionRequestedEventArgs,
        ICoreWebView2PermissionRequestedEventArgs3, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE, COREWEBVIEW2_PERMISSION_STATE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
        COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    use webview2_com::{take_pwstr, PermissionRequestedEventHandler};
    use windows_core::{Interface, BOOL, PWSTR};

    // These COM objects belong to the webview's UI thread. There is only one
    // Files picker in the main window at a time.
    thread_local! {
        static WATCH: RefCell<Option<Watch>> = const { RefCell::new(None) };
    }

    struct Watch {
        id: u32,
        webview: ICoreWebView2,
        token: i64,
        pending: Option<PendingPermission>,
    }

    impl Drop for Watch {
        fn drop(&mut self) {
            // SAFETY: registration and removal run on the owning UI thread.
            let _ = unsafe { self.webview.remove_PermissionRequested(self.token) };
        }
    }

    struct PendingPermission {
        args: ICoreWebView2PermissionRequestedEventArgs,
        deferral: ICoreWebView2Deferral,
    }

    impl Drop for PendingPermission {
        fn drop(&mut self) {
            // SAFETY: the default decision is already DENY and the deferral
            // is completed once, on the same thread that received the request.
            let _ = unsafe { self.deferral.Complete() };
        }
    }

    pub(super) fn finish(id: Option<u32>, allow: bool) {
        let watch = WATCH.with_borrow_mut(|slot| match slot.as_ref() {
            Some(watch) if id.is_none() || id == Some(watch.id) => slot.take(),
            _ => None,
        });
        if !allow {
            return;
        }
        if let Some(pending) = watch.as_ref().and_then(|watch| watch.pending.as_ref()) {
            // SAFETY: only an answer for this outstanding picker reaches here.
            let _ = unsafe { pending.args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW) };
        }
    }

    pub(super) async fn watch(
        window: WebviewWindow,
        on_request: Channel<()>,
    ) -> Result<bool, String> {
        let url = window.url().map_err(|error| error.to_string())?;
        let origin = url.origin().ascii_serialization();
        let dev_origin = tauri::is_dev()
            && window
                .config()
                .build
                .dev_url
                .as_ref()
                .is_some_and(|dev| dev.origin() == url.origin());
        if !dev_origin
            && !matches!(
                origin.as_str(),
                "http://tauri.localhost" | "https://tauri.localhost"
            )
        {
            return Ok(false);
        }

        let (send, mut receive) = tauri::async_runtime::channel(1);
        let caller = window.clone();
        window
            .with_webview(move |platform_webview| {
                // SAFETY: with_webview executes on the controller's owning thread.
                let installed = unsafe { platform_webview.controller().CoreWebView2() }
                    .and_then(|webview| install(webview, caller, origin, on_request));
                let _ = send.try_send(installed.is_ok());
            })
            .map_err(|error| error.to_string())?;
        Ok(receive.recv().await.unwrap_or(false))
    }

    fn install(
        webview: ICoreWebView2,
        window: WebviewWindow,
        origin: String,
        on_request: Channel<()>,
    ) -> windows_core::Result<()> {
        finish(None, false);
        let id = on_request.id();
        let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            if !is_picker_request(&args, &origin)? {
                return Ok(());
            }
            // Older WebView2 versions without per-request decisions keep
            // their prompt. Never save an ALLOW decision in the profile.
            let Ok(scoped) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() else {
                return Ok(());
            };
            let captured = WATCH.with_borrow_mut(|slot| -> windows_core::Result<bool> {
                let Some(watch) = slot
                    .as_mut()
                    .filter(|watch| watch.id == id && watch.pending.is_none())
                else {
                    return Ok(false);
                };
                // SAFETY: WebView2 supplied these event arguments on this thread.
                unsafe {
                    scoped.SetSavesInProfile(false)?;
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    let deferral = args.GetDeferral()?;
                    watch.pending = Some(PendingPermission { args, deferral });
                }
                Ok(true)
            })?;
            if captured {
                if on_request.send(()).is_err() {
                    finish(Some(id), false);
                } else {
                    let window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(120)).await;
                        let _ = window.run_on_main_thread(move || finish(Some(id), false));
                    });
                }
            }
            Ok(())
        }));
        let mut token = 0;
        // SAFETY: the callback and token are registered on the webview thread.
        unsafe { webview.add_PermissionRequested(&handler, &mut token)? };
        WATCH.with_borrow_mut(|slot| {
            *slot = Some(Watch {
                id,
                webview,
                token,
                pending: None,
            })
        });
        Ok(())
    }

    fn is_picker_request(
        args: &ICoreWebView2PermissionRequestedEventArgs,
        origin: &str,
    ) -> windows_core::Result<bool> {
        // SAFETY: these getters fill local values from the live event on its UI thread.
        unsafe {
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            if kind != COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE {
                return Ok(false);
            }
            let mut state = COREWEBVIEW2_PERMISSION_STATE::default();
            args.State(&mut state)?;
            if state != COREWEBVIEW2_PERMISSION_STATE_DEFAULT {
                return Ok(false);
            }
            let mut user_initiated = BOOL::default();
            args.IsUserInitiated(&mut user_initiated)?;
            if !user_initiated.as_bool() {
                return Ok(false);
            }
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            Ok(Url::parse(&take_pwstr(uri))
                .is_ok_and(|uri| uri.origin().ascii_serialization() == origin))
        }
    }
}
