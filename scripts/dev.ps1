<#
.SYNOPSIS
  Run Pythia locally: API on :8001, web app on :5175 and, optionally, the
  WhatsApp gateway on :2785. Each service opens in its own window.

.EXAMPLE
  .\scripts\dev.ps1              # API + web app
  .\scripts\dev.ps1 -WhatsApp    # also the WhatsApp gateway (scan the QR in its window)
  .\scripts\dev.ps1 -Install     # install Python and npm dependencies first

.NOTES
  To demo on a real phone over HTTPS (driver AR, /xr), use scripts\phone-demo.ps1.
#>
param(
    [switch]$WhatsApp,
    [switch]$Install
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$api = Join-Path $root "apps\api"
$web = Join-Path $root "apps\web"
$gateway = Join-Path $root "apps\wa-gateway"

foreach ($tool in "python", "npm") {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is not on PATH. Install Python 3.12+ and Node.js 20+ first."
    }
}

if ($Install) {
    python -m pip install -r (Join-Path $api "requirements.txt")
    npm --prefix $web install
    if ($WhatsApp) { npm --prefix $gateway install }
}

function Start-PythiaWindow($title, $directory, $command) {
    Start-Process powershell -WorkingDirectory $directory -ArgumentList @(
        "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle = '$title'; $command")
}

# The AI engine (auto-reroute, landfill queue predictor) only runs when enabled.
Start-PythiaWindow "Pythia API :8001" $api `
    "`$env:PYTHIA_AI_ENGINE = 'on'; `$env:PYTHONIOENCODING = 'utf-8'; python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload"
Start-PythiaWindow "Pythia web :5175" $web "npm run dev -- --port 5175 --strictPort"
if ($WhatsApp) {
    Start-PythiaWindow "Pythia WhatsApp gateway :2785" $gateway "node server.js"
}

Write-Host "Waiting for the API (the first start loads 42 forecast models, ~1-2 min)..."
$deadline = (Get-Date).AddMinutes(4)
while ((Get-Date) -lt $deadline) {
    try {
        Invoke-RestMethod "http://127.0.0.1:8001/api/health" -TimeoutSec 3 | Out-Null
        Write-Host "Pythia is up: http://localhost:5175"
        Write-Host "Sign in as dispatcher / dispatcher-demo-pass"
        Start-Process "http://localhost:5175"
        exit 0
    } catch {
        Start-Sleep -Seconds 3
    }
}
Write-Warning "The API did not answer within 4 minutes - check the 'Pythia API' window."
exit 1
