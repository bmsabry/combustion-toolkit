# Session Recovery — Combustion Toolkit

Everything a new Claude (or human) session needs to pick up work on this repo
from scratch. If you lose context, start here.

**Last updated:** 2026-04-20 (commit `b0ec1b1` — Bilger-Z fix).

---

## 1. What this project is

Combustion Toolkit (ProReadyEngineer) — a FastAPI + Cantera backend with a
React/Vite frontend that computes combustion physics for lean-premixed gas
turbine DLE combustors:

- Adiabatic Flame Temperature (AFT) at a given (phi, T_fuel, T_air, P)
- Laminar flame speed (S_L) + turbulent flame speed (S_T) sweeps
- PSR → PFR combustor with NOx (ppmvd + @15% O2) and CO predictions
- Exhaust composition + dilution / humidity correction
- Fuel properties (LHV, HHV, MW, Wobbe index, Modified Wobbe Index)
- Water / steam injection (WFR 0–2) for NOx knockdown

Production URLs:
- Frontend: https://combustion-toolkit.proreadyengineer.com (served by
  `srv-d7gs7tnlk1mc73ffl4h0` on Render, aliased from combustion-toolkit.onrender.com)
- API:      https://combustion-toolkit-api.onrender.com  (`srv-d7gv88hj2pic73fsa44g`)
- Repo:     https://github.com/bmsabry/combustion-toolkit

---

## 2. Repository layout

```
combustion-toolkit/
├── api/                       # FastAPI backend
│   ├── app/
│   │   ├── main.py            # FastAPI app + CORS + middleware
│   │   ├── routers/           # /auth, /billing, /calc, /desktop
│   │   ├── auth/              # bcrypt + JWT helpers
│   │   ├── models/            # SQLAlchemy models (users, subs, license keys, audit)
│   │   ├── schemas/           # Pydantic request/response models
│   │   ├── db.py              # SQLite for dev, Postgres in prod
│   │   ├── mechanisms/        # *.yaml Cantera mechanism files
│   │   └── science/           # ← the physics lives here
│   │       ├── mixture.py            # shared: _normalize_to_mech, make_gas_mixed, fuel_mass_fraction_at_phi
│   │       ├── water_mix.py          # 3-stream (fuel + air + water) enthalpy balance
│   │       ├── aft.py                # adiabatic flame T (equilibrate HP)
│   │       ├── flame_speed.py        # laminar S_L + S_T correlations
│   │       ├── flame_speed_sweep.py  # grid sweep (parallelized via multiprocessing.Pool)
│   │       ├── combustor.py          # PSR + PFR (ReactorNet) + NOx/CO post-proc
│   │       ├── exhaust.py            # exhaust composition, dilution, 15%O2 correction
│   │       ├── props.py              # LHV/HHV/MW/Wobbe/MWI
│   │       └── autoignition.py       # τ_ign constant-vol
│   ├── mechanisms/            # Glarborg 2018 .yaml (GRI-Mech ships with Cantera)
│   ├── tests/
│   │   ├── _ref_psr_pfr.py           # independent Cantera oracle for regression pins
│   │   ├── test_combustor_regression.py  # 15 pinned PSR+PFR cases
│   │   └── test_water_injection.py       # 8 pinned WFR cases
│   ├── alembic/               # DB migrations
│   ├── alembic.ini
│   ├── Dockerfile
│   ├── requirements.txt       # cantera, fastapi, pydantic, sqlalchemy, stripe, resend, …
│   └── .python-version        # 3.12.7
│
├── src/                       # React frontend
│   ├── App.jsx                # single-page app, ~1400 lines, 5 tabs
│   │                          #   Nav order: Fuel → Exhaust → Combustor → Flame Speed → Stability
│   ├── api.js                 # REST client, JWT auto-refresh, useBackendCalc hook
│   ├── auth.jsx               # AuthProvider + AuthModal
│   ├── AccountPanel.jsx       # subscription/billing UI
│   └── main.jsx
│
├── desktop/                   # Electron wrapper (bundled Python + Cantera)
├── compare/                   # scratch scripts comparing old JS calcs to Cantera
├── public/
├── STATUS.md                  # overnight-run status from 2026-04-17
├── README.md
├── package.json               # Vite 8 + React 19
├── vite.config.js
└── SESSION_RECOVERY.md        # this file
```

---

## 3. Deploy workflow (CRITICAL — Render does NOT auto-deploy)

Pushes made via GitHub PAT token do **not** trigger Render auto-deploys. After
every push, manually fire both deploy hooks via the Render API.

Standard flow:

```
# 1. Load secrets (token file on the user's uploads folder)
set -a; . "$(ls /sessions/busy-charming-allen/mnt/uploads/*_secrets.env)"; set +a

# 2. Push
git push "https://x-access-token:${GITHUB_ACCESS_TOKEN}@github.com/bmsabry/combustion-toolkit.git" main

# 3. Trigger API deploy
curl -s -X POST "https://api.render.com/v1/services/srv-d7gv88hj2pic73fsa44g/deploys" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  -H "Content-Type: application/json" -d '{}'

# 4. Trigger frontend deploy
curl -s -X POST "https://api.render.com/v1/services/srv-d7gs7tnlk1mc73ffl4h0/deploys" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  -H "Content-Type: application/json" -d '{}'
```

Render service IDs (pin in memory):
- **API (backend):**   `srv-d7gv88hj2pic73fsa44g`
- **Frontend (web):**  `srv-d7gs7tnlk1mc73ffl4h0`

---

## 4. Secrets — NOT in this repo

All secrets live in `/sessions/busy-charming-allen/mnt/uploads/*_secrets.env`
on the user's local machine (filename contains `_secrets.env`). Variables:

| Variable | Used for |
|----------|----------|
| `GITHUB_USERNAME`, `GITHUB_ACCESS_TOKEN`, `GITHUB_PASSWORD` | git push via HTTPS |
| `RENDER_API_KEY` | trigger Render deploys |
| `RESEND_API_KEY` | transactional email (sign-up confirmation) |
| `OPENAI_API_KEY`, `OPENAI_API_BASE`, `OPENAI_LLM_MODEL`, `OPENAI_EMBEDDING_MODEL` | (DeepInfra, currently unused) |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | subscription billing |

Production env vars are set directly in Render's dashboard per service. The
ones the API expects on boot (and will refuse to start without, in prod):
- `SECRET_KEY` (JWT signing)
- `DATABASE_URL` (Postgres)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `ADMIN_SECRET`, `ADMIN_EMAILS` (comma-separated admin users)

---

## 5. Key physics — Bilger-Z bug (fixed 2026-04-20, commit b0ec1b1)

The most recent and most impactful fix. Do not re-introduce.

Cantera's `gas.mixture_fraction(fuel, oxidizer, basis="mass")` returns
**Bilger's** Z, not the physical fuel-stream mass fraction
`Y_f = m_fuel / (m_fuel + m_air)`. The two are equal ONLY if:
1. the oxidizer contains no C/H atoms, AND
2. the fuel stream contains no inert diluent (N2, CO2, Ar, …).

In production neither holds:
- Humid air at 60% RH/25°C carries ~3.11% H2O → Bilger under-counts fuel by ~21 %
- Pipeline NG contains 1–2 % N2 → a further ~17 % under-count

Using Bilger Z as a mass fraction in the two-stream / three-stream enthalpy
balance silently biased T_mixed_inlet_K by tens of K and made T_ad vs WFR
nonphysically steep.

**Fix:** shared helper `fuel_mass_fraction_at_phi(fuel_x, ox_x, phi, mech)` in
`api/app/science/mixture.py`. Computes Y_f stoichiometrically from atom-count
O2 demand `(nC + nH/4 − nO/2)`, `X_O2` in the oxidizer, and the two stream
molecular weights. Both `make_gas_mixed` and `make_gas_mixed_with_water` call
this helper. Do not revert either to `gas.mixture_fraction(...)`.

Regression test pins re-calibrated against an independent Cantera oracle
(`api/tests/_ref_psr_pfr.py`) which was also patched to use the physical Y_f.

---

## 6. How to run locally

Backend:
```
cd api
python3.12 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001
```

Frontend:
```
npm install
npm run dev         # → http://localhost:5173
```

Run the test suite (23 tests, all must pass before committing):
```
cd api
python -m pytest -q
```

Re-derive test pins from the independent oracle (use only after an intentional
physics change):
```
cd api
python -m tests._ref_psr_pfr
```

Production build:
```
npm run build       # → dist/ (what Render serves)
```

---

## 7. Key architectural decisions

**Mechanism choice.** GRI-Mech 3.0 (bundled with Cantera as `gri30.yaml`) is
the default. Glarborg 2018 is shipped in `api/mechanisms/glarborg_2018.yaml`
for richer N-chemistry. Selection is exposed to the user via a mechanism code
and resolved through `MECH_CATALOG` in `mixture.py`. `_normalize_to_mech`
maps fuels the mech doesn't contain (e.g., GRI has no `C4H10`) to combinations
that preserve H/C ratio — see `FUEL_SUBSTITUTIONS` dict.

**PSR + PFR combustor model.** A CSTR (PSR) at user-specified τ feeds a plug
flow at V_PFR m/s over L_PFR. Both use `ct.IdealGasConstPressureReactor` /
`ct.IdealGasReactor` + `ReactorNet`. PSR is cold-ignited with HP equilibration
seed to avoid false convergence at short τ. See `combustor.py::run()`.

**Three-stream water injection.** `make_gas_mixed_with_water` takes
WFR = ṁ_water / ṁ_fuel and does an adiabatic enthalpy balance among fuel
(at T_fuel), oxidizer (at T_air), and water (at 15°C supply for `liquid` or
T_air for `steam`). Liquid uses a linear IAPWS-IF97 h_fg fit valid 273–500 K.
WFR=0 short-circuits to the two-stream `make_gas_mixed` path. Both must give
the same T_mixed in the limit — the Bilger fix was necessary to restore that
continuity.

**Auth + gating.** Bcrypt password hashing + HS256 JWT. `/calc/*` endpoints
require `has_online_access`; otherwise return HTTP 402. Stripe checkout /
billing-portal / webhook update the user's subscription state.

---

## 8. Memory file pointers (auto-memory)

The user's auto-memory (`/sessions/.../mnt/.auto-memory/`) already contains:
- `reference_secrets_file.md` — secrets file location + load pattern
- `reference_render_service_ids.md` — service IDs
- `feedback_render_webhook.md` — reminder that Render doesn't auto-deploy after PAT push

If starting fresh without access to that memory, everything needed is in
section 3 and section 4 above.

---

## 9. Default operating point (user's canonical test case)

Used repeatedly in debugging and in the live UI defaults:

- **Fuel** (pipeline NG): CH4 93.1, C2H6 3.2, C3H8 0.7, C4H10 0.4, CO2 1.0, N2 1.6 (mol%)
- **Oxidizer** (humid air @ 60% RH, 25°C): O2 20.29, N2 75.67, Ar 0.9, CO2 0.03, H2O 3.11
- **phi:** 0.555
- **P:** 400 psia (≈ 27.58 bar)
- **T_fuel:** 70 °F (294.26 K)
- **T_air:** 1000 °F (810.93 K)

Post-fix expected T_ad vs WFR (liquid water @ 15°C supply) — useful as a
smoke test:

| WFR | T_mixed (K) | T_ad (K) | ΔT_ad |
|-----|-------------|----------|-------|
| 0.0 | 770.1       | 1917.8   | 0     |
| 0.2 | 752.3       | 1890.9   | 27    |
| 1.0 | 684.2       | 1788.8   | 129   |

If the live app diverges materially from these, something regressed.

---

## 10. Gotchas / non-obvious behaviors

- **Render + PAT pushes don't auto-deploy.** See section 3.
- **GRI-Mech lacks C4H10+.** `_normalize_to_mech` substitutes; accurate enough
  for < 2 mol% of the fuel.
- **C3H8 → C2H6 on Glarborg.** Glarborg has no C3 species; the substitution
  loses one C-atom per mol. Fine for trace amounts.
- **`mixture_fraction(...)` is Bilger's Z.** Never use it as a mass fraction
  in an enthalpy balance. See section 5.
- **Gunicorn timeout in prod is 600 s** (long Cantera sweeps). Match this
  with the frontend `useBackendCalc` request timeout; otherwise the user
  sees a client timeout while the server is still computing.
- **Desktop license-token path.** The Electron build ships a hardened runtime;
  `/desktop/activate` issues an offline JWT consumed via `X-License-Token`
  header. If auth behavior looks weird in dev, make sure you're running the
  web-app flow, not the desktop flow.
- **CORS.** API is locked to the two Render origins + `localhost:5173` /
  `localhost:5174`. Adding a new origin requires a prod env var update.

---

## 11. Quickstart for a brand-new session

If this session is lost and you're a fresh Claude picking up the repo:

1. Clone: `git clone https://github.com/bmsabry/combustion-toolkit.git`
2. Read this file (`SESSION_RECOVERY.md`).
3. Load secrets from the user's uploads folder (section 4).
4. Run `cd api && python -m pytest -q` — all 23 tests must pass.
5. If the user asks about the physics, especially water injection or humid
   air, re-read section 5.
6. Before deploying, remember section 3 (manual Render POST after push).
