@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
title DSH Rescue
cd /d "%~dp0.."

set "SCRIPT=%~dp0rescue.mjs"
if not exist "%SCRIPT%" goto noScript

rem 1) Preferred: run the bundled Electron runtime as Node (no global node needed).
set "DSH_EXE="
call :try "%DSH_DESKTOP_EXE%"
call :try "%DSH_DESKTOP_NODE_EXECUTABLE%"
call :try "%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
call :try "%ProgramFiles%\DeepSeek Harness\DeepSeek Harness.exe"
call :try "%ProgramFiles(x86)%\DeepSeek Harness\DeepSeek Harness.exe"
if not "%DSH_EXE%"=="" goto runExe

rem 2) Fallback: the node.exe that DSH itself downloaded under DSH_HOME.
set "DSH_HOME_DIR=%DSH_HOME%"
if not defined DSH_HOME_DIR set "DSH_HOME_DIR=%USERPROFILE%\.dsh"
set "NODE_EXE="
for /d %%D in ("%DSH_HOME_DIR%\dsh-runtimes\*") do call :tryNode "%%~fD\dependencies\node\bin\node.exe"
if defined NODE_EXE goto runNode

rem 3) Last resort: node from PATH.
where node >nul 2>&1
if errorlevel 1 goto noRuntime
echo [rescue] Using node from PATH.
node "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"
goto done

:runExe
set "ELECTRON_RUN_AS_NODE=1"
"%DSH_EXE%" "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"
goto done

:runNode
echo [rescue] Using the runtime bundled with DSH.
"%NODE_EXE%" "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"
goto done

:noScript
echo [rescue] bin\rescue.mjs is missing next to this .bat file.
pause
exit /b 1

:noRuntime
echo [rescue] Could not find DeepSeek Harness or a bundled node runtime.
echo [rescue] Set DSH_DESKTOP_EXE to the full path of "DeepSeek Harness.exe" and try again.
pause
exit /b 1

:done
if not "%RC%"=="0" (
  echo.
  echo [rescue] exited with code %RC%
  pause
)
exit /b %RC%

:try
if "%~1"=="" exit /b 0
if not exist "%~1" exit /b 0
set "DSH_EXE=%~1"
exit /b 0

:tryNode
if "%~1"=="" exit /b 0
if not exist "%~1" exit /b 0
if defined NODE_EXE exit /b 0
set "NODE_EXE=%~1"
exit /b 0
