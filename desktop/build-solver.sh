#!/usr/bin/env bash
# Build the standalone `ctk-solver` binary that Electron spawns.
#
# Requirements: Python 3.12, pip, patchelf/install_name_tool (platform-dependent).
# The resulting binary lands in desktop/solver-dist/ctk-solver(.exe).
#
# Environment variables consumed:
#   CTK_BAKED_SIGNING_KEY   (required)  — same HMAC secret as backend's LICENSE_SIGNING_KEY.
#                                         Baked into the binary so it can verify license
#                                         tokens offline. Rotate by re-releasing the app.

set -euo pipefail

cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"
OUT="$(pwd)/solver-dist"

if [[ -z "${CTK_BAKED_SIGNING_KEY:-}" ]]; then
  echo "ERROR: CTK_BAKED_SIGNING_KEY env var required." >&2
  echo "       Use the same value as Render's LICENSE_SIGNING_KEY secret." >&2
  exit 1
fi

mkdir -p "$OUT"
rm -rf "$OUT"/*

# ---- build venv ----
VENV="$(pwd)/.solver-venv"
if [[ ! -d "$VENV" ]]; then
  python3.12 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install --upgrade pip wheel
pip install pyinstaller==6.11.0
pip install -r "$REPO/api/requirements.txt"

# ---- freeze signing key as a resource file that PyInstaller picks up ----
# We don't embed the key as a literal string in the spec file; instead we write it to
# a one-line `baked_key.txt` and read it at runtime via sys._MEIPASS. That way the
# secret doesn't end up in version control.
# However desktop_main.py reads the key from CTK_BAKED_SIGNING_KEY env at startup.
# To make that env var available even after PyInstaller freezes, we generate a small
# bootstrap wrapper that sets os.environ before importing app.desktop_main.
cat > "$OUT/_bootstrap.py" <<'PYEOF'
import os, sys
# The baked key is injected as a PyInstaller datas resource.
if getattr(sys, "frozen", False):
    base = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    kpath = os.path.join(base, "baked_key.txt")
    if os.path.exists(kpath):
        with open(kpath, "r", encoding="utf-8") as fh:
            os.environ["CTK_BAKED_SIGNING_KEY"] = fh.read().strip()
from app.desktop_main import main
raise SystemExit(main())
PYEOF

echo -n "$CTK_BAKED_SIGNING_KEY" > "$OUT/baked_key.txt"

# ---- run PyInstaller ----
pushd "$REPO" >/dev/null
pyinstaller \
  --clean \
  --noconfirm \
  --onefile \
  --name ctk-solver \
  --distpath "$OUT" \
  --workpath "$OUT/build" \
  --specpath "$OUT" \
  --add-data "$OUT/baked_key.txt:." \
  --hidden-import cantera \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols \
  --hidden-import uvicorn.protocols.http \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan \
  --hidden-import uvicorn.lifespan.on \
  --collect-all cantera \
  --collect-all scipy \
  "$OUT/_bootstrap.py"
popd >/dev/null

# Remove build artefacts, keep just the exe.
rm -rf "$OUT/build" "$OUT/ctk-solver.spec" "$OUT/_bootstrap.py" "$OUT/baked_key.txt"
echo
echo "==> ctk-solver built: $OUT/"
ls -lh "$OUT"
