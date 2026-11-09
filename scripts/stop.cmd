@echo off
setlocal
cd /d "%~dp0.."

echo Stopping the local mesh. The PostgreSQL volume is preserved.
docker compose --profile split --profile bundle down --remove-orphans
echo.
echo To also delete all local database data, run:
echo   docker compose --profile split --profile bundle down -v
endlocal
