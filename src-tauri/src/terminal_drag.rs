use std::collections::{HashMap, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Default)]
pub struct DragObservers(Mutex<DragRegistry>);

#[derive(Default)]
struct DragRegistry {
    active: HashMap<String, (String, Arc<AtomicBool>)>,
    ended: VecDeque<(String, String)>,
}

impl DragObservers {
    fn start(&self, source: &str, id: &str) -> Result<Arc<AtomicBool>, String> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut registry = self.0.lock().map_err(|_| "Drag observer unavailable")?;
        // IPC cancellation may arrive before its async waiter is scheduled.
        if registry
            .ended
            .iter()
            .any(|(window, gesture)| window == source && gesture == id)
        {
            cancelled.store(true, Ordering::Relaxed);
            return Ok(cancelled);
        }
        if let Some((previous_id, previous)) = registry
            .active
            .insert(source.into(), (id.into(), cancelled.clone()))
        {
            previous.store(true, Ordering::Relaxed);
            registry.ended.push_back((source.into(), previous_id));
            if registry.ended.len() > 128 {
                registry.ended.pop_front();
            }
        }
        Ok(cancelled)
    }
    fn stop(&self, source: &str, id: &str) -> Result<(), String> {
        let mut registry = self.0.lock().map_err(|_| "Drag observer unavailable")?;
        if registry
            .active
            .get(source)
            .is_some_and(|(active, _)| active == id)
        {
            if let Some((_, cancelled)) = registry.active.remove(source) {
                cancelled.store(true, Ordering::Relaxed);
            }
        }
        registry.ended.push_back((source.into(), id.into()));
        if registry.ended.len() > 128 {
            registry.ended.pop_front();
        }
        Ok(())
    }
}

#[derive(serde::Serialize)]
pub struct DragRelease {
    released: bool,
    point: DragPoint,
}
#[derive(serde::Serialize, serde::Deserialize)]
pub struct DragPoint {
    pub x: i32,
    pub y: i32,
}

/// A caller-scoped, cancellable observer of fixed mouse/Escape state. Capture
/// the physical cursor at release, before a delayed webview can sample it again.
#[tauri::command]
pub async fn wait_terminal_drag_release(
    window: tauri::WebviewWindow,
    observers: tauri::State<'_, DragObservers>,
    gesture_id: String,
) -> Result<Option<DragRelease>, String> {
    if !terminal_destination_label(window.label()) || uuid::Uuid::parse_str(&gesture_id).is_err() {
        return Err("Invalid terminal drag observer".into());
    }
    let cancelled = observers.start(window.label(), &gesture_id)?;
    #[cfg(windows)]
    let result = {
        tauri::async_runtime::spawn_blocking(move || {
            use std::time::{Duration, Instant};
            use windows_sys::Win32::Foundation::POINT;
            use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
                GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON,
            };
            use windows_sys::Win32::UI::WindowsAndMessaging::GetPhysicalCursorPos;
            let deadline = Instant::now() + Duration::from_secs(120);
            loop {
                if cancelled.load(Ordering::Relaxed) {
                    return Ok(None);
                }
                // SAFETY: These calls only read the current state of two fixed
                // keys; no input is generated or arbitrary key is accepted.
                let (left_down, escape_down) = unsafe {
                    (
                        GetAsyncKeyState(i32::from(VK_LBUTTON)) < 0,
                        GetAsyncKeyState(i32::from(VK_ESCAPE)) < 0,
                    )
                };
                if let Some(released) = release_state(left_down, escape_down) {
                    let mut point = POINT { x: 0, y: 0 };
                    // The worker's DPI context can differ from the webview's.
                    // Read physical pixels explicitly, never virtualized screen coordinates.
                    // SAFETY: GetPhysicalCursorPos writes only to this stack value.
                    if unsafe { GetPhysicalCursorPos(&mut point) } == 0 {
                        return Err("Could not read terminal drop position".into());
                    }
                    return Ok(Some(DragRelease {
                        released,
                        point: DragPoint {
                            x: point.x,
                            y: point.y,
                        },
                    }));
                }
                if Instant::now() >= deadline {
                    return Err("Terminal drag observation timed out".into());
                }
                std::thread::sleep(Duration::from_millis(16));
            }
        })
        .await
        .map_err(|error| format!("Could not observe terminal drag: {error}"))
        .and_then(std::convert::identity)
    };
    #[cfg(not(windows))]
    let result = {
        let _ = cancelled;
        // Other platforms continue through the webview's pointerup path.
        Ok(None)
    };
    observers.stop(window.label(), &gesture_id)?;
    result
}

#[tauri::command]
pub fn cancel_terminal_drag(
    window: tauri::WebviewWindow,
    observers: tauri::State<'_, DragObservers>,
    gesture_id: String,
) -> Result<(), String> {
    if !terminal_destination_label(window.label()) || uuid::Uuid::parse_str(&gesture_id).is_err() {
        return Err("Invalid terminal drag source".into());
    }
    observers.stop(window.label(), &gesture_id)
}

/// Resolve only an app-owned terminal window at a physical cursor point. Other
/// applications occlude a destination; their names, handles and text stay private.
#[tauri::command]
pub fn terminal_dock_target(
    window: tauri::WebviewWindow,
    x: i32,
    y: i32,
    exclude_source: bool,
) -> Result<Option<String>, String> {
    use tauri::Manager;
    let windows = window.app_handle().webview_windows();
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetTopWindow, GetWindow, GetWindowLongW, GetWindowRect, IsIconic, IsWindowVisible,
            GWL_EXSTYLE, GW_HWNDNEXT,
        };
        let mut labels = std::collections::HashMap::new();
        for (label, candidate) in &windows {
            if let Ok(handle) = candidate.hwnd() {
                labels.insert(handle.0 as usize, label.as_str());
            }
        }
        // SAFETY: We only walk top-level window handles and read visibility and
        // bounds. No foreign text, process metadata or input is accessed.
        unsafe {
            let mut handle = GetTopWindow(std::ptr::null_mut());
            for _ in 0..4096 {
                if handle.is_null() {
                    break;
                }
                let label = labels.get(&(handle as usize)).copied();
                let skip = label.is_some_and(|label| {
                    label.starts_with("tab-preview-") || (exclude_source && label == window.label())
                });
                // Layered click-through overlays (for example cursor effects)
                // do not intercept input and must not occlude a dock target.
                if !skip
                    && IsWindowVisible(handle) != 0
                    && IsIconic(handle) == 0
                    && !is_click_through(GetWindowLongW(handle, GWL_EXSTYLE) as u32)
                {
                    let mut rect: RECT = std::mem::zeroed();
                    if GetWindowRect(handle, &mut rect) != 0
                        && point_in_rect(x, y, rect.left, rect.top, rect.right, rect.bottom)
                    {
                        return Ok(label
                            .filter(|label| terminal_destination_label(label))
                            .map(str::to_owned));
                    }
                }
                handle = GetWindow(handle, GW_HWNDNEXT);
            }
        }
        Ok(None)
    }
    #[cfg(not(windows))]
    {
        for (label, candidate) in windows {
            if !terminal_destination_label(&label)
                || (exclude_source && label == window.label())
                || !candidate.is_visible().unwrap_or(false)
                || candidate.is_minimized().unwrap_or(true)
            {
                continue;
            }
            let position = candidate
                .outer_position()
                .map_err(|error| error.to_string())?;
            let size = candidate.outer_size().map_err(|error| error.to_string())?;
            if point_in_rect(
                x,
                y,
                position.x,
                position.y,
                position.x.saturating_add_unsigned(size.width),
                position.y.saturating_add_unsigned(size.height),
            ) {
                return Ok(Some(label));
            }
        }
        Ok(None)
    }
}

fn terminal_destination_label(label: &str) -> bool {
    label == "main" || (label.starts_with("detached-") && !label.starts_with("detached-map-"))
}

fn point_in_rect(x: i32, y: i32, left: i32, top: i32, right: i32, bottom: i32) -> bool {
    x >= left && x < right && y >= top && y < bottom
}

#[cfg(windows)]
fn is_click_through(style: u32) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{WS_EX_LAYERED, WS_EX_TRANSPARENT};
    style & (WS_EX_LAYERED | WS_EX_TRANSPARENT) == WS_EX_LAYERED | WS_EX_TRANSPARENT
}

#[cfg(any(windows, test))]
fn release_state(left_down: bool, escape_down: bool) -> Option<bool> {
    if escape_down {
        Some(false)
    } else if !left_down {
        Some(true)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::release_state;

    #[test]
    #[cfg(windows)]
    fn only_layered_click_through_overlays_are_ignored() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{WS_EX_LAYERED, WS_EX_TRANSPARENT};
        assert!(super::is_click_through(WS_EX_LAYERED | WS_EX_TRANSPARENT));
        assert!(!super::is_click_through(0));
        assert!(!super::is_click_through(WS_EX_LAYERED));
        assert!(!super::is_click_through(WS_EX_TRANSPARENT));
    }

    #[test]
    fn dock_geometry_uses_physical_coordinates_and_excludes_maps() {
        assert!(super::point_in_rect(-1200, 300, -1920, 200, 0, 1080));
        assert!(!super::point_in_rect(0, 300, -1920, 200, 0, 1080));
        assert!(super::terminal_destination_label("main"));
        assert!(super::terminal_destination_label("detached-tab-1"));
        assert!(!super::terminal_destination_label("detached-map-1"));
        assert!(!super::terminal_destination_label("tab-preview-1"));
        let permission = "allow-terminal-dock-target";
        assert!(include_str!("../capabilities/default.json").contains(permission));
        assert!(include_str!("../capabilities/detached-terminal.json").contains(permission));
        assert!(!include_str!("../capabilities/detached-map.json").contains(permission));
    }

    #[test]
    fn terminal_drag_waits_for_release_and_escape_cancels_even_after_release() {
        assert_eq!(release_state(true, false), None);
        assert_eq!(release_state(false, false), Some(true));
        assert_eq!(release_state(true, true), Some(false));
        assert_eq!(release_state(false, true), Some(false));
    }

    #[test]
    fn drag_observation_is_scoped_to_terminal_windows() {
        let detached: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/detached-terminal.json"))
                .expect("detached capability");
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("main capability");
        let permission = serde_json::json!("allow-wait-terminal-drag-release");
        assert!(detached["permissions"]
            .as_array()
            .expect("permissions")
            .contains(&permission));
        assert!(main["permissions"]
            .as_array()
            .expect("permissions")
            .contains(&permission));
        assert!(!include_str!("../capabilities/detached-map.json")
            .contains("allow-wait-terminal-drag-release"));
        assert!(include_str!("../capabilities/default.json").contains("allow-cancel-terminal-drag"));
        assert!(include_str!("../capabilities/detached-terminal.json")
            .contains("allow-cancel-terminal-drag"));
    }

    #[test]
    fn cancellation_cannot_stop_a_new_gesture_or_another_window() {
        let observers = super::DragObservers::default();
        let old = observers.start("main", "first").expect("start");
        let next = observers.start("main", "second").expect("start");
        assert!(old.load(super::Ordering::Relaxed));
        observers.stop("main", "first").expect("old stop");
        observers
            .stop("detached-other", "second")
            .expect("other stop");
        assert!(!next.load(super::Ordering::Relaxed));
        observers.stop("main", "second").expect("stop");
        assert!(next.load(super::Ordering::Relaxed));
        assert!(observers.0.lock().expect("lock").active.is_empty());
        observers
            .stop("main", "cancel-before-start")
            .expect("early cancel");
        assert!(observers
            .start("main", "cancel-before-start")
            .expect("late start")
            .load(super::Ordering::Relaxed));
    }
}
