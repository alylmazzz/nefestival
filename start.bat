@echo off
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8765
  python -m http.server 8765
  goto :eof
)
where py >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8765
  py -m http.server 8765
  goto :eof
)
echo Python bulunamadi. Lutfen Python kurun ya da klasoru bir editor icinden local server ile acin.
pause
