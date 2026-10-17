@echo off
REM ============================================================================
REM  CompanyIntel - build the COMPLETE index (one command, Windows)
REM ============================================================================
REM
REM  Double-click this file, or run it from a terminal:
REM
REM      index-full.cmd                                     build, upload, verify, then STOP
REM      index-full.cmd --activate                          also make it the active dataset
REM      index-full.cmd --preflight-only                    only check auth, sources, disk, RAM
REM      index-full.cmd --resume <version-id>               continue an interrupted run
REM      index-full.cmd --build <version-id> [--activate]   use an explicit version id
REM
REM  It runs the same pipeline the tests run (scripts/full-index.mjs):
REM  dependency check, source version, cost expectation, resume state, preflight,
REM  Pass 1, Pass 2, local validation, coverage labelling, upload,
REM  read-every-object-back verification from R2, and (only with --activate)
REM  activation. Every stage is resumable; nothing is ever deleted, and the
REM  source objects raw/file1.csv and raw/file2.csv are read only.
REM
REM  Requirements, checked by the script itself:
REM    * Bun on PATH           (https://bun.sh)
REM    * `bun install` done    (node_modules present)
REM    * R2 credentials        (private .r2-credentials.json, or R2_* env vars)
REM    * free disk on the output volume: see the printed estimate. The full
REM      corpus needs roughly 95-185 GB depending on rawCacheDir.
REM
REM  raw/file1.csv and raw/file2.csv are NEVER written to; the spool, the output
REM  directory and every existing benchmark version are preserved.
REM ============================================================================

setlocal
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Bun is not on PATH. Install it from https://bun.sh then run this file again.
  echo.
  pause
  exit /b 2
)

REM The version id is the immutable output prefix: re-running the SAME id resumes
REM the same run instead of starting a second one. --resume/--build take it as the
REM second argument; without one, today's date is used.
REM --resume must never invent a version id: resuming the wrong id would start a
REM second, parallel build under a new name. It is checked before the default.
if "%~1"=="--resume" goto resume

set VERSION=%~2
if not "%VERSION%"=="" goto have_version
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i
if "%TODAY%"=="" set TODAY=%DATE%
set VERSION=v1-full-%TODAY%
:have_version

if "%~1"=="--activate" goto build_activate
if "%~1"=="--preflight-only" goto preflight
if "%~1"=="--build" goto build_maybe

echo.
echo   Building the COMPLETE index as version %VERSION%
echo   This reads both source files end to end and uploads the index to R2.
echo   It is resumable: if it stops, re-run "index-full.cmd --resume %VERSION%".
echo.
pause

bun run index:full -- --version %VERSION% --yes
set RESULT=%errorlevel%
goto report

:build_maybe
if "%~3"=="--activate" goto build_activate
bun run index:full -- --version %VERSION% --yes
set RESULT=%errorlevel%
goto report

:build_activate
bun run index:full -- --version %VERSION% --yes --activate
set RESULT=%errorlevel%
goto report

:preflight
bun run index:full -- --version %VERSION% --preflight-only
set RESULT=%errorlevel%
goto report

:resume
set VERSION=%~2
if "%VERSION%"=="" (
  echo.
  echo   Resume needs the version id the earlier run used, e.g.
  echo       index-full.cmd --resume v1-full-2026-10-18
  echo   The id is printed at the top of every run and is in the name of
  echo   index-reports\full-index-^<id^>.log
  echo.
  pause
  exit /b 2
)
echo   Resuming version %VERSION% - the Pass 1 spool and checkpoint are reused.
bun run index:full -- --version %VERSION% --yes
set RESULT=%errorlevel%
goto report

:report
echo.
if "%RESULT%"=="0" (
  echo   Done. The run log and the JSON summary are in the index-reports folder.
  echo   To make this version the active dataset:  index-full.cmd --activate %VERSION%
) else (
  echo   Stopped with exit code %RESULT%. Read the last stage that printed above.
  echo   Nothing was deleted: re-run "index-full.cmd --resume %VERSION%" to continue.
)
echo.
pause
exit /b %RESULT%
