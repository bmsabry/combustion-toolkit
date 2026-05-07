# Build the standalone ctk-solver.exe binary that Electron spawns on Windows.
# ASCII-only, no fancy quotes, no em-dashes, no parens inside strings.
# Output: desktop/solver-dist/ctk-solver.exe

# Use Continue (default) instead of Stop. With "Stop", PowerShell treats ANY
# native-tool stderr output as fatal, including harmless warnings like
# PyInstaller's "115 WARNING: Assuming this is not an Anaconda environment".
# We rely on explicit $LASTEXITCODE checks after each native call instead.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here "..")
$out  = Join-Path $here "solver-dist"

Write-Host "=== Combustion Toolkit Windows solver build ==="
Write-Host "  repo: $repo"
Write-Host "  out:  $out"

# ---- locate Python 3.12+ ----
# Explicit check of common install paths FIRST. We have to skip the
# Microsoft Store stub at C:\Users\<u>\AppData\Local\Microsoft\WindowsApps\python.exe
# which prints "Python was not found" instead of running anything.
function Find-Python {
  $candidates = @(
    "C:\ProgramData\Anaconda3\python.exe",
    "C:\ProgramData\Miniconda3\python.exe",
    "$env:USERPROFILE\anaconda3\python.exe",
    "$env:USERPROFILE\Anaconda3\python.exe",
    "$env:USERPROFILE\miniconda3\python.exe",
    "$env:USERPROFILE\AppData\Local\Programs\Python\Python313\python.exe",
    "$env:USERPROFILE\AppData\Local\Programs\Python\Python312\python.exe",
    "C:\Python313\python.exe",
    "C:\Python312\python.exe"
  )
  foreach ($p in $candidates) {
    if (Test-Path $p) {
      $v = & $p --version 2>&1
      if ($v -match "Python 3\.1[2-9]") {
        return $p
      }
    }
  }
  # Fall back to PATH search, but exclude the WindowsApps Store stub.
  foreach ($cmd in @("python", "python3.12", "python3")) {
    $found = Get-Command $cmd -ErrorAction SilentlyContinue
    if ($found -and ($found.Source -notmatch "WindowsApps")) {
      $v = & $found.Source --version 2>&1
      if ($v -match "Python 3\.1[2-9]") {
        return $found.Source
      }
    }
  }
  throw "Python 3.12+ not found in Anaconda/Miniconda paths or PATH. Install from python.org and re-run."
}

$python = Find-Python
Write-Host "  python: $python"

# ---- prepare output dir ----
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null

# ---- venv ----
$venv = Join-Path $here ".solver-venv"
if (-not (Test-Path $venv)) {
  Write-Host "Creating venv at $venv ..."
  $pyParts = $python.Split(' ')
  if ($pyParts.Length -gt 1) {
    & $pyParts[0] $pyParts[1..($pyParts.Length-1)] -m venv $venv 2>&1 | Out-Host
  } else {
    & $pyParts[0] -m venv $venv 2>&1 | Out-Host
  }
  if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
}

$venvPy = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $venvPy)) { throw "venv python not at $venvPy" }

Write-Host "Installing build deps into venv ..."
& $venvPy -m pip install --upgrade pip wheel 2>&1 | Out-Host
& $venvPy -m pip install pyinstaller==6.11.0 2>&1 | Out-Host

Write-Host "Installing api requirements file - this can take 5 to 10 minutes the first time."
$reqFile = Join-Path $repo "api\requirements.txt"
& $venvPy -m pip install -r $reqFile 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

# ---- bootstrap wrapper ----
# PyInstaller needs a single entrypoint script. Build it from a string array
# instead of a here-string because git autocrlf can break PowerShell here-strings.
$bootstrapPath = Join-Path $out "_bootstrap.py"
$bootstrapLines = @(
  "import sys",
  "from app.desktop_main import main",
  "raise SystemExit(main())"
)
Set-Content -Path $bootstrapPath -Value $bootstrapLines -Encoding ascii

# ---- run PyInstaller via .spec file ----
# Why a .spec file instead of CLI args: bundling 454 DLLs from Anaconda's
# Library\bin via individual --add-binary args blows past Windows'
# 32K command-line limit (CreateProcess fails with "The filename or
# extension is too long"). A .spec file is read by Python as source, so
# the DLL list goes into a Python list literal with no length cap.
Write-Host "Running PyInstaller (via .spec file) ..."
Push-Location $repo
try {
  $workPath = Join-Path $out "build"
  $apiPath  = Join-Path $repo "api"
  $mechSrc  = Join-Path $apiPath "app\mechanisms"

  # Hunt DLLs from <Anaconda>\Library\bin so _ctypes/numpy/scipy/cantera
  # find their transitive native deps at runtime. PyInstaller's analyzer
  # does not follow the native DLL graph for Anaconda-sourced extension
  # modules, so we bundle the whole set explicitly.
  $pythonDir = Split-Path $python -Parent
  $libBin    = Join-Path $pythonDir "Library\bin"
  $dlls = @()
  if (Test-Path $libBin) {
    Write-Host "Hunting Anaconda DLLs in $libBin ..."
    $dlls = Get-ChildItem -Path $libBin -Filter "*.dll" -ErrorAction SilentlyContinue
    Write-Host ("  Found {0} DLLs to bundle." -f $dlls.Count)
  } else {
    Write-Host ("WARNING: Anaconda Library\bin not found at {0}. _ctypes / numpy / scipy may fail at runtime." -f $libBin)
  }

  # Build the binaries list as Python source. Each entry is (src, dest).
  # dest "." places the DLL next to ctk-solver.exe in the unpacked tmpdir
  # at runtime, which is on Windows' DLL search path. Use raw strings
  # (r'...') so backslashes in Windows paths do not get interpreted.
  $binaryEntries = @()
  foreach ($d in $dlls) {
    $binaryEntries += "    (r'{0}', '.')," -f $d.FullName
  }
  $binariesPython = ($binaryEntries -join "`r`n")

  # Forward-slash the api/mechanisms paths so the embedded raw strings
  # work consistently regardless of repo-clone path.
  $bootstrapPy = $bootstrapPath
  $apiPathPy   = $apiPath
  $mechSrcPy   = $mechSrc

  $specPath = Join-Path $out "ctk-solver.spec"
  $specBody = @"
# -*- mode: python ; coding: utf-8 -*-
# Auto-generated by build-solver.ps1. Do not edit by hand; rerun the
# script to regenerate.
from PyInstaller.utils.hooks import collect_submodules, collect_all

cantera_datas, cantera_binaries, cantera_hidden = collect_all('cantera')
scipy_datas,   scipy_binaries,   scipy_hidden   = collect_all('scipy')
app_hidden = collect_submodules('app')

extra_dlls = [
$binariesPython
]

uvicorn_hidden = [
    'uvicorn.logging',
    'uvicorn.loops', 'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http', 'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets', 'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan', 'uvicorn.lifespan.on',
]

a = Analysis(
    [r'$bootstrapPy'],
    pathex=[r'$apiPathPy'],
    binaries=cantera_binaries + scipy_binaries + extra_dlls,
    datas=cantera_datas + scipy_datas + [(r'$mechSrcPy', 'app/mechanisms')],
    hiddenimports=app_hidden + cantera_hidden + scipy_hidden + uvicorn_hidden + [
        'app', 'app.desktop_main', 'cantera',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='ctk-solver',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
"@
  Set-Content -Path $specPath -Value $specBody -Encoding utf8
  Write-Host ("Wrote spec: {0}" -f $specPath)

  # Now invoke PyInstaller with just the spec file path - tiny command
  # line, no length issues.
  & $venvPy -m PyInstaller --clean --noconfirm --distpath $out --workpath $workPath $specPath 2>&1 | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

# ---- cleanup ----
Remove-Item -Recurse -Force (Join-Path $out "build") -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $out "ctk-solver.spec") -ErrorAction SilentlyContinue
Remove-Item -Force $bootstrapPath -ErrorAction SilentlyContinue

$exe = Join-Path $out "ctk-solver.exe"
if (-not (Test-Path $exe)) { throw "ctk-solver.exe was not produced" }

$exeBytes = [int64](Get-Item $exe).Length
$exeMegabytes = [math]::Round($exeBytes / 1048576, 1)
Write-Host ""
Write-Host ("==> Built: {0} - {1} megabytes" -f $exe, $exeMegabytes)
Write-Host ""
Get-ChildItem $out
