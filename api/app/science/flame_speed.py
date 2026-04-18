"""Laminar flame speed via Cantera 1D freely-propagating premixed flame."""
from __future__ import annotations

from typing import Dict, Optional

import cantera as ct
import numpy as np

from .mixture import make_gas, make_gas_mixed


def run(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    phi: float,
    T0_K: float,
    P_bar: float,
    domain_length_m: float = 0.03,
    T_fuel_K: Optional[float] = None,
    T_air_K: Optional[float] = None,
) -> dict:
    """Solve a 1D freely-propagating premixed flame and return burning velocity + T(x).

    If T_fuel_K / T_air_K are provided, the unburnt-mixture temperature is the
    adiabatic enthalpy-balance mix of the two streams. Otherwise both default
    to T0_K.
    """
    T_f = float(T_fuel_K) if T_fuel_K is not None else float(T0_K)
    T_a = float(T_air_K) if T_air_K is not None else float(T0_K)
    if T_fuel_K is not None or T_air_K is not None:
        gas, _, _, T_mixed = make_gas_mixed(fuel_pct, ox_pct, phi, T_f, T_a, P_bar)
    else:
        gas, _, _ = make_gas(fuel_pct, ox_pct, phi, T0_K, P_bar)
        T_mixed = float(T0_K)

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
        "T_mixed_inlet_K": float(T_mixed),
        "T_profile": T_out,
        "x_profile": x_out,
        "grid_points": int(n),
    }
