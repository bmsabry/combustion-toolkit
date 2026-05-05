# Build the standalone `ctk-solver.exe` binary that Electron spawns on Windows.
#
# Requirements:
#   - Python 3.12 on PATH (or accessible via `py -3.12`)
#   - Microsoft Visual C++ Build Tools (PyInstaller needs them, and Cantera's
#     wheel install pulls binaries that rely on the MSVC redistributable)
#   - Internet access (first run downloads ~500 MB of wheels into a venv)
#
# Output: desktop/solver-dist/ctk-solver.exe (~250 MB, includes Cantera + GRI-Mech)
#
# Notes on the Ed25519 anti-piracy upgrade:
#   The previous HMAC scheme required CTK_BAKED_SIGNING_KEY env var. The new
#   Ed25519 scheme bakes only the PUBLIC KEY into the binary (via the default
#   value in config.py), so no secret env var is needed at build time. The
#   private key stays on the Render backend.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here "..")
$out  = Join-Path $here "solver-dist"

Write-Host "=== Combustion Toolkit — Windows solver build ==="
Write-Host "  repo: $repo"
Write-Host "  out:  $out"

# ---- locate Python 3.12 ----
function Find-Python {
  # Prefer plain `python` if it's 3.12; fall back to `py -3.12`.
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
  & $python.Split(' ')[0] $python.Split(' ')[1..($python.Split(' ').Length-1)] -m venv $venv 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
}

$venvPy  = Join-Path $venv "Scripts\python.exe"
$venvPip = Join-Path $venv "Scripts\pip.exe"

if (-not (Test-Path $venvPy)) { throw "venv python not at $venvPy" }

Write-Host "Installing build deps into venv ..."
& $venvPy -m pip install --upgrade pip wheel 2>&1 | Out-Host
& $venvPy -m pip install pyinstaller==6.11.0 2>&1 | Out-Host

Write-Host "Installing api/requirements.txt (this can take 5-10 min the first time) ..."
& $venvPy -m pip install -r (Join-Path $repo "api\requirements.txt") 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

# ---- bootstrap wrapper ----
# Same trick as the bash version: PyInstaller needs a single entrypoint script,
# and we want to drop into app.desktop_main:main().
$bootstrap = @"
import sys
from app.desktop_main import main
raise SystemExit(main())
"@
$bootstrapPath = Join-Path $out "_bootstrap.py"
$bootstrap | Out-File -FilePath $bootstrapPath -Encoding ascii

# ---- run PyInstaller ----
Write-Host "Running PyInstaller ..."
Push-Location $repo
try {
  & $venvPy -m PyInstaller `
    --clean `
    --noconfirm `
    --onefile `
    --name ctk-solver `
    --distpath $out `
    --workpath (Join-Path $out "build") `
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

$sizeMB = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host ""
Write-Host "==> Built: $exe  ($sizeMB MB)"
Write-Host ""
Get-ChildItem $out
