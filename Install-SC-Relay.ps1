param(
    [ValidateSet('Chrome', 'Edge', 'None')]
    [string]$Browser = 'Chrome',
    [ValidateRange(1, 65535)]
    [int]$BridgePort = 9696,
    [switch]$WithLoginSync
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Start-SC-Event-Bridge.ps1') -Port $BridgePort
if ($WithLoginSync) { & (Join-Path $PSScriptRoot 'login-sync-local\install.ps1') -Browser None }

$extensionPath = Join-Path $PSScriptRoot 'laplace-sc-replay'
Write-Host "Load or reload this unpacked extension: $extensionPath"
if ($Browser -ne 'None') {
    try {
        if ($Browser -eq 'Edge') { Start-Process 'msedge.exe' 'edge://extensions' }
        else { Start-Process 'chrome.exe' 'chrome://extensions' }
    } catch {
        Write-Host 'Open the Extensions page in your browser to load or reload the extension.'
    }
}
