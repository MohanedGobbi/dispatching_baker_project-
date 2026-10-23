# Starts CrewBoard: database (Docker), then one hidden process that serves the app on http://127.0.0.1:3000,
# then opens the browser. Builds first when the code is newer than the last build.
# Safe to run twice: anything already running is left alone.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$Host.UI.RawUI.WindowTitle = 'CrewBoard launcher'
$url = 'http://127.0.0.1:3000'

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
function Newest($paths) { (Get-ChildItem $paths -Recurse -File -ErrorAction SilentlyContinue | Measure-Object LastWriteTime -Maximum).Maximum }

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

# 2. The app (API + web on one port)
if (-not (Listening 3000)) {
  $built = @('apps\api\dist\src\main.js', 'apps\web\dist\index.html') | ForEach-Object { Get-Item $_ -ErrorAction SilentlyContinue }
  $source = Newest @('apps\api\src', 'apps\web\src', 'apps\web\public', 'apps\web\index.html')
  if ($built.Count -lt 2 -or ($built | Where-Object { $_.LastWriteTime -lt $source })) {
    Write-Host 'Building (the code changed since the last build)...'
    npm run build | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'The build failed. Run "npm run build" in this folder to see the error.' }
  }
  Push-Location apps\api
  npx prisma migrate deploy | Out-Null
  Pop-Location
  New-Item -ItemType Directory -Force logs | Out-Null
  Start-Process node -ArgumentList 'dist\src\main.js' -WorkingDirectory "$root\apps\api" -WindowStyle Hidden `
    -RedirectStandardOutput "$root\logs\crewboard.log" -RedirectStandardError "$root\logs\crewboard-error.log"
  if (-not (WaitFor 3000 'CrewBoard' 60)) { Fail "CrewBoard did not start. See logs\crewboard-error.log." }
} else { Write-Host 'CrewBoard already running' -ForegroundColor Green }

Start-Process $url
Write-Host "`nCrewBoard is running at $url (sign in as admin)." -ForegroundColor Cyan
Write-Host 'Run stop-crewboard to stop it.'
Start-Sleep 3
