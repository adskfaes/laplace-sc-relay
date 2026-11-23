param(
    [ValidateSet('Chrome', 'Edge', 'None')]
    [string]$Browser = 'Chrome'
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$extensionPath = Join-Path $project 'laplace-sc-replay'
$configPath = Join-Path $extensionPath 'local-instance.json'
$runtime = Join-Path $PSScriptRoot 'node_modules\@oven\bun-windows-x64\bin\bun.exe'
$healthUrl = 'http://127.0.0.1:18188/health'

Push-Location $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath $runtime)) {
        Write-Host 'Installing the local Login Sync runtime...'
        npm.cmd ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $runtime)) {
            throw 'Login Sync runtime installation failed.'
        }
    }

    node.exe config.mjs --initialize
    if ($LASTEXITCODE -ne 0) { throw 'Local Login Sync configuration could not be initialized.' }
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

    function Test-LocalService {
        try {
            $response = Invoke-RestMethod -Uri $healthUrl -Headers @{ 'X-LSC-Install' = $config.requestKey } -TimeoutSec 2 -UseBasicParsing
            return $response.service -eq 'laplace-sc-login-sync'
        } catch {
            return $false
        }
    }

    $ready = Test-LocalService
    if (-not $ready) {
        $process = Start-Process -FilePath $runtime -ArgumentList @('run', 'server.mjs') -WorkingDirectory $PSScriptRoot `
            -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'service.log') `
            -RedirectStandardError (Join-Path $PSScriptRoot 'service-error.log') -PassThru
        for ($attempt = 0; $attempt -lt 24; $attempt++) {
            $ready = Test-LocalService
            if ($ready -or $process.HasExited) { break }
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $ready) { throw 'Local Login Sync did not start. Check login-sync-local\service-error.log and port 18188.' }

    Write-Host 'Local Login Sync is running at 127.0.0.1:18188.'
    Write-Host ('Load or reload the unpacked extension in the browser from ' + $extensionPath)
    if ($Browser -ne 'None') {
        try {
            if ($Browser -eq 'Edge') { Start-Process 'msedge.exe' 'edge://extensions' }
            else { Start-Process 'chrome.exe' 'chrome://extensions' }
        } catch {
            Write-Host 'Open the Extensions page in your browser to load or reload the extension.'
        }
    }
} finally {
    Pop-Location
}
