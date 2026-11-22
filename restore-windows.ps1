# Rescue: if Nullwave crashed, this brings back the Windows taskbar and the original look.
# Run: right click -> Run with PowerShell (or: powershell -ExecutionPolicy Bypass -File restore-windows.ps1)
Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$PSScriptRoot\shell\*" } | Stop-Process -Force
Add-Type -Namespace NWR -Name N -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int l, t, r, b; }
[StructLayout(LayoutKind.Sequential)] public struct APPBARDATA { public uint cbSize; public IntPtr hWnd; public uint cb; public uint edge; public RECT rc; public IntPtr lParam; }
[DllImport("shell32.dll")] public static extern UIntPtr SHAppBarMessage(uint msg, ref APPBARDATA d);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
'@
$stateFile = Join-Path $env:APPDATA 'Nullwave\taskbar-state.json'
$state = 0
if (Test-Path $stateFile) { $state = (Get-Content $stateFile -Raw | ConvertFrom-Json).state; Remove-Item $stateFile -Force }
$tray = [NWR.N]::FindWindow('Shell_TrayWnd', $null)
$d = New-Object NWR.N+APPBARDATA
$d.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($d); $d.hWnd = $tray; $d.lParam = [IntPtr]$state
[void][NWR.N]::SHAppBarMessage(10, [ref]$d)
[void][NWR.N]::ShowWindow($tray, 5)
$w = [IntPtr]::Zero
while (($w = [NWR.N]::FindWindowEx([IntPtr]::Zero, $w, 'Shell_SecondaryTrayWnd', $null)) -ne [IntPtr]::Zero) { [void][NWR.N]::ShowWindow($w, 5) }
& (Join-Path $PSScriptRoot 'theme\theme.ps1') restore
'Done: the Windows taskbar and look are back.'
