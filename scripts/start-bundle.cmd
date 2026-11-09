@echo off
setlocal
cd /d "%~dp0.."

if not exist ".env" (
  node scripts\init-secrets.js
  if errorlevel 1 exit /b 1
)

set "MESH_MODE=bundle"
set "COMPOSE_PROFILES=bundle"
set "MEMBER_SIDECAR_URL=http://render-web:8081/member"
set "BOOK_REPLICA_URL=http://render-web:8081/book-replica"

echo Stopping any existing local stack...
docker compose --profile split --profile bundle down --remove-orphans >nul 2>&1

echo Starting the bundle stack (ONE render-web container with four supervised processes plus ingress)...
docker compose --profile bundle up -d --build
if errorlevel 1 exit /b 1

docker compose --profile bundle ps
echo.
echo Dashboard:      http://localhost:3000
echo API Gateway:    http://localhost:8080
echo Render ingress: http://127.0.0.1:8081 (HMAC-protected)
echo Control Plane:  http://127.0.0.1:4000 (token-protected)
endlocal
