# Phase 2 status — overnight run

Date: 2026-04-17

## What's live

### Backend — combustion-toolkit-api
- URL: https://combustion-toolkit-api.onrender.com
- Health: https://combustion-toolkit-api.onrender.com/health → `{"status":"ok","cantera_version":"3.2.0",...}`
- Repo: github.com/bmsabry/combustion-toolkit, `api/` subdir, branch `main`
- Runtime: Python 3.12.7 (pinned in `api/.python-version`), starter plan on Render
- Components mounted:
  - `/auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/me` — bcrypt + JWT
  - `/billing/subscription`, `/billing/checkout`, `/billing/portal`, `/billing/webhook`
  - `/billing/license-keys`, `/billing/license-keys/generate`
  - `/desktop/activate` — offline license token issuer
  - `/calc/aft`, `/calc/flame-speed`, `/calc/combustor`, `/calc/exhaust`, `/calc/props`
  - All `/calc/*` gated on `has_online_access` → return HTTP 402 if user isn't on the Full tier

### Frontend — combustion-toolkit.onrender.com
- URL: https://combustion-toolkit.onrender.com
- Repo: github.com/bmsabry/combustion-toolkit, `src/`, branch `main`
- New in this build:
  - `src/api.js` — REST client with localStorage JWT + auto-refresh
  - `src/auth.jsx` — `AuthProvider` + `AuthModal` (login / signup)
  - `src/AccountPanel.jsx` — account dashboard (subscription status, Stripe portal,
    license key generation, desktop installer links)
  - `src/App.jsx` — header SIGN IN button, Account tab, **ACCURATE** toggle,
    `useBackendCalc` hook, and accurate-mode wiring on every panel (AFT / Flame
    Speed / Combustor / Exhaust with live `⟳ CANTERA…` / `✓ CANTERA` badges)
  - Stripe redirect PricingModal (replaces the old placeholder)

## Needs your attention

### 1. Stripe keys (blocker for paid flow)
The Render service has empty Stripe env vars. Until you paste real values,
`/billing/subscription` still works (free-tier users), `/billing/checkout` errors,
and `stripe_configured: false` shows in `/health`.

Go to **Render Dashboard → combustion-toolkit-api → Environment** and fill:
- `STRIPE_SECRET_KEY` — `sk_live_...` (or `sk_test_...` for testing first)
- `STRIPE_PUBLISHABLE_KEY` — `pk_live_...`
- `STRIPE_WEBHOOK_SECRET` — `whsec_...` (create after registering the webhook URL
  `https://combustion-toolkit-api.onrender.com/billing/webhook` in Stripe)
- `STRIPE_PRICE_ID_DOWNLOAD` — your $100/yr price ID
- `STRIPE_PRICE_ID_FULL` — your $150/yr price ID

The service re-reads env vars on restart — click **Manual Deploy → Deploy latest**
after saving.

### 2. Register the Stripe webhook
In the Stripe Dashboard → Developers → Webhooks, add endpoint:
- URL: `https://combustion-toolkit-api.onrender.com/billing/webhook`
- Events: `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`
- Copy the signing secret → paste into `STRIPE_WEBHOOK_SECRET`.

### 3. Desktop build (manual — requires native toolchains)
The repo contains `desktop/` with everything needed, but the PyInstaller build
has to run on each target OS. Recipe on a machine with Python 3.12 + Node 20+:

```bash
cd desktop
npm install
npm run build:ui                     # copies ../dist → desktop/ui/
export CTK_BAKED_SIGNING_KEY=...     # same as Render's LICENSE_SIGNING_KEY
npm run build:solver                 # ./solver-dist/ctk-solver
npm run dist                         # ./dist/Combustion Toolkit-0.1.0.dmg (etc)
```

Retrieve `LICENSE_SIGNING_KEY` from Render dashboard → envs → reveal.
See `desktop/README.md` for the full architecture and dev-mode recipe.

### 4. Desktop download links (placeholder)
`src/AccountPanel.jsx` points to `/downloads/CombustionToolkit-mac.dmg` etc.
Once you build the installers, upload them to S3 (or any CDN) and swap the
hrefs — I left them as relative `/downloads/...` paths so you can just drop
files into `public/downloads/` on the frontend repo and redeploy.

## Verified (automated smoke test run)

```
signup  smoke-1776417104@example.com           → 201, JWTs returned
/auth/me                                        → 200, user row
/billing/subscription                           → 200, tier=free, no access
/calc/aft (no subscription, bearer token only) → 402, "requires Full tier"
/desktop/activate (garbage key)                 → 404, "Invalid or revoked license key"
/health                                         → 200, cantera 3.2.0
```

Manual tests still worth running:
- Sign up via the web UI and check the Account tab renders
- Click "Subscribe $150/yr" → verify Stripe test-mode checkout opens (blocked until step 1 above)
- Complete a test checkout and confirm the ACCURATE toggle becomes enabled
- Flip ACCURATE on in the AFT panel and watch the status badge flip to `✓ CANTERA`

## Tasks

- [x] Scaffold FastAPI backend (auth, billing, calc, desktop routers)
- [x] Port JS science to Cantera (aft, flame_speed, combustor, exhaust, props)
- [x] Stripe subscription + webhook flow
- [x] Deploy backend to Render (Python 3.12 pinned — 3.14 default was building numpy/scipy from source and stalling)
- [x] Frontend auth + subscription gating + accurate-mode wiring
- [x] Electron desktop scaffold (main.js, preload, activation.html, PyInstaller build script)
- [x] End-to-end smoke test

## Known gaps / follow-ups

- `src/App.jsx` PropsPanel still runs the local NASA-polynomial implementation
  when ACCURATE is on. Cantera gives almost identical numbers in this range,
  so low priority — wire it the same way as the others when convenient.
- Desktop installers are **unsigned**. First-launch OS warnings are expected;
  the Account panel already warns users. If you want code-signing later:
  - macOS: ~$99/yr Apple Developer, plus a notarization run.
  - Windows: OV code-signing cert ~$300/yr, or EV ~$500/yr.
- The `ctk-solver` binary is ~150-200 MB due to Cantera + scipy + numpy.
  If that's too big, Electron could fall back to talking to the cloud when
  the user has an internet connection — the frontend already does that when
  `__CTK_API_BASE__` is unset.
- `X-License-Token` header — `src/api.js` currently only sends `Authorization: Bearer <jwt>`.
  In desktop mode there's no JWT but there *is* a license token. Simplest fix:
  have `desktop/preload.js` stash the token into `window.__CTK_LICENSE_TOKEN__`
  and update `src/api.js` to send it as `X-License-Token` when present.
  (The solver already reads the token from env; this header path is just for
  defense in depth in case someone swaps binaries.)
