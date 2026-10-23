# Stops CrewBoard (port 3000) and, if running, the development web server (5173).
# The database container keeps running (stop it with: docker compose stop db).
foreach ($port in 3000, 5173) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -in 'CrewBoard API', 'CrewBoard Web' } | Stop-Process -Force
Write-Host 'CrewBoard stopped.'
Start-Sleep 2
