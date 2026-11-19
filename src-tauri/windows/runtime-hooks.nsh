; Tauri CLI 2.1 checks only the registry before this hook. Probe with the
; same loader as the application, even on /UPDATE and stale pv registrations.
; Both installers use this hook and install into the same application directory.
!ifndef NETRIX_RUNTIME_PROBE_TIMEOUT
  !define NETRIX_RUNTIME_PROBE_TIMEOUT 15000
!endif

Var NetrixRuntimeFailure

!macro NETRIX_ABORT_RUNTIME MESSAGE
  StrCpy $NetrixRuntimeFailure "${MESSAGE}"
  SetErrorLevel 1
  Abort "$NetrixRuntimeFailure"
!macroend

; A process-launch error is not evidence that WebView2 is missing. In particular,
; Smart App Control can block an unsigned probe or an installer plugin.
!macro NETRIX_VALIDATE_PROBE_RESULT
  ${If} $0 == "error"
    DetailPrint "Windows could not run the Netrix WebView2 check."
    DetailPrint "Check Windows security notifications for a blocked file, including Smart App Control."
    DetailPrint "A trusted signed Netrix build may be required. Reinstalling WebView2 does not resolve a blocked Netrix component."
    !insertmacro NETRIX_ABORT_RUNTIME "Could not run the WebView2 check (probe: error). Check Windows security notifications. WebView2 availability was not determined."
  ${ElseIf} $0 == "timeout"
    !insertmacro NETRIX_ABORT_RUNTIME "The WebView2 check timed out. Netrix installation stopped; WebView2 availability was not determined."
  ${ElseIf} $0 != 0
  ${AndIf} $0 != 10
    !insertmacro NETRIX_ABORT_RUNTIME "The WebView2 check exited unexpectedly (code: $0). Netrix installation stopped; WebView2 availability was not determined."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  File "/oname=$PLUGINSDIR\netrix-runtime-probe.exe" "${MAINBINARYSRCPATH}"
  StrCpy $NetrixRuntimeFailure ""
  nsExec::ExecToStack /TIMEOUT=${NETRIX_RUNTIME_PROBE_TIMEOUT} '"$PLUGINSDIR\netrix-runtime-probe.exe" --check-webview2'
  Pop $0
  Pop $1
  DetailPrint "$1"
  !insertmacro NETRIX_VALIDATE_PROBE_RESULT
  ${If} $0 == 10
    !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
      DetailPrint "Installing WebView2 from the bundled offline runtime."
      File "/oname=$PLUGINSDIR\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
    !else if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
      DetailPrint "Downloading WebView2 with the Microsoft bootstrapper. For disconnected PCs, use Netrix Offline Full."
      File "/oname=$PLUGINSDIR\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
    !else
      !error "Unsupported WebView2 installer mode"
    !endif
    ClearErrors
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebView2RuntimeInstaller.exe" /silent /install' $2
    ${If} ${Errors}
      !insertmacro NETRIX_ABORT_RUNTIME "Could not start the Microsoft WebView2 installer. Check Windows security notifications. Netrix installation stopped."
    ${EndIf}
    DetailPrint "Microsoft WebView2 installer exit code: $2"
    ; Always verify discovery again, including an installer's nonzero exit.
    ; A successful installer exit alone is not proof of a usable runtime.
    nsExec::ExecToStack /TIMEOUT=${NETRIX_RUNTIME_PROBE_TIMEOUT} '"$PLUGINSDIR\netrix-runtime-probe.exe" --check-webview2'
    Pop $0
    Pop $1
    DetailPrint "$1"
    !insertmacro NETRIX_VALIDATE_PROBE_RESULT
  ${EndIf}
  ${If} $0 != 0
    !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
      !insertmacro NETRIX_ABORT_RUNTIME "WebView2 is still unavailable (probe: $0; Microsoft installer: $2). Check your connection or run the Netrix Offline Full installer."
    !else
      !insertmacro NETRIX_ABORT_RUNTIME "WebView2 is still unavailable (probe: $0; Microsoft installer: $2). Install or repair Microsoft Evergreen WebView2 Runtime x64, then run Netrix Setup again. Existing Netrix data is preserved."
    !endif
  ${EndIf}
!macroend
