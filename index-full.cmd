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
REM      index-full.cmd --assess                            READ-ONLY check of an existing spool
REM                                                          (prints whether Pass 1 can be recovered)
REM      index-full.cmd --recover <version-id> [--csv1-complete] [--work-dir <dir>]
REM                                                          assess, then convert a PROVEN legacy
REM                                                          spool into <dir> (default
REM                                                          .indexer-work-v2), then offer to
REM                                                          continue Pass 1 from the proven row
REM      index-full.cmd --resume <version-id> [--work-dir <dir>]
REM                                                          continue an interrupted run
REM      index-full.cmd --build <version-id> [--activate]
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
REM    * free disk on the output volume: see the printed estimate.
REM      Format v2 stores ONE compact copy of each source row in framed gzip:
REM      measured 461 B/row, 23.02 GB expected for the full corpus (33.71 GB
REM      upper bound); the OLD format wrote 3,273 B/row and produced 217 GB.
REM      With rawCacheDir the run needs 135.42 GB on the upper bound; with
REM      "rawCacheDir": null it needs about 68 GB.
REM
REM  SAFETY: this script never passes --no-resume and never deletes a spool.
REM  If a work directory holds spool files with no durable ledger/checkpoint,
REM  it runs the read-only recovery assessment and STOPS before Pass 1.
REM  `--recover` refuses to convert unless the assessment proves every source is
REM  one contiguous prefix, and it writes into a NEW directory. Marking csv1
REM  complete is opt-in (--csv1-complete) and must be backed by the run log.
REM
REM  raw/file1.csv and raw/file2.csv are NEVER written to; the spool, the output
REM  directory and every existing benchmark version are preserved.
REM ============================================================================

setlocal
cd /d "%~dp0"

set ACTION=%~1
set VERSION=%~2
set OPT3=%~3
set OPT4=%~4
set WORKDIR=
set CSV1COMPLETE=
set WORKDIRARG=
if /I "%OPT3%"=="--work-dir" (
  set WORKDIR=%OPT4%
  set WORKDIRARG=--work-dir %OPT4%
)
if /I "%OPT3%"=="--csv1-complete" set CSV1COMPLETE=1

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
if /I "%ACTION%"=="--assess" goto assess
if /I "%ACTION%"=="--recover" goto recover
if /I "%ACTION%"=="--resume" goto resume

if not "%VERSION%"=="" goto have_version
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i
if "%TODAY%"=="" set TODAY=%DATE%
set VERSION=v1-full-%TODAY%
:have_version

if /I "%ACTION%"=="--activate" goto build_activate
if /I "%ACTION%"=="--preflight-only" goto preflight
if /I "%ACTION%"=="--build" goto build_maybe

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
if /I "%~3"=="--activate" goto build_activate
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

:assess
echo.
echo   READ-ONLY assessment of the existing work directory. Nothing is written.
echo   This can take hours on a 217 GB spool: it reads every record.
echo.
if "%WORKDIR%"=="" set WORKDIR=.indexer-work
bun tools/indexer/src/cli.ts recover-spool --assess --work-dir "%WORKDIR%" --partitions 256
set RESULT=%errorlevel%
goto report

:recover
if "%VERSION%"=="" (
  echo.
  echo   --recover needs the version id the interrupted run used, e.g.
  echo       index-full.cmd --recover v1-full-2026-10-17
  echo   The legacy spool is read only. A new v2 spool is written beside it.
  echo.
  pause
  exit /b 2
)
if "%WORKDIR%"=="" set WORKDIR=.indexer-work-v2
echo.
echo   Assessing .indexer-work, then converting a PROVEN legacy spool into %WORKDIR%.
echo   The original spool is not modified. If the assessment cannot prove a contiguous
echo   prefix, nothing is written and a clean restart is the safe answer.
echo.
if not "%CSV1COMPLETE%"=="1" (
  echo   NOTE: csv1 is NOT marked complete. Its source rows will be re-read and the
  echo   already-spooled ones skipped. That costs time but cannot lose a record.
  echo   Pass --csv1-complete ONLY if the interrupted run's log shows csv1 finished.
  echo.
)
pause
set COMPLETEARG=
if "%CSV1COMPLETE%"=="1" set COMPLETEARG=--complete-sources csv1
bun tools/indexer/src/cli.ts recover-spool --apply --config tools/indexer/indexer.config.json ^
  --work-dir .indexer-work --target-work-dir "%WORKDIR%" --version %VERSION% %COMPLETEARG%
set RESULT=%errorlevel%
if not "%RESULT%"=="0" goto report

echo.
echo   Converted. The next step continues Pass 1 from the proven row and reads only
echo   the remainder of each source. It writes the full index and uploads it.
echo.
set /p CONTINUE=Continue now? [y/N]:
if /I not "%CONTINUE%"=="y" (
  echo.
  echo   Stopped after conversion, as asked. To continue later:
  echo       index-full.cmd --resume %VERSION% --work-dir %WORKDIR%
  echo.
  pause
  exit /b 0
)
bun run index:full -- --version %VERSION% --work-dir "%WORKDIR%" --yes
set RESULT=%errorlevel%
goto report

:resume
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
bun run index:full -- --version %VERSION% --yes %WORKDIRARG%
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
