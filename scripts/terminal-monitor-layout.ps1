# Read-only physical monitor bounds for the dedicated terminal-window smoke.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TerminalSmokeDpi {
    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$terminalSmokePreviousDpi = [TerminalSmokeDpi]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($terminalSmokePreviousDpi -eq [IntPtr]::Zero) {
    throw 'Could not establish physical monitor coordinates for the smoke test'
}
try {
    $terminalSmokeMonitors = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
        [pscustomobject]@{ x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height; primary=$_.Primary }
    })
    ConvertTo-Json -InputObject $terminalSmokeMonitors -Compress
} finally {
    [void][TerminalSmokeDpi]::SetThreadDpiAwarenessContext($terminalSmokePreviousDpi)
}
