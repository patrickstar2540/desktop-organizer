@echo off
rem Fallback launcher - use this if the .vbs gets blocked by antivirus.
rem Node is located at runtime, so this file works on any machine:
rem   1) whatever "node" is on PATH
rem   2) the standard install locations
rem   3) the Node runtime shipped with WorkBuddy (any version)
setlocal
cd /d "%~dp0"

set "NODE_EXE="

rem 0) the Node bundled next to this file (portable build) wins over everything
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"

rem 1) whatever "node" is on PATH
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
set "PF86=%ProgramFiles(x86)%"
if not defined NODE_EXE if exist "%PF86%\nodejs\node.exe" set "NODE_EXE=%PF86%\nodejs\node.exe"

if not defined NODE_EXE for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if not defined NODE_EXE if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"

if not defined NODE_EXE (
  echo Node.js was not found.
  echo Install Node.js 18+ from https://nodejs.org and run this again.
  pause
  exit /b 1
)

start "" /min "%NODE_EXE%" "%~dp0server.js"
endlocal
exit
