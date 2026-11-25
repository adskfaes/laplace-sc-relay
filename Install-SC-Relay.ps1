param(
    [ValidateSet('Chrome', 'Edge', 'None')]
    [string]$Browser = 'Chrome',
    [ValidateRange(1, 65535)]
    [int]$BridgePort = 9696
)

$ErrorActionPreference = 'Stop'

function Get-UnpackedExtensionId([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if ($absolute -match '^[a-z]:') {
        $absolute = $absolute.Substring(0, 1).ToUpperInvariant() + $absolute.Substring(1)
    }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha256.ComputeHash([Text.Encoding]::Unicode.GetBytes($absolute)) }
    finally { $sha256.Dispose() }
    $hex = [BitConverter]::ToString($hash, 0, 16).Replace('-', '').ToLowerInvariant()
    return -join ($hex.ToCharArray() | ForEach-Object { 'abcdefghijklmnop'[[Convert]::ToInt32([string]$_, 16)] })
}

& (Join-Path $PSScriptRoot 'Start-SC-Event-Bridge.ps1') -Port $BridgePort

$extensionPath = Join-Path $PSScriptRoot 'laplace-sc-relay'
$extensionIds = @(Get-UnpackedExtensionId $extensionPath)
$legacyPath = Join-Path $PSScriptRoot 'laplace-sc-replay'
$legacy = Get-Item -LiteralPath $legacyPath -ErrorAction SilentlyContinue
if ($legacy.LinkType -eq 'Junction' -and $legacy.Target -eq $extensionPath) {
    $extensionIds += Get-UnpackedExtensionId $legacyPath
}

$launcherDir = Join-Path $env:LOCALAPPDATA "LaplaceScEventBridge\launchers\$($extensionIds[0])"
New-Item -Path $launcherDir -ItemType Directory -Force | Out-Null
$launcher = Join-Path $launcherDir 'SC-Bridge-Native-Host.exe'
$source = Join-Path $PSScriptRoot 'SC-Bridge-Native-Host.cs'
$compiler = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
$staged = Join-Path $launcherDir ("launcher-" + [Guid]::NewGuid().ToString('N') + '.exe')
& $compiler /nologo /target:exe "/out:$staged" $source
if ($LASTEXITCODE -ne 0) { throw 'Could not build the Event Bridge launcher.' }
Move-Item -LiteralPath $staged -Destination $launcher -Force
[IO.File]::WriteAllLines((Join-Path $launcherDir 'bridge-launcher.txt'), @(
    [string]$BridgePort, (Join-Path $PSScriptRoot 'Start-SC-Event-Bridge.ps1')
))

$registryPaths = @()
if ($Browser -ne 'Edge') { $registryPaths += 'Software\Google\Chrome\NativeMessagingHosts' }
if ($Browser -ne 'Chrome') { $registryPaths += 'Software\Microsoft\Edge\NativeMessagingHosts' }
foreach ($extensionId in $extensionIds) {
    $hostName = "com.laplace_sc_relay.$extensionId"
    $manifestPath = Join-Path $launcherDir "$hostName.json"
    $manifest = @{
        name = $hostName
        description = 'LAPLACE SC Relay Event Bridge launcher'
        path = $launcher
        type = 'stdio'
        allowed_origins = @("chrome-extension://$extensionId/")
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($manifestPath, $manifest)
    foreach ($registryPath in $registryPaths) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("$registryPath\$hostName")
        try { $key.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) }
        finally { $key.Dispose() }
    }
}

Write-Host 'The extension settings can now start the local Event Bridge service.'
Write-Host "Load or reload this unpacked extension: $extensionPath"
if ($Browser -ne 'None') {
    try {
        if ($Browser -eq 'Edge') { Start-Process 'msedge.exe' 'edge://extensions' }
        else { Start-Process 'chrome.exe' 'chrome://extensions' }
    } catch {
        Write-Host 'Open the Extensions page in your browser to load or reload the extension.'
    }
}
