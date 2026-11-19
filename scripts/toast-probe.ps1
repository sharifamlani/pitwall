<#
.SYNOPSIS
  Phase 5 smokes S3-S6: show one Windows pop-up under Pitwall's sender, or print
  the three settings that hide pop-ups.

.DESCRIPTION
  S3 (sender):  powershell -NoProfile -File scripts/toast-probe.ps1 -Register -Title "uj-lab-a needs you"
  S3 (click):   ... -Register -Launch "cursor://sharifamlani.pitwall/open?probe=1"
  S4 (route):   ... -Launch "cursor://sharifamlani.pitwall/open?probe=1"   (needs the T3 build's URI handler)
  S5 (sound):   ... -Sound on    then    ... -Sound off
  S6 (state):   ... -State
  XML only:     ... -XmlOnly -Sound on   (prints and parses the XML, shows nothing)
  Undo -Register: ... -Unregister   (or: reg delete HKCU\Software\Classes\AppUserModelId\sharifamlani.pitwall /f)

  -Register writes ONE per-user key (no admin), the same one Pitwall writes
  (Q46 = A): HKCU\Software\Classes\AppUserModelId\sharifamlani.pitwall with
  DisplayName "Pitwall" and IconUri = resources/icons/pitwall.png.

  The toast XML is built the same way as src/core/notify/toastXml.ts and is
  echoed, so S5 can check the <audio> element. Nothing is read from
  ~/.claude, and the script changes no Windows notification setting.
#>
param(
  [switch]$Register,
  [switch]$Unregister,
  [switch]$State,
  [switch]$XmlOnly,
  [ValidateSet('on', 'off')][string]$Sound = 'off',
  [string]$Launch = 'cursor://sharifamlani.pitwall/open?probe=1',
  [string]$Title = 'uj-lab-a needs you',
  [string]$Body = 'Probe chat: Claude is waiting for you.',
  [string]$Attribution = 'permission prompt',
  [string]$Tag = 'probe-needs',
  [string]$Aumid = 'sharifamlani.pitwall'
)

$ErrorActionPreference = 'Stop'
$key = "HKCU:\Software\Classes\AppUserModelId\$Aumid"
$icon = (Resolve-Path (Join-Path $PSScriptRoot '..\resources\icons\pitwall.png')).Path

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] > $null

function Get-NotifierSetting {
  # The getter, not the property: PowerShell turns a throwing property into $null.
  # 0x80070490 (element not found) = Windows doesn't know this AUMID yet.
  try {
    return [string][Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid).get_Setting()
  } catch {
    $inner = $_.Exception.InnerException
    $code = if ($inner) { $inner.HResult } else { $_.Exception.HResult }
    return ('unknown (0x{0:X8})' -f $code)
  }
}

if ($Unregister) {
  Remove-Item -LiteralPath $key -Recurse -ErrorAction SilentlyContinue
  "unregistered $key"
  exit 0
}

if ($State) {
  # Toasts for all apps: PushNotifications\ToastEnabled (missing = on).
  $toasts = 'unknown'
  try {
    $value = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' -ErrorAction Stop).ToastEnabled
    $toasts = if ($null -eq $value -or $value -ne 0) { 'on' } else { 'off' }
  } catch {
    $toasts = 'on'
  }
  # Pitwall's own switch: ToastNotifier.Setting for its AUMID.
  $setting = Get-NotifierSetting
  $app = if ($setting -eq 'Enabled') { 'on' } elseif ($setting -like 'unknown*') { 'unknown' } else { 'off' }
  # Focus assist: the shell's quiet-hours WNF state (0 off, 1 priority only, 2 alarms only).
  $focus = 'unknown'
  try {
    Add-Type -Namespace PitwallProbe -Name Wnf -MemberDefinition @'
[DllImport("ntdll.dll")]
public static extern int NtQueryWnfStateData(ref ulong stateName, IntPtr typeId, IntPtr explicitScope, out uint changeStamp, out int buffer, ref uint bufferSize);
'@
    $name = [UInt64]'0x0D83063EA3BF1C75'
    $stamp = [UInt32]0
    $buffer = 0
    $size = [UInt32]4
    $status = [PitwallProbe.Wnf]::NtQueryWnfStateData([ref]$name, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$stamp, [ref]$buffer, [ref]$size)
    if ($status -eq 0) {
      $focus = switch ($buffer) { 0 { 'off' } 1 { 'priority' } 2 { 'alarms' } default { 'unknown' } }
    }
  } catch {
    $focus = 'unknown'
  }
  "toasts=$toasts app=$app focus=$focus"
  "ToastNotifier.Setting=$setting"
  exit 0
}

if ($Register) {
  if (-not (Test-Path -LiteralPath $key)) {
    New-Item -Path $key -Force > $null
  }
  New-ItemProperty -LiteralPath $key -Name DisplayName -Value 'Pitwall' -PropertyType String -Force > $null
  New-ItemProperty -LiteralPath $key -Name IconUri -Value $icon -PropertyType String -Force > $null
  "registered $key (DisplayName=Pitwall, IconUri=resources\icons\pitwall.png)"
}

function Escape([string]$text) { [System.Security.SecurityElement]::Escape($text) }

$uri = Escape $Launch
$audio = if ($Sound -eq 'on') { '<audio src="ms-winsoundevent:Notification.Default"/>' } else { '<audio silent="true"/>' }
$attributionXml = if ($Attribution) { "<text placement=""attribution"">$(Escape $Attribution)</text>" } else { '' }
$xml = "<toast launch=""$uri"" activationType=""protocol""><visual><binding template=""ToastGeneric""><text>$(Escape $Title)</text><text>$(Escape $Body)</text>$attributionXml</binding></visual><actions><action content=""Open chat"" activationType=""protocol"" arguments=""$uri""/><action content=""Dismiss"" activationType=""system"" arguments=""dismiss""/></actions>$audio</toast>"

"xml: $xml"
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
if ($XmlOnly) {
  'xml parsed; nothing shown'
  exit 0
}
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
$toast.Tag = $Tag
$toast.Group = 'pitwall'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid).Show($toast)
"shown tag=$Tag sound=$Sound launch=$Launch"
"ToastNotifier.Setting=$(Get-NotifierSetting)"
