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

# ---- run PyInstaller ----
Write-Host "Running PyInstaller ..."
Push-Location $repo
try {
  $workPath = Join-Path $out "build"
  # Build the PyInstaller arg list as a flat array (avoids all of
  # PowerShell's line-continuation parsing). PyInstaller writes warnings
  # to stderr; with $ErrorActionPreference = Continue (set above) those
  # are fine. We check $LASTEXITCODE explicitly after.
  # CRITICAL: --paths "$repo\api" so PyInstaller can resolve the
  # `from app.desktop_main import main` import in the bootstrap. Without
  # this, PyInstaller analyzes the bootstrap, can't find the `app` package
  # (it's at api/app/, not at the repo root), still produces an EXE
  # because there's no fail-fast on missing imports, and the EXE crashes
  # at runtime with "ModuleNotFoundError: No module named 'app'" — exactly
  # the error the May 7 build hit.
  #
  # --collect-submodules "app" tells PyInstaller to walk app/ and bundle
  # every sub-module (routers/*, science/*, etc.) without us having to
  # list each one as --hidden-import.
  $apiPath = Join-Path $repo "api"

  # ── DLL hunt: Anaconda Python's _ctypes.pyd depends on libffi-*.dll;
  # numpy/scipy/cantera transitively pull in MKL, OpenBLAS, intel-openmp,
  # libcrypto, libssl, etc. PyInstaller's analyzer doesn't follow native
  # DLL→DLL graphs reliably on Windows when the source is a base venv on
  # top of Anaconda — it bundles the .pyd extension modules but skips
  # the transitive .dll deps that live in `<Anaconda>\Library\bin\`.
  # Result: at runtime _ctypes (or scipy._fft, etc.) fails with
  # "DLL load failed while importing _ctypes: The specified module could
  # not be found." (the actual error the May 7 build hit).
  #
  # Fix: locate every .dll in <Anaconda>\Library\bin\ — Anaconda's
  # canonical "shared C/Fortran libs" directory — and pass each to
  # PyInstaller via --add-binary so they sit next to ctk-solver.exe in
  # the frozen bundle. This bundles ~200 MB of DLLs we don't strictly
  # need, but it guarantees no missing-DLL errors at runtime; it's the
  # standard Anaconda+PyInstaller workaround. Onedir would solve this
  # more elegantly but onefile is what main.js + electron-builder are
  # already wired for.
  #
  # $python is the python.exe path Find-Python returned; its directory is
  # the Anaconda root. Library\bin\ is sibling to python.exe.
  $pythonDir = Split-Path $python -Parent
  $libBin    = Join-Path $pythonDir "Library\bin"
  $extraBinaries = @()
  if (Test-Path $libBin) {
    Write-Host "Hunting Anaconda DLLs in $libBin ..."
    $dlls = Get-ChildItem -Path $libBin -Filter "*.dll" -ErrorAction SilentlyContinue
    Write-Host "  Found $($dlls.Count) DLLs to bundle."
    foreach ($d in $dlls) {
      $extraBinaries += "--add-binary"
      # PyInstaller --add-binary takes "src;dest" on Windows. dest "."
      # places the DLL next to ctk-solver.exe in the temp extraction dir
      # at runtime, which is on Windows's DLL search path.
      $extraBinaries += "$($d.FullName);."
    }
  } else {
    Write-Host "WARNING: Anaconda Library\bin not found at $libBin — _ctypes / numpy / scipy may fail at runtime."
  }

  # Custom Cantera mechanisms (Glarborg etc.) live at api/app/mechanisms/.
  # mixture.py loads them via os.path.dirname(__file__)/../mechanisms — in
  # the frozen EXE that path resolves inside the PyInstaller temp dir, so
  # the YAML files must be bundled there as data. Cantera's stock GRI-Mech
  # comes from `--collect-all cantera` already.
  $mechSrc = Join-Path $apiPath "app\mechanisms"
  $mechSpec = "$mechSrc;app/mechanisms"
  $pyiArgs = @(
    "-m", "PyInstaller",
    "--clean", "--noconfirm", "--onefile",
    "--name", "ctk-solver",
    "--distpath", $out,
    "--workpath", $workPath,
    "--specpath", $out,
    "--paths", $apiPath,
    "--collect-submodules", "app",
    "--add-data", $mechSpec,
    "--hidden-import", "app",
    "--hidden-import", "app.desktop_main",
    "--hidden-import", "cantera",
    "--hidden-import", "uvicorn.logging",
    "--hidden-import", "uvicorn.loops",
    "--hidden-import", "uvicorn.loops.auto",
    "--hidden-import", "uvicorn.protocols",
    "--hidden-import", "uvicorn.protocols.http",
    "--hidden-import", "uvicorn.protocols.http.auto",
    "--hidden-import", "uvicorn.protocols.websockets",
    "--hidden-import", "uvicorn.protocols.websockets.auto",
    "--hidden-import", "uvicorn.lifespan",
    "--hidden-import", "uvicorn.lifespan.on",
    "--collect-all", "cantera",
    "--collect-all", "scipy",
    $bootstrapPath
  )
  # Splice in every --add-binary for the Anaconda Library\bin DLLs. Done
  # after the @() literal because PowerShell's @() initializer balks at
  # mixing a fixed list with a dynamic array spread.
  $pyiArgs = $pyiArgs[0..($pyiArgs.Length - 2)] + $extraBinaries + $pyiArgs[-1]
  & $venvPy @pyiArgs 2>&1 | ForEach-Object { Write-Host $_ }
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
