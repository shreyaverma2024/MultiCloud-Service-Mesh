@echo off
setlocal
cd /d "%~dp0.."

echo Running unit tests...
call npm run test:unit
if errorlevel 1 exit /b 1

echo.
echo Running integration tests against the running local stack...
call npm run test:integration
if errorlevel 1 exit /b 1

echo.
echo All tests completed successfully.
endlocal
