; Tauri CLI 2.1 checks only the registry before this hook. Probe with the
; same loader as the application, even on /UPDATE and stale pv registrations.
; Keep the supported offlineInstaller mode; no custom installer template.
!macro NSIS_HOOK_PREINSTALL
  !if "${INSTALLWEBVIEW2MODE}" != "offlineInstaller"
    !error "Netrix runtime recovery requires offlineInstaller"
  !endif
  InitPluginsDir
  File "/oname=$PLUGINSDIR\netrix-runtime-probe.exe" "${MAINBINARYSRCPATH}"
  nsExec::ExecToStack /TIMEOUT=15000 '"$PLUGINSDIR\netrix-runtime-probe.exe" --check-webview2'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 == 10
    DetailPrint "WebView2 is unavailable. Running the bundled Microsoft installer."
    File "/oname=$PLUGINSDIR\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
    ClearErrors
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebView2RuntimeInstaller.exe" /silent /install' $2
    ${If} ${Errors}
      SetErrorLevel 1
      Abort "Could not start the Microsoft WebView2 installer. Netrix installation stopped."
    ${EndIf}
    DetailPrint "Microsoft WebView2 installer exit code: $2"
    ; Always verify discovery again, including an installer's nonzero exit.
    ; A successful installer exit alone is not proof of a usable runtime.
    nsExec::ExecToStack /TIMEOUT=15000 '"$PLUGINSDIR\netrix-runtime-probe.exe" --check-webview2'
    Pop $0
    Pop $1
    DetailPrint "$1"
  ${EndIf}
  ${If} $0 != 0
    SetErrorLevel 1
    Abort "WebView2 is still unavailable (probe: $0). Install or repair the Microsoft Evergreen WebView2 Runtime x64, then run Netrix Setup again. Existing Netrix data is preserved."
  ${EndIf}
!macroend
