# Nullwave: switches the Windows look on (apply) and back to exactly what it was (restore).
# Writes the per-user settings (HKCU) AND the same values into the current theme file, so when
# Windows re-applies its current theme the look stays Nullwave. Before the first change it backs up
# the theme file and every registry value it touches (backup\ + theme-backup.json); restore puts
# all of it back. (Applying a .theme via the shell is blocked here: "Přístup odepřen".)
param([ValidateSet('apply', 'restore', 'status')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$bk = Join-Path $here 'backup'
$backupFile = Join-Path $here 'theme-backup.json'
$cur = Join-Path $here 'cursors'
$wall = Join-Path $here 'nullwave-wallpaper.png'
$nwTheme = Join-Path $here 'Nullwave.theme'
$fragDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows Terminal\Fragments\Nullwave'
$ThemesKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes'

function I32([uint32]$u) { [BitConverter]::ToInt32([BitConverter]::GetBytes($u), 0) }
function Rgba([string]$hex) { $h = $hex.TrimStart('#'); [byte[]]@([Convert]::ToByte($h.Substring(0,2),16), [Convert]::ToByte($h.Substring(2,2),16), [Convert]::ToByte($h.Substring(4,2),16), 0xFF) }
function Abgr([string]$hex) { $h = $hex.TrimStart('#'); I32 ([Convert]::ToUInt32('FF' + $h.Substring(4,2) + $h.Substring(2,2) + $h.Substring(0,2), 16)) }
$paletteBytes = [byte[]](@('#E5D4FF', '#CDAAFF', '#B47CFF', '#9B4DFF', '#6B2FD0', '#3E1A8A', '#1F0E4A', '#22E6D4') | ForEach-Object { Rgba $_ } | ForEach-Object { $_ })

$P = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$D = 'HKCU:\Software\Microsoft\Windows\DWM'
$A = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Accent'
$C = 'HKCU:\Control Panel\Cursors'
$K = 'HKCU:\Control Panel\Desktop'
function Argb([string]$hex, [string]$a = 'C4') { I32 ([Convert]::ToUInt32($a + $hex.TrimStart('#'), 16)) }
$extras = @(
  @{ p = $P; n = 'AppsUseLightTheme';    t = 'DWord';  v = 0 },
  @{ p = $P; n = 'SystemUsesLightTheme'; t = 'DWord';  v = 0 },
  @{ p = $D; n = 'AccentColor';          t = 'DWord';  v = (Abgr '#9B4DFF') },
  @{ p = $D; n = 'ColorizationColor';    t = 'DWord';  v = (Argb '#9B4DFF') },
  @{ p = $D; n = 'ColorizationAfterglow';t = 'DWord';  v = (Argb '#9B4DFF') },
  @{ p = $K; n = 'AutoColorization';     t = 'String'; v = '0' },
  @{ p = $K; n = 'Wallpaper';            t = 'String'; v = $wall },
  @{ p = $K; n = 'WallpaperStyle';       t = 'String'; v = '10' },
  @{ p = $C; n = '(default)';            t = 'String'; v = 'Nullwave' },
  @{ p = $C; n = 'Arrow';                t = 'ExpandString'; v = "$cur\nullwave-arrow.cur" },
  @{ p = $C; n = 'Hand';                 t = 'ExpandString'; v = "$cur\nullwave-link.cur" },
  @{ p = $C; n = 'IBeam';                t = 'ExpandString'; v = "$cur\nullwave-beam.cur" },
  @{ p = $P; n = 'ColorPrevalence';    t = 'DWord';  v = 1 },
  @{ p = $P; n = 'EnableTransparency'; t = 'DWord';  v = 1 },
  @{ p = $D; n = 'ColorPrevalence';    t = 'DWord';  v = 1 },
  @{ p = $A; n = 'AccentPalette';      t = 'Binary'; v = $paletteBytes },
  @{ p = $A; n = 'AccentColorMenu';    t = 'DWord';  v = (Abgr '#9B4DFF') },
  @{ p = $A; n = 'StartColorMenu';     t = 'DWord';  v = (Abgr '#3E1A8A') }
)

Add-Type -Namespace NW -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool SystemParametersInfo(uint a, uint b, string c, uint d);
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);
'@
function Broadcast([string]$wallpaper) {
  # flag 1 = save only, no blocking broadcast (a broadcast can deadlock with the wallpaper windows under the icons)
  [void][NW.Native]::SystemParametersInfo(0x57, 0, $null, 1)                                   # cursors
  if ($wallpaper) { [void][NW.Native]::SystemParametersInfo(0x14, 0, $wallpaper, 1) }          # wallpaper
  $r = [UIntPtr]::Zero
  foreach ($area in 'ImmersiveColorSet', 'WindowsThemeElement') { [void][NW.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, $area, 2, 1000, [ref]$r) }
}
function Read-Value($s) {
  if (-not (Test-Path $s.p)) { return @{ exists = $false } }
  $item = Get-Item $s.p; $n = if ($s.n -eq '(default)') { '' } else { $s.n }
  $val = $item.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
  if ($null -eq $val) { return @{ exists = $false } }
  $kind = "$($item.GetValueKind($n))"
  if ($val -is [byte[]]) { return @{ exists = $true; value = [Convert]::ToBase64String($val); kind = $kind; bin = $true } }
  @{ exists = $true; value = $val; kind = $kind; bin = $false }
}
function Write-Value($p, $n, $t, $v) {
  if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }
  if ($n -eq '(default)') { Set-Item -Path $p -Value $v; return }
  New-ItemProperty -Path $p -Name $n -PropertyType $t -Value $v -Force | Out-Null
}
# Apply a .theme the way double-clicking it does, then close the Settings window it opens.
function Apply-ThemeFile([string]$file) {
  $before = @(Get-Process SystemSettings -ErrorAction SilentlyContinue).Id
  Start-Process -FilePath $file
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if ((Get-ItemProperty $ThemesKey).CurrentTheme -eq $file) { break }
  }
  Start-Sleep -Milliseconds 800
  Get-Process SystemSettings -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
}
# Copy of the current theme with Nullwave cursors, wallpaper, colours and dark mode.
function Build-Theme([string]$src) {
  $txt = if ($src -and (Test-Path $src)) { Get-Content $src -Raw } else { "[Theme]`r`n[Control Panel\Cursors]`r`n[Control Panel\Desktop]`r`n[VisualStyles]`r`nPath=%SystemRoot%\resources\themes\Aero\Aero.msstyles`r`nColorStyle=NormalColor`r`nSize=NormalSize`r`n" }
  $set = @{
    'Theme' = @{ DisplayName = 'Nullwave'; ThemeId = '{5B2F7A10-9E4C-4C1B-8E21-6A3D0F9C2B11}' }
    'Control Panel\Cursors' = @{ Arrow = "$cur\nullwave-arrow.cur"; Hand = "$cur\nullwave-link.cur"; IBeam = "$cur\nullwave-beam.cur"; DefaultValue = 'Nullwave' }
    'Control Panel\Desktop' = @{ Wallpaper = $wall; PicturePosition = '10'; MultimonBackgrounds = '0' }
    'VisualStyles' = @{ AutoColorization = '0'; ColorizationColor = '0XC49B4DFF'; SystemMode = 'Dark'; AppMode = 'Dark' }
  }
  $lines = $txt -split "`r?`n"; $out = New-Object System.Collections.Generic.List[string]; $sec = $null; $seen = @{}
  function Flush($sec) { if ($sec -and $set.ContainsKey($sec)) { foreach ($k in $set[$sec].Keys) { if (-not $seen["$sec|$k"]) { $out.Add("$k=$($set[$sec][$k])") } } } }
  foreach ($l in $lines) {
    if ($l -match '^\[(.+)\]\s*$') { Flush $sec; $sec = $Matches[1]; $out.Add($l); continue }
    if ($sec -and $set.ContainsKey($sec) -and $l -match '^([^;=][^=]*)=') {
      $k = $Matches[1].Trim()
      if ($set[$sec].ContainsKey($k)) { $out.Add("$k=$($set[$sec][$k])"); $seen["$sec|$k"] = $true; continue }
      if ($sec -eq 'Theme' -and $k -eq 'DisplayName') { continue }
    }
    $out.Add($l)
  }
  Flush $sec
  foreach ($s in $set.Keys) { if (-not ($lines -match "^\[$([regex]::Escape($s))\]")) { $out.Add("[$s]"); foreach ($k in $set[$s].Keys) { $out.Add("$k=$($set[$s][$k])") } } }
  # drop the localized .A/.W duplicates that would bring back the old name/wallpaper
  $clean = New-Object System.Collections.Generic.List[string]; $skip = $false
  foreach ($l in $out) { if ($l -match '^\[(.+)\]\s*$') { $skip = $Matches[1] -match '\.(A|W)$' }; if (-not $skip) { $clean.Add($l) } }
  [IO.File]::WriteAllText($nwTheme, ($clean -join "`r`n"), [Text.Encoding]::Unicode)
}
function Terminal-Fragment {
  New-Item -ItemType Directory -Force -Path $fragDir | Out-Null
  $frag = @{
    schemes = @(@{ name = 'Nullwave'; background = '#0F0A1E'; foreground = '#C9C6DC'; cursorColor = '#22E6D4'; selectionBackground = '#9B4DFF';
      black = '#181129'; red = '#FF3EA5'; green = '#22E6D4'; yellow = '#FFD166'; blue = '#7A8CFF'; purple = '#9B4DFF'; cyan = '#22E6D4'; white = '#F3EEFA';
      brightBlack = '#66658A'; brightRed = '#FF77C0'; brightGreen = '#7AF2E6'; brightYellow = '#FFE29A'; brightBlue = '#A9B4FF'; brightPurple = '#C29AFF'; brightCyan = '#9AF7EE'; brightWhite = '#FFFFFF' })
    profiles = @(@{ guid = '{6f2b7c1e-4d3a-4e5b-9a7c-1b2d3e4f5a6b}'; name = 'Nullwave'; commandline = 'powershell.exe -NoLogo'; colorScheme = 'Nullwave';
      font = @{ face = 'Cascadia Code'; size = 11 }; opacity = 92; useAcrylic = $true; padding = '14'; cursorShape = 'filledBox' })
  }
  ($frag | ConvertTo-Json -Depth 6) | Set-Content -Encoding UTF8 (Join-Path $fragDir 'nullwave.json')
}

switch ($Action) {
  'status' { @{ active = (Test-Path $backupFile) } | ConvertTo-Json -Compress }
  'apply' {
    $current = (Get-ItemProperty $ThemesKey).CurrentTheme
    if (-not (Test-Path $backupFile)) {
      # first switch: remember the user's theme (as a file copy) and the extra accent values
      New-Item -ItemType Directory -Force -Path $bk | Out-Null
      $prev = Join-Path $bk 'previous.theme'
      if ($current -and (Test-Path $current)) { Copy-Item $current $prev -Force } else { $prev = $null }
      $b = @{ previousTheme = $prev; originalPath = $current; extras = @{} }
      foreach ($s in $extras) { $b.extras["$($s.p)|$($s.n)"] = Read-Value $s }
      ($b | ConvertTo-Json -Depth 5) | Set-Content -Encoding UTF8 $backupFile
      $src = $current
    } else { $src = (Get-Content $backupFile -Raw | ConvertFrom-Json).previousTheme }
    Build-Theme $src
    if ($current -and (Test-Path $current)) { Copy-Item $nwTheme $current -Force }   # Windows re-applying its theme keeps Nullwave
    foreach ($s in $extras) { Write-Value $s.p $s.n $s.t $s.v }
    Terminal-Fragment
    Broadcast $wall
    @{ ok = $true; active = $true; theme = (Get-ItemProperty $ThemesKey).CurrentTheme } | ConvertTo-Json -Compress
  }
  'restore' {
    if (-not (Test-Path $backupFile)) { @{ ok = $true; active = $false; note = 'nothing to restore' } | ConvertTo-Json -Compress; break }
    $b = Get-Content $backupFile -Raw | ConvertFrom-Json
    if ($b.previousTheme -and (Test-Path $b.previousTheme) -and $b.originalPath) { Copy-Item $b.previousTheme $b.originalPath -Force }
    foreach ($s in $extras) {
      $o = $b.extras."$($s.p)|$($s.n)"
      if ($o -and $o.exists) { Write-Value $s.p $s.n $o.kind $(if ($o.bin) { [Convert]::FromBase64String($o.value) } else { $o.value }) }
      elseif ($o -and -not $o.exists -and $s.n -ne '(default)' -and (Test-Path $s.p)) { Remove-ItemProperty -Path $s.p -Name $s.n -ErrorAction SilentlyContinue }   # only if the backup says it did not exist
    }
    Remove-Item -Recurse -Force $fragDir -ErrorAction SilentlyContinue
    $w = $b.extras."$K|Wallpaper"
    Broadcast $(if ($w -and $w.exists) { $w.value } else { '' })
    Remove-Item $backupFile -Force
    @{ ok = $true; active = $false; theme = (Get-ItemProperty $ThemesKey).CurrentTheme } | ConvertTo-Json -Compress
  }
}
