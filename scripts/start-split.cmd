@echo off
setlocal
cd /d "%~dp0.."

if not exist ".env" (
  node scripts\init-secrets.js
  if errorlevel 1 exit /b 1
)

set "MESH_MODE=split"
set "COMPOSE_PROFILES=split"
set "MEMBER_SIDECAR_URL=http://member-sidecar:5105"
set "BOOK_REPLICA_URL=http://book-replica-sidecar:5104"

echo Starting the split stack (separate containers for all five service/sidecar pairs)...
docker compose --profile split up -d --build
if errorlevel 1 exit /b 1

docker compose --profile split ps
echo.
echo Dashboard:     http://localhost:3000
echo API Gateway:   http://localhost:8080
echo Control Plane: http://127.0.0.1:4000 (token-protected)
echo.
echo Run "npm run traffic" to generate real requests.
endlocal
