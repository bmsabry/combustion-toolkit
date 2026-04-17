"""Laminar flame speed via Cantera 1D freely-propagating premixed flame."""
from __future__ import annotations

from typing import Dict

import cantera as ct
import numpy as np

from .mixture import make_gas


def run(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    phi: float,
    T0_K: float,
    P_bar: float,
    domain_length_m: float = 0.03,
) -> dict:
    """Solve a 1D freely-propagating premixed flame and return burning velocity + T(x)."""
    gas, _, _ = make_gas(fuel_pct, ox_pct, phi, T0_K, P_bar)

    flame = ct.FreeFlame(gas, width=domain_length_m)
    flame.set_refine_criteria(ratio=3.0, slope=0.08, curve=0.15)
    flame.transport_model = "mixture-averaged"
    # Initial solve without energy equation for stable start
    flame.energy_enabled = False
    try:
        flame.solve(loglevel=0, refine_grid=False, auto=True)
    except Exception:
        pass
    flame.energy_enabled = True
    flame.solve(loglevel=0, refine_grid=True, auto=True)

    SL = float(flame.velocity[0])
    T = flame.T
    x = flame.grid
    # flame thickness δ = (T_b - T_u) / max(|dT/dx|)
    dTdx = np.gradient(T, x)
    thickness = float((T.max() - T.min()) / max(abs(dTdx).max(), 1e-9))

    # Downsample profile to <=200 points for the frontend
    n = len(x)
    step = max(1, n // 200)
    x_out = x[::step].tolist()
    T_out = T[::step].tolist()

    return {
        "SL": SL,
        "flame_thickness": thickness,
        "T_max": float(T.max()),
        "T_profile": T_out,
        "x_profile": x_out,
        "grid_points": int(n),
    }
