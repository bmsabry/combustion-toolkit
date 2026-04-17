# Combustion Engineering Toolkit

Free, browser-based combustion engineering calculator by **ProReadyEngineer LLC**.

**Live:** https://combustion-toolkit.proreadyengineer.com

## What this is

The free online version of the Combustion Toolkit. It runs entirely in the browser
(no backend) and uses a simplified thermodynamic model with NASA 7-coefficient
polynomials, a Newton-Raphson equilibrium solver, and Gülder flame-speed
correlations.

**Five panels:**
- Adiabatic Flame Temperature (frozen + equilibrium)
- Laminar Flame Speed & Blowoff
- PSR → PFR Combustor Network with Zeldovich NOx
- Exhaust Analysis (from measured O2 or CO2)
- Thermo Database (NASA-7 coefficients)

## Scope & limits

The free version is **limited to φ ≤ 1.0 (lean and stoichiometric)**.
It is **not suitable for RQL, SAC, or other rich/staged combustion systems** —
the simplified model diverges from real kinetics under rich conditions.

For accurate Cantera-backed results across the full φ range (including rich
mixtures for RQL/SAC), see the paid tiers below.

## Tiers

| Tier | Price | What you get |
|---|---|---|
| **Free** | $0 | Online simplified version (this repo), φ ≤ 1.0 |
| **Accurate — Download** | $100/yr | Desktop app (macOS/Windows/Linux) with bundled Cantera |
| **Download + Online** | $150/yr | Desktop app + access to online Cantera API |

Subscriptions are renewed via honor system — no DRM, no activation server.

## Develop locally

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # outputs to dist/
```

## Stack

- React 19 + Vite 8
- SheetJS (`xlsx`) for Excel export
- Deployed as a static site on Render

## License

Proprietary — ProReadyEngineer LLC. All rights reserved.
