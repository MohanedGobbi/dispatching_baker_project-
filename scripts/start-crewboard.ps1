# Starts CrewBoard: database (Docker), API (:3000) and web app (:5173), then opens the browser.
# Safe to run twice: anything already running is left alone.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$Host.UI.RawUI.WindowTitle = 'CrewBoard launcher'

function Listening($port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function WaitFor($port, $name, $seconds) {
  Write-Host -NoNewline "Waiting for $name "
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Listening $port) { Write-Host ' ready' -ForegroundColor Green; return $true }
    Start-Sleep 1; Write-Host -NoNewline '.'
  }
  Write-Host ' not answering' -ForegroundColor Red; return $false
}
function Fail($msg) { Write-Host "`n$msg" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }

Write-Host 'CrewBoard' -ForegroundColor Cyan

# 1. Database
if (-not (Listening 5440)) {
  docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Starting Docker Desktop...'
    $dd = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dd) { Start-Process $dd } else { Fail 'Docker is not running and Docker Desktop was not found. Start Docker, then run this again.' }
    for ($i = 0; $i -lt 90; $i++) { docker info *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 2 }
    if ($LASTEXITCODE -ne 0) { Fail 'Docker did not start in time.' }
  }
  docker compose up -d db | Out-Null
  if (-not (WaitFor 5440 'database' 60)) { Fail 'The database did not start (docker compose up -d db).' }
  Start-Sleep 2
} else { Write-Host 'Database already running' -ForegroundColor Green }

# 2. API (applies any new migrations first)
if (-not (Listening 3000)) {
  Push-Location apps\api
  npx prisma migrate deploy | Out-Null
  Pop-Location
  Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle='CrewBoard API'; Set-Location '$root\apps\api'; npm run start:dev"
  if (-not (WaitFor 3000 'API' 90)) { Fail 'The API did not start. Look at the "CrewBoard API" window for the error.' }
} else { Write-Host 'API already running' -ForegroundColor Green }

# 3. Web app
if (-not (Listening 5173)) {
  Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle='CrewBoard Web'; Set-Location '$root'; npm run dev:web"
  if (-not (WaitFor 5173 'web app' 60)) { Fail 'The web app did not start. Look at the "CrewBoard Web" window for the error.' }
} else { Write-Host 'Web app already running' -ForegroundColor Green }

Start-Process 'http://localhost:5173'
Write-Host "`nCrewBoard is running at http://localhost:5173 (logins: see DEMO.md, password demo1234)." -ForegroundColor Cyan
Write-Host 'Close the "CrewBoard API" and "CrewBoard Web" windows, or run stop-crewboard, to stop it.'
Start-Sleep 4
