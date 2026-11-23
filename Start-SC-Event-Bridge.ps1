param([ValidateRange(1, 65535)][int]$Port = 9696)
$ErrorActionPreference = 'Stop'
$bridgeDir = Join-Path $env:LOCALAPPDATA 'LaplaceScEventBridge'
$exe = Join-Path $bridgeDir 'leb-server-windows-x64.exe'
$passwordFile = Join-Path $bridgeDir 'password.txt'
$extensionConfig = Join-Path $PSScriptRoot 'laplace-sc-relay\bridge-instance.json'
$sha256 = 'F312BC92FF9988A6753A2D53745BAEA8AF9DCE9C17F4F94B105892AB98594AB1'
$download = 'https://github.com/laplace-live/event-bridge/releases/download/%40laplace.live%2Fevent-bridge-server%400.3.21/leb-server-windows-x64.exe'

New-Item -ItemType Directory -Force -Path $bridgeDir | Out-Null
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    $process = Get-Process -Id ($listening | Select-Object -First 1).OwningProcess
    if ($process.Path -ne $exe -or -not (Test-Path -LiteralPath $passwordFile)) {
        throw "Port $Port is in use. Choose another port with -Port."
    }
} else {
    if (-not (Test-Path -LiteralPath $exe)) {
        $staged = "$exe.download"
        Invoke-WebRequest -UseBasicParsing -Uri $download -OutFile $staged
        if ((Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash -ne $sha256) {
            throw 'The downloaded Event Bridge binary failed SHA-256 verification.'
        }
        Move-Item -LiteralPath $staged -Destination $exe
    }
    if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $sha256) {
        throw "Event Bridge binary failed SHA-256 verification. Check $exe."
    }
    if (-not (Test-Path -LiteralPath $passwordFile)) {
        [IO.File]::WriteAllText($passwordFile, [Guid]::NewGuid().ToString('N'))
    }
    $bridgePassword = [IO.File]::ReadAllText($passwordFile).Trim()
    if ($bridgePassword -notmatch '^[0-9a-f]{32}$') { throw "Invalid Event Bridge password file: $passwordFile" }
    $process = Start-Process -FilePath $exe -ArgumentList @('--host', '127.0.0.1', '--port', $Port, '--auth', $bridgePassword) `
        -WorkingDirectory $bridgeDir -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(8)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw "Event Bridge stopped with exit code $($process.ExitCode)." }
        $ready = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -OwningProcess $process.Id -ErrorAction SilentlyContinue
        if (-not $ready) { Start-Sleep -Milliseconds 200 }
    } until ($ready -or (Get-Date) -ge $deadline)
    if (-not $ready) { throw 'Event Bridge did not begin listening.' }
}

$bridgePassword = [IO.File]::ReadAllText($passwordFile).Trim()
if ($bridgePassword -notmatch '^[0-9a-f]{32}$') { throw "Invalid Event Bridge password file: $passwordFile" }
[IO.File]::WriteAllText($extensionConfig, (@{ port = $Port; token = $bridgePassword } | ConvertTo-Json -Compress))
Write-Host "Event Bridge is listening on 127.0.0.1:$Port (PID $($process.Id))."
Write-Host 'The extension will use this bridge automatically. Copy the password from its settings into LAPLACE Chat once.'
