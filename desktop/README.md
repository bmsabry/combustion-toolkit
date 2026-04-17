# Combustion Toolkit — Desktop

Electron shell that wraps the same React UI used by the web app and hosts a
bundled Cantera solver (PyInstaller-frozen FastAPI) on loopback. Works fully
offline once a license key has been activated.

## Architecture

```
┌─────────────────────────────┐
│  Electron main (main.js)    │
│   ├─ reads license.json     │
│   ├─ spawns ctk-solver ─────┼──► 127.0.0.1:<port>  (FastAPI + Cantera)
│   └─ opens BrowserWindow ───┼──► ui/index.html  (same React app as web)
└─────────────────────────────┘
```

The renderer reads `window.__CTK_API_BASE__` (set by `preload.js`) so
`src/api.js` hits the local solver instead of `combustion-toolkit-api.onrender.com`.

## License flow

1. First launch shows `activation.html`.
2. User pastes a license key → Electron hits the cloud
   `POST /desktop/activate {key, device_id}` endpoint.
3. Backend returns a `signed_token = <json_payload>|<hex_hmac_sha256>`.
4. Electron persists that token in `userData/license.json`.
5. Every launch: the token's signature is verified against the baked signing
   key and its `expires_at` is checked. The token is passed to the solver as
   `CTK_LICENSE_TOKEN`; every `/calc/*` request must include it as
   `X-License-Token` (set automatically by `src/api.js` if needed — it already
   sends `Authorization: Bearer <jwt>` for the online flow; for desktop we're
   adding `X-License-Token` in a follow-up once the binary is being QA'd).

The HMAC approach is deliberately simple — the signing key is baked into the
PyInstaller binary. A determined attacker could extract it, but the market
for pirated single-user scientific tooling is small and the key can be
rotated by cutting a new release.

## Building

Prerequisites: Python 3.12, Node 20+, and the platform-native toolchain that
PyInstaller needs (XCode CLT on macOS, MSVC on Windows, gcc/make on Linux).

```bash
cd desktop

# 1. Build the React UI and copy it into desktop/ui/
npm install
npm run build:ui

# 2. Build the standalone solver binary. Needs the SAME signing key as the
#    Render backend (LICENSE_SIGNING_KEY env var on the api service).
export CTK_BAKED_SIGNING_KEY="<paste from Render dashboard>"
npm run build:solver

# 3. Package an installer for the host platform.
npm run dist
# output: desktop/dist/Combustion Toolkit-0.1.0.dmg (or .exe / .AppImage)
```

Notes:

- `dist:all` cross-targets `-mwl` but Windows + Linux need their own PyInstaller
  binaries — cross-compiling PyInstaller is brittle. In practice, run the build
  on each host OS.
- Installers are **unsigned**. First launch will trigger OS warnings:
  - macOS: "app is damaged" / Gatekeeper — right-click → Open, or
    `xattr -dr com.apple.quarantine "/Applications/Combustion Toolkit.app"`.
  - Windows: SmartScreen → "More info" → "Run anyway".
  - Linux: chmod +x the AppImage.
  The web UI's `Account & Billing` panel already includes a note telling users
  to expect this.

## Dev mode

```bash
# In one shell, run the web dev server
cd .. && npm run dev   # vite on :5173

# In another shell, run the solver manually
cd api
export CTK_BAKED_SIGNING_KEY="<key>"
export CTK_LICENSE_TOKEN="<paste a real signed_token from /desktop/activate>"
python -m app.desktop_main  # prints CTK_PORT=<n>

# In a third shell, launch Electron pointing at vite and the already-running solver
cd desktop
CTK_DEV_UI=http://localhost:5173 CTK_DEV_SOLVER_PORT=<n> npm start
```
