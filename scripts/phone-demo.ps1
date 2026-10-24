<#
.SYNOPSIS
  Put Pythia on a real phone over HTTPS: production build, `vite preview` on
  :5175 (which proxies /api to the local API on :8001) and a free HTTPS tunnel.

.DESCRIPTION
  1. Starts the API on :8001 in its own window unless one already answers.
     The tunnel URL is public, so every role gets a fresh random password for
     this run (PYTHIA_PW_<ROLE>; a non-default value already set in this shell
     is kept), and the script refuses to open the tunnel while the API on :8001
     accepts a published <role>-demo-pass login.
  2. Builds the web app with VITE_API_URL=/api, so the phone calls the API on
     the tunnel's own origin through the preview proxy (no CORS entry needed).
  3. Runs `vite preview --port 5175` in its own window. vite.config.js only
     accepts the *.trycloudflare.com and *.loca.lt tunnel hosts
     (PYTHIA_TUNNEL_HOSTS adds more).
  4. Opens a Cloudflare quick tunnel (`cloudflared tunnel --url`, no account).
     Without cloudflared it prints the install hint and falls back to
     `npx localtunnel` (its first page asks for the tunnel password: the
     laptop's public IP, shown at https://loca.lt/mytunnelpassword).

  On the phone open the printed https URL:
    /driver  driver app + AR navigation (sign in: driver / printed password)
    /xr      WebXR tabletop twin (no sign-in)
  For a stop the phone can complete, open /fleet (dispatcher / printed
  password), create an SPJ with "DEMO stop at my location" and activate it.
  Ctrl+C stops the tunnel; close the other windows to stop preview and the API.
  For everyday development use scripts\dev.ps1 instead.

  -Tailscale serves the preview with `tailscale serve` instead: HTTPS on this
  machine's MagicDNS name (https://<machine>.<tailnet>.ts.net), reachable only
  from devices in your tailnet. The tailnet needs HTTPS certificates enabled.

.EXAMPLE
  .\scripts\phone-demo.ps1              # build, preview, tunnel
  .\scripts\phone-demo.ps1 -SkipBuild   # reuse the existing apps\web\dist
  .\scripts\phone-demo.ps1 -Tailscale   # private HTTPS inside your tailnet
#>
param(
    [switch]$SkipBuild,
    [switch]$Tailscale
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$api = Join-Path $root "apps\api"
$web = Join-Path $root "apps\web"
$previewUrl = "http://localhost:5175"
$apiUrl = "http://127.0.0.1:8001/api"
# Every role in apps/api/app/core/auth.py ROLES.
$roles = @("executive", "dispatcher", "supervisor", "driver", "auditor", "administrator")

foreach ($tool in "python", "npm") {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is not on PATH. Install Python 3.12+ and Node.js 20+ first."
    }
}

function New-DemoPassword {
    $bytes = New-Object byte[] 12
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Start-PythiaWindow($title, $directory, $command) {
    Start-Process powershell -WorkingDirectory $directory -ArgumentList @(
        "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle = '$title'; $command")
}

function Test-Url($url) {
    try {
        Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 3 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Wait-Url($url, $minutes, $what) {
    $deadline = (Get-Date).AddMinutes($minutes)
    while ((Get-Date) -lt $deadline) {
        if (Test-Url $url) { return }
        Start-Sleep -Seconds 3
    }
    throw "$what did not answer at $url within $minutes minutes - check its window."
}

function Test-DefaultLogin($role) {
    $body = @{ username = $role; password = "$role-demo-pass" } | ConvertTo-Json
    try {
        Invoke-RestMethod "$apiUrl/auth/login" -Method Post -ContentType "application/json" `
            -Body $body -TimeoutSec 5 | Out-Null
        return $true
    } catch {
        return $false
    }
}

# Fresh random password per role for this run. Child windows inherit this
# process's environment, so the API started below uses them; the finally block
# removes the ones generated here from the calling shell again.
$generated = @()
foreach ($role in $roles) {
    $name = "PYTHIA_PW_$($role.ToUpper())"
    $current = [Environment]::GetEnvironmentVariable($name, "Process")
    if (-not $current -or $current -eq "$role-demo-pass") {
        [Environment]::SetEnvironmentVariable($name, (New-DemoPassword), "Process")
        $generated += $name
    }
}

try {
    $startedApi = $false
    if (-not (Test-Url "$apiUrl/health")) {
        Start-PythiaWindow "Pythia API :8001" $api `
            "`$env:PYTHIA_AI_ENGINE = 'on'; `$env:PYTHONIOENCODING = 'utf-8'; python -m uvicorn app.main:app --host 127.0.0.1 --port 8001"
        $startedApi = $true
    }

    if (-not $SkipBuild) {
        $env:VITE_API_URL = "/api"
        try {
            npm --prefix $web run build
            if ($LASTEXITCODE -ne 0) { throw "web build failed" }
        } finally {
            Remove-Item Env:VITE_API_URL -ErrorAction SilentlyContinue
        }
    }

    $tailnetHost = $null
    if ($Tailscale) {
        if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
            throw "tailscale is not on PATH. Install Tailscale and sign in, or run without -Tailscale."
        }
        $tailnetHost = ((tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd(".")
        # vite.config.js accepts extra preview hosts through PYTHIA_TUNNEL_HOSTS.
        $env:PYTHIA_TUNNEL_HOSTS = (@($env:PYTHIA_TUNNEL_HOSTS, $tailnetHost) | Where-Object { $_ }) -join ","
    }

    Start-PythiaWindow "Pythia preview :5175" $web "npm run preview -- --port 5175 --strictPort"

    Write-Host "Waiting for the API (the first start loads 42 forecast models, ~1-2 min)..."
    Wait-Url "$apiUrl/health" 4 "The API"
    Wait-Url $previewUrl 1 "vite preview"

    # The tunnel puts /api on the internet: never while a published password works.
    foreach ($role in $roles) {
        if (Test-DefaultLogin $role) {
            $how = if ($startedApi) {
                "This script started that API with random passwords; check that nothing " +
                "overrides PYTHIA_PW_$($role.ToUpper()) and rerun."
            } else {
                "That API was already running before this script started. Close its window " +
                "(or stop the uvicorn process on port 8001) and rerun: the script then starts " +
                "the API itself with fresh random passwords."
            }
            throw ("REFUSING TO OPEN THE TUNNEL: the API on :8001 accepts the published password " +
                "'$role-demo-pass' for '$role', and the tunnel URL is public. $how")
        }
    }

    Write-Host ""
    Write-Host "==================================================================" -ForegroundColor Yellow
    if ($Tailscale) {
        Write-Host " The https URL below reaches this API from every device in your" -ForegroundColor Yellow
        Write-Host " tailnet. Ctrl+C ends it." -ForegroundColor Yellow
    } else {
        Write-Host " WARNING: the https URL printed below is PUBLIC. Anyone who has it" -ForegroundColor Yellow
        Write-Host " reaches this API. Share it only with the demo team; Ctrl+C ends it." -ForegroundColor Yellow
    }
    Write-Host "==================================================================" -ForegroundColor Yellow
    if ($startedApi) {
        Write-Host " Sign-in for this run only (username / password):"
        foreach ($role in $roles) {
            $password = [Environment]::GetEnvironmentVariable("PYTHIA_PW_$($role.ToUpper())", "Process")
            Write-Host ("   {0,-14} {1}" -f $role, $password)
        }
    } else {
        Write-Host " The API on :8001 was already running: sign in with the PYTHIA_PW_*"
        Write-Host " passwords it was started with (it refuses the published defaults)."
    }
    Write-Host "==================================================================" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "On the phone open the https URL printed below, then:"
    Write-Host "  /driver  driver app + AR (sign in as driver)"
    Write-Host "  /xr      WebXR tabletop twin (no sign-in)"
    Write-Host "  /fleet   sign in as dispatcher: 'DEMO stop at my location'"
    Write-Host ""

    if ($Tailscale) {
        Write-Host "Tailnet URL (devices signed in to your tailnet only): https://$tailnetHost/" -ForegroundColor Green
        try {
            tailscale serve --https=443 $previewUrl
        } finally {
            tailscale serve reset
        }
    } elseif (Get-Command cloudflared -ErrorAction SilentlyContinue) {
        cloudflared tunnel --url $previewUrl
    } else {
        Write-Warning ("cloudflared not found. Install it for a stable quick tunnel: " +
            "winget install --id Cloudflare.cloudflared  (then rerun with -SkipBuild).")
        Write-Host "Falling back to localtunnel; its first page asks for the tunnel password,"
        Write-Host "which is this machine's public IP (see https://loca.lt/mytunnelpassword)."
        npx --yes localtunnel --port 5175
    }
} finally {
    foreach ($name in $generated) {
        [Environment]::SetEnvironmentVariable($name, $null, "Process")
    }
}
