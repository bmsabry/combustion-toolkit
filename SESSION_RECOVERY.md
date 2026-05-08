# Session Recovery — Combustion Toolkit

Everything a new Claude (or human) session needs to pick up work on this repo
from scratch. If you lose context, start here.

**Last updated:** 2026-05-07 (commit `d01859d` — ETF defaults). Major
rewrite to capture the desktop build pipeline + tier model + every panel
added since April.

---

## 1. What this project is

Combustion Toolkit (ProReadyEngineer) — a FastAPI + Cantera backend with a
React/Vite frontend that computes combustion physics for lean-premixed gas
turbine DLE combustors. Two delivery modes:

- **Web** — production at https://combustion-toolkit.proreadyengineer.com
  (Render-hosted), backed by https://combustion-toolkit-api.onrender.com.
- **Desktop** — Electron app + bundled PyInstaller solver. Ships as
  `Combustion-Toolkit-Windows-x64.zip`. The user activates an offline
  Ed25519-signed license; the bundled solver answers `/calc/*` on
  `127.0.0.1:<port>` so the desktop works fully offline after activation.

Same React bundle ships on both. The auth layer detects desktop via
`window.__CTK_API_BASE__` (set by Electron preload) and unlocks
`hasOnlineAccess` automatically.

Production URLs / IDs (pin in memory):
- Frontend: https://combustion-toolkit.proreadyengineer.com (`srv-d7gs7tnlk1mc73ffl4h0`)
- API:      https://combustion-toolkit-api.onrender.com  (`srv-d7gv88hj2pic73fsa44g`)
- Repo:     https://github.com/bmsabry/combustion-toolkit

---

## 2. Repository layout (current)

```
combustion-toolkit/
├── api/
│   ├── app/
│   │   ├── main.py                # FastAPI cloud entrypoint (auth + billing + calc + admin)
│   │   ├── desktop_main.py        # FastAPI desktop entrypoint (calc only, no auth)
│   │   ├── routers/
│   │   │   ├── calc.py            # /calc/* with `require_full_subscription` dep + LRU cache
│   │   │   ├── auth.py            # signup/login/refresh/me
│   │   │   ├── billing.py         # Stripe checkout/portal/webhook
│   │   │   ├── desktop.py         # /desktop/activate (issues Ed25519 license)
│   │   │   └── admin.py           # promote / demote / mint license / audit log
│   │   ├── schemas.py             # ALL Pydantic request/response models
│   │   ├── models.py              # SQLAlchemy: User, Subscription, LicenseKey, AuditLog
│   │   ├── security.py            # bcrypt, JWT (HS256), Ed25519 license signer
│   │   ├── deps.py                # require_full_subscription, get_current_user
│   │   ├── config.py              # pydantic-settings
│   │   ├── db.py                  # SQLite dev / Postgres prod
│   │   ├── mechanisms/            # Glarborg 2018 .yaml (GRI ships with Cantera)
│   │   └── science/               # ← physics
│   │       ├── mixture.py                  # _normalize_to_mech, fuel_mass_fraction_at_phi
│   │       ├── water_mix.py                # 3-stream enthalpy balance
│   │       ├── complete_combustion.py      # closed-form T_ad (no dissociation)
│   │       ├── aft.py                      # Cantera-equilibrium T_ad
│   │       ├── flame_speed.py              # 1D FreeFlame + Le_eff/Markstein/Zeldovich
│   │       ├── flame_speed_sweep.py        # parallel sweep
│   │       ├── combustor.py                # PSR + PFR ReactorNet
│   │       ├── combustor_mapping.py        # LMS100 4-circuit DLE correlation model
│   │       ├── cycle.py                    # gas-turbine cycle decks (LM6000PF, LMS100PB+)
│   │       ├── exhaust.py                  # exhaust + 15%O2 + slip CO/UHC corrections
│   │       ├── props.py                    # LHV/HHV/Wobbe/MWI
│   │       └── autoignition.py             # τ_ign (constant V)
│   ├── tests/                              # pytest suite (regression pins)
│   ├── alembic/                            # migrations
│   └── requirements.txt
│
├── src/                                    # React frontend (single-file App.jsx)
│   ├── App.jsx                             # ~15k lines, 10 tabs (see §3)
│   ├── api.js                              # REST client + JWT refresh + license-token header
│   ├── auth.jsx                            # AuthProvider — desktop unlock via window.__CTK_API_BASE__
│   ├── automation.js                       # DOE generator + matrix runner
│   ├── perfEstimator.js
│   ├── AccountPanel.jsx
│   └── main.jsx
├── desktop/                                # Electron wrapper (see §4)
│   ├── main.js                             # Electron main process (license + spawn solver)
│   ├── preload.js                          # exposes __CTK_API_BASE__ + __CTK_LICENSE_TOKEN__
│   ├── activation.html                     # license-key entry screen
│   ├── build-solver.ps1                    # PyInstaller .spec build for ctk-solver.exe
│   └── package.json                        # electron-builder config
│
├── public/burner-modes/                    # BD2.png, BD4.png, BD6.png, BD7.png (assumption refs)
├── vite.config.js                          # base: './' for Electron file:// + cloud
└── SESSION_RECOVERY.md                     # this file
```

The user's workspace (NOT in git) holds the build runners:
- `<workspace>/run-build.cmd` — wrapper that runs `build2.ps1`
- `<workspace>/build2.ps1` — full pipeline: git pull → npm → vite → electron-builder → PyInstaller → zip
- `<workspace>/Combustion-Toolkit-Windows-x64.zip` — final ~650 MB build artifact

---

## 3. Frontend tab order (current — App.jsx)

The user picks an Application Mode (Free / Combustion Toolkit / Gas Turbine
Simulator / Advanced) which gates which tabs are visible:

| Tab | id | Modes | Notes |
|-----|----|-------|-------|
| Operations Summary | `ops_summary` | gts, advanced | KPI dashboard; consumes cycle + mapping |
| Cycle | `cycle` | gts, advanced | LM6000PF / LMS100PB+ deck, ambient + load + bleed |
| Combustor Mapping | `mapping` | mapping, advanced | 4-circuit correlation; live-mapping protection cycle |
| Flame Temp & Properties | `flame_temp` | all paid | Fuel + flame card + equilibrium-at-T4 mixture |
| Exhaust Analysis | `exhaust` | all paid | O2/CO2 inversion + CO/UHC/H2 slip + Fuel & Money |
| Combustor PSR→PFR | `combustor` | toolkit, advanced | Cantera kinetic stack |
| Flame Speed & Blowoff | `flame_speed` | toolkit, advanced | Le_eff regime card + LBO + flashback |
| Automate | `automate` | advanced | DOE matrix runner + dependency-pruned factorial |
| Plot Builder | `plots` | advanced | Custom + faceted plots over automation results |
| Nomenclature | `nomen` | always | Symbol glossary |
| Assumptions | `assumptions` | always | Every formula / source listed |

Mode-tier mapping in `App.jsx` `MODES` table; license tier comes from
`window.__CTK_LICENSE__.tier` (desktop) or JWT (cloud).

---

## 4. Desktop build pipeline (CRITICAL — many footguns)

End-to-end flow. The whole thing has been hard-fought over the past week
— don't change any of this without reading the corresponding commit.

```
run-build.cmd
   └─ build2.ps1   (lives in user's workspace, NOT in git repo)
        ├─ [1/7] git fetch origin main && git reset --hard
        ├─ [2/7] npm install (root)
        ├─ [3/7] npm run build (vite → dist/)        ── needs base:'./' for file://
        ├─ [4/7] cp -r dist/ desktop/ui/
        ├─ [5/7] npm install (desktop/, electron + electron-builder)
        ├─ [6/7] desktop/build-solver.ps1
        │         ├─ Find Anaconda Python 3.12+ (skip WindowsApps stub)
        │         ├─ Create .solver-venv, pip install requirements.txt + pyinstaller
        │         ├─ Hunt every .dll under <Anaconda>\Library\bin\ (~454)
        │         ├─ Generate ctk-solver.spec with the DLL list inline
        │         │   (CLI args would blow Windows' 32K cmdline limit)
        │         ├─ pyinstaller --clean ctk-solver.spec
        │         └─ → desktop/solver-dist/ctk-solver.exe (~545 MB onefile)
        └─ [7/7] electron-builder --dir
                  ├─ Auto-kill any running Combustion Toolkit / ctk-solver procs
                  │   (otherwise EBUSY on Combustion Toolkit.exe)
                  └─ → desktop/dist/win-unpacked/  (≈190 MB Electron + ctk-solver bundled)
        └─ Compress-Archive → workspace/Combustion-Toolkit-Windows-x64.zip
```

Hard-won fixes (in commit order):
- `9477281` — PyInstaller `--paths api` so the bootstrap can resolve `from app.desktop_main`
- `34d2479` — bundle every Anaconda `Library\bin\*.dll` so `_ctypes`/numpy/scipy/cantera load
- `2768812` — strip ALL Unicode from build-solver.ps1 (Windows PS 5.1 reads as CP1252)
- `65a6dfe` — switch PyInstaller invocation to `.spec` file (32K cmdline limit)
- `f325c1d` — Vite `base: './'` so Electron's file:// finds `assets/index-*.js`
- `c31ef7d` — auth.jsx: desktop mode unlocks `hasOnlineAccess` via `window.__CTK_API_BASE__`
- `9bceb6f` — desktop_main.py registers cycle / mapping / solve-phi-for-tflame
- `eb2a343` — desktop_main.py: skip HMAC re-check when `CTK_BAKED_SIGNING_KEY` empty
- `6c2c308` — full `[CTK_DEBUG]` logging across boot/calc-gate chain (DevTools auto-opens)

Diagnostic logs the desktop drops on first run (in `%USERPROFILE%`):
- `ctk-solver.log` — Python tracebacks from FastAPI exception handler
- `ctk-solver-stderr.log` — uvicorn + Python warnings
- `ctk-solver-stdout.log` — `CTK_PORT=...` + lifecycle

Smoke-test path after a successful build: extract zip, run
`Combustion Toolkit.exe`, click Cycle. The tab should populate; if not,
DevTools console + the three log files above pin the failure layer.

### Smart App Control

Windows 11 Smart App Control blocks unsigned EXE launches with
"An Application Control policy has blocked this file." Toggle it off in
Settings → Privacy & security → Windows Security → Smart App Control.
**Irreversible** per Microsoft (can't be re-enabled without a Windows
reset). Production fix is code-signing the EXE.

---

## 5. License + tier model (rewritten 2026-05-05)

Four tiers in `models.SubscriptionTier`:

| Tier | Capabilities | Annual price |
|------|-------------|--------------|
| `FREE` | Free panels, simplified analytics, no kinetic solver | $0 |
| `CTK` (Combustion Toolkit) | Toolkit panels, Cantera backend | $100 |
| `GTS` (Gas Turbine Simulator) | Cycle + Mapping + Live Mapping (LMS100 only) | $150 |
| `EVERYTHING` | All of the above + Advanced + Automate + Plots | $200 |

New signups get a **14-day Everything trial** automatically (`#205`).

License signing migrated HMAC → **Ed25519** (`#204`):
- Private key in Render env var `ED25519_PRIVATE_KEY_B64` (32-byte seed, base64).
- Public key embedded in `desktop/main.js` so offline verification works.
- Signed JWT payload includes `tier`, `features`, `expires_at`, `device_id`.
- `max_activations` default **2** per key (`#206`).
- The PyInstaller-baked HMAC path is currently empty — `desktop_main.py`
  treats absent `CTK_BAKED_SIGNING_KEY` as "trust the Ed25519 check
  main.js already passed" (commit `eb2a343`).

The legacy frontend tier-override in `localStorage` was killed (`#207`);
desktop reads `window.__CTK_LICENSE__.tier` injected via preload, cloud
reads the JWT.

---

## 6. Trip / stage-down logic (Live Mapping)

100% client-side JavaScript in `App.jsx` lines 6256–6800. Backend has
zero trip code.

State machine ticks every **500 ms** while Live Mapping is active:
- Reads `corrRef.current` (latest `/calc/combustor_mapping` response) and
  `cycleRef.current` (latest `/calc/cycle`).
- Maintains `tripStateRef` for stochastic phi_IP / phi_OP / PX36 trips
  + 4-hour lockout.
- BR ladder is computed by `calcBRNDMD(MW_net, emissionsMode, override)`
  with G/F/D/B = 7/6/4/2.

Important atomic-toggle (commit `6f...`, task #194): mode flip
batches φ_IP/OP/IM and `brndmdOverride` in the same React tick so the
trip checker never sees `{old BR + new φ}` mid-render.

Default Emissions Transfer Function multipliers (`d01859d`):

| BR | NOx × | CO × | PX36 × |
|----|-------|------|--------|
| G (7) | 1.00 | 1.00 | 1.00 |
| F (6) | 1.00 | 0.90 | 1.00 |
| D (4) | 1.00 | 0.85 | 1.00 |
| B (2) | 0.50 | 0.25 | 1.50 |

Stored under localStorage key `ctk.emTfMults.v3`. Bumping the version
suffix invalidates cached older defaults.

Cloud vs desktop trip-behavior gap: cloud has an LRU cache on
`/calc/combustor_mapping` so repeats return in <10 ms; desktop has none
and re-runs Cantera (~200–800 ms per call for 4× T_AFT equilibria).
At 500 ms tick rate that means desktop reads stale `corrRef.current`
for 1–2 ticks longer than cloud after an input change. Latency
discrepancy noted but not yet fixed — porting `_cached_compute` into
`desktop_main.py` is the obvious resolution.

---

## 7. Deploy workflow (CRITICAL — Render does NOT auto-deploy)

Pushes via GitHub PAT do **not** trigger Render auto-deploys. After
every push, fire both deploy hooks via the Render API.

```bash
# 1. Load secrets from the user's uploads folder
set -a; . "$(ls /sessions/busy-charming-allen/mnt/uploads/*_secrets.env)"; set +a

# 2. Push
git push "https://x-access-token:${GITHUB_ACCESS_TOKEN}@github.com/bmsabry/combustion-toolkit.git" main

# 3. Trigger API deploy
curl -s -X POST "https://api.render.com/v1/services/srv-d7gv88hj2pic73fsa44g/deploys" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" -H "Content-Type: application/json" -d '{}'

# 4. Trigger frontend deploy
curl -s -X POST "https://api.render.com/v1/services/srv-d7gs7tnlk1mc73ffl4h0/deploys" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" -H "Content-Type: application/json" -d '{}'
```

Service IDs:
- API:      `srv-d7gv88hj2pic73fsa44g`
- Frontend: `srv-d7gs7tnlk1mc73ffl4h0`

---

## 8. Secrets — NOT in this repo

All secrets live in `/sessions/busy-charming-allen/mnt/uploads/*_secrets.env`
(filename contains `_secrets.env`). Variables:

| Variable | Used for |
|----------|----------|
| `GITHUB_USERNAME`, `GITHUB_ACCESS_TOKEN` | git push via HTTPS |
| `RENDER_API_KEY` | trigger Render deploys |
| `RESEND_API_KEY` | transactional email |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | subscription billing |
| `OPENAI_*` | DeepInfra (currently unused) |

Production env vars set directly in Render's dashboard per service.
The API refuses to start in prod without:
- `SECRET_KEY` (JWT signing)
- `DATABASE_URL` (Postgres)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `ED25519_PRIVATE_KEY_B64` (license signing)
- `ADMIN_SECRET`, `ADMIN_EMAILS`

---

## 9. Bilger-Z fix (do NOT re-introduce)

Cantera's `gas.mixture_fraction(fuel, oxidizer, basis="mass")` returns
**Bilger's** Z, not the physical fuel-stream mass fraction. The two
diverge whenever the oxidizer carries C/H atoms (humid air → ~3 % H2O)
or the fuel stream carries inert (NG → ~1–2 % N2). Use the shared
helper `fuel_mass_fraction_at_phi(fuel_x, ox_x, phi, mech)` in
`api/app/science/mixture.py` for any enthalpy-balance computation.
Both `make_gas_mixed` and `make_gas_mixed_with_water` already do.
Don't revert either to `gas.mixture_fraction(...)`.

Fix shipped in commit `b0ec1b1` (2026-04-20). Regression tests
re-pinned against the independent oracle `api/tests/_ref_psr_pfr.py`.

---

## 10. How to run locally

Backend:
```
cd api
python3.12 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001
```

Frontend (web mode, hits cloud or local API per `VITE_API_BASE`):
```
npm install
npm run dev         # → http://localhost:5173
```

Desktop dev mode (live React + bundled solver):
```
# In one shell:
cd api && uvicorn app.desktop_main:app --port 8002

# In another:
cd desktop
CTK_DEV_UI=http://localhost:5173 npm start    # Electron loads dev server
```

Test suite (must pass before committing):
```
cd api && python -m pytest -q
```

Re-derive test pins from the oracle (only after intentional physics changes):
```
cd api && python -m tests._ref_psr_pfr
```

---

## 11. Key architectural decisions (carry-over from prior versions)

- **Mechanism choice.** GRI-Mech 3.0 default; Glarborg 2018 optional.
  `_normalize_to_mech` substitutes missing fuels (e.g., GRI has no C4H10
  → split to C2H6+C2H6 preserving H/C ratio). See `FUEL_SUBSTITUTIONS`.
- **PSR + PFR combustor model.** CSTR at user-specified τ feeds plug
  flow over L_PFR at V_PFR. Cold-ignited HP-equilibrium seed avoids
  false convergence at short τ.
- **Three-stream water injection.** WFR = ṁ_water / ṁ_fuel; adiabatic
  premix among fuel (T_fuel), oxidizer (T_air), and water (15°C liquid
  or T_air steam). Liquid uses linear IAPWS-IF97 h_fg fit valid 273–500 K.
- **Auth + gating.** bcrypt + HS256 JWT cloud-side; Ed25519-signed
  offline JWT for desktop. `/calc/*` requires `has_online_access`
  (cloud) OR runs on the bundled desktop solver.

---

## 12. Default operating point (canonical test case)

Used repeatedly in debugging and as the live UI defaults:

- **Fuel** (pipeline NG): CH4 93.1, C2H6 3.2, C3H8 0.7, C4H10 0.4, CO2 1.0, N2 1.6 (mol%)
- **Oxidizer** (humid air @ 60 % RH, 25 °C): O2 20.29, N2 75.67, Ar 0.9, CO2 0.03, H2O 3.11
- **phi:** 0.555
- **P:** 400 psia (≈ 27.58 bar)
- **T_fuel:** 70 °F (294.26 K)
- **T_air:** 1000 °F (810.93 K)

Post-fix expected T_ad vs WFR (liquid water @ 15 °C supply):

| WFR | T_mixed (K) | T_ad (K) | ΔT_ad |
|-----|-------------|----------|-------|
| 0.0 | 770.1       | 1917.8   | 0     |
| 0.2 | 752.3       | 1890.9   | 27    |
| 1.0 | 684.2       | 1788.8   | 129   |

If the live app diverges materially from these, something regressed.

For Cycle (LMS100PB+, 100 % load, ambient 60 °F / 60 % RH):
- MW_net ≈ 106.0 MW
- Fuel flow ≈ 11.06 lb/s
- T3 ≈ 700 °F, T4 ≈ 2780 °F
- η_LHV ≈ 44.74 %, Heat Rate ≈ 8046 kJ/kWh
- NOx@15%O2 ≈ 50.6 ppmvd, CO@15%O2 ≈ 259.5 ppmvd

These are the values the desktop smoke-tested against on 2026-05-07
(commit `eb2a343` final desktop fix).

---

## 13. Auto-memory file pointers

The user's auto-memory at `/sessions/.../mnt/.auto-memory/` already contains:
- `reference_secrets_file.md` — secrets file location + load pattern
- `reference_render_service_ids.md` — service IDs
- `feedback_render_webhook.md` — Render doesn't auto-deploy after PAT push
- `reference_admin_promote_fix.md` — curl POST /admin/promote when admin shows as Free

If the auto-memory isn't accessible, sections 7 + 8 here cover everything.

---

## 14. Gotchas / non-obvious behaviors

- **Render + PAT pushes don't auto-deploy** (§7).
- **GRI-Mech lacks C4H10+** → `_normalize_to_mech` substitutes.
- **Glarborg has no C3 species** → C3H8 → C2H6 substitution (1 C lost
  per mol; fine for trace amounts).
- **`mixture_fraction()` is Bilger's Z** — never use as mass fraction in
  enthalpy balance (§9).
- **Gunicorn timeout in prod is 600 s** — match the frontend
  `useBackendCalc` request timeout.
- **Desktop runs against bundled solver, not cloud.** `auth.jsx`
  detects via `window.__CTK_API_BASE__` and unlocks
  `hasOnlineAccess` automatically. Without that you get the
  silent "no calc fires" symptom (`#223`).
- **PyInstaller spec-file vs CLI args.** Always use the spec; 454
  `--add-binary` flags blow Windows' 32K cmdline limit.
- **Vite must build with `base: './'`** — absolute paths break
  Electron's file:// (resolves to `C:\assets\...`).
- **PowerShell 5.1 reads .ps1 as CP1252.** No Unicode in scripts.
- **localStorage version-key bumps** — when changing user-facing
  defaults stored in localStorage (e.g. ETF table), bump the version
  suffix (`v1` → `v2` → `v3`) so existing users get the new defaults.
- **Smart App Control blocks unsigned EXE.** Toggle off in Settings,
  irreversibly. Permanent fix is code-signing.
- **CORS.** API is locked to the two Render origins + localhost dev
  ports. Adding a new origin needs a prod env var update.

---

## 15. Quickstart for a brand-new session

If you're a fresh Claude picking up this repo:

1. Clone: `git clone https://github.com/bmsabry/combustion-toolkit.git`.
2. Read this file end-to-end.
3. Load secrets (§8).
4. Run `cd api && python -m pytest -q` — full suite must pass.
5. For physics questions (water injection / humid air / Bilger-Z), §9.
6. For desktop build issues, §4 + the three log files in `%USERPROFILE%`.
7. For a layout overview of the React side, §3 (10 tabs, App.jsx is huge
   but searchable — every panel is a `function XxxPanel(props)` block).

Recent commits worth scanning before any major change:
```bash
git log --oneline --since="2026-04-20" | head -50
```
