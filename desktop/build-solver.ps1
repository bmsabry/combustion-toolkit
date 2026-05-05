# Build the standalone ctk-solver.exe binary that Electron spawns on Windows.
# ASCII-only, no fancy quotes, no em-dashes, no parens inside strings.
# Output: desktop/solver-dist/ctk-solver.exe

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here "..")
$out  = Join-Path $here "solver-dist"

Write-Host "=== Combustion Toolkit Windows solver build ==="
Write-Host "  repo: $repo"
Write-Host "  out:  $out"

# ---- locate Python 3.12 or newer ----
function Find-Python {
  foreach ($cmd in @("python", "python3.12", "python3")) {
    $p = Get-Command $cmd -ErrorAction SilentlyContinue
    if ($p) {
      $v = & $cmd --version 2>&1
      if ($v -match "Python 3\.1[2-9]") { return $cmd }
    }
  }
  $py = Get-Command "py" -ErrorAction SilentlyContinue
  if ($py) {
    $v = & py -3.12 --version 2>&1
    if ($v -match "Python 3\.1[2-9]") { return "py -3.12" }
  }
  throw "Python 3.12+ not found. Install from python.org and re-run."
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
  & $venvPy -m PyInstaller `
    --clean `
    --noconfirm `
    --onefile `
    --name ctk-solver `
    --distpath $out `
    --workpath $workPath `
    --specpath $out `
    --hidden-import cantera `
    --hidden-import uvicorn.logging `
    --hidden-import uvicorn.loops `
    --hidden-import uvicorn.loops.auto `
    --hidden-import uvicorn.protocols `
    --hidden-import uvicorn.protocols.http `
    --hidden-import uvicorn.protocols.http.auto `
    --hidden-import uvicorn.protocols.websockets `
    --hidden-import uvicorn.protocols.websockets.auto `
    --hidden-import uvicorn.lifespan `
    --hidden-import uvicorn.lifespan.on `
    --collect-all cantera `
    --collect-all scipy `
    $bootstrapPath 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
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
