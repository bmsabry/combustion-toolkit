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
  $pyiArgs = @(
    "-m", "PyInstaller",
    "--clean", "--noconfirm", "--onefile",
    "--name", "ctk-solver",
    "--distpath", $out,
    "--workpath", $workPath,
    "--specpath", $out,
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
