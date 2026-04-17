"""Inverse exhaust analysis: given measured O2 or CO2 (dry), find phi + exhaust composition."""
from __future__ import annotations

from typing import Dict, Optional

import cantera as ct
import numpy as np
from scipy.optimize import brentq

from .mixture import compute_ratios, make_gas


def _equilibrium_at_phi(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    phi: float,
    T0: float,
    P_bar: float,
    mode: str,
) -> ct.Solution:
    gas, _, _ = make_gas(fuel_pct, ox_pct, phi, T0, P_bar)
    if mode == "complete":
        # Freeze at low-T complete products ≈ equilibrate at T=T0 then TP-eq at 1500K
        gas.equilibrate("HP")
        return gas
    else:
        gas.equilibrate("HP")
        return gas


def _dry_frac(gas: ct.Solution, species: str) -> float:
    idx = gas.species_index(species)
    h2o_idx = gas.species_index("H2O")
    if idx < 0:
        return 0.0
    X = np.array(gas.X, dtype=float)
    if h2o_idx >= 0:
        X[h2o_idx] = 0.0
    s = X.sum()
    return float(X[idx] / s) if s > 0 else 0.0


def run(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    T0_K: float,
    P_bar: float,
    measured_O2_pct_dry: Optional[float] = None,
    measured_CO2_pct_dry: Optional[float] = None,
    combustion_mode: str = "equilibrium",
) -> dict:
    """Given a measurement of either O2 or CO2 in dry exhaust, invert to find phi and return full exhaust state."""
    if measured_O2_pct_dry is None and measured_CO2_pct_dry is None:
        raise ValueError("Provide measured_O2_pct_dry or measured_CO2_pct_dry")

    # Binary search phi in [0.1, 1.5]
    def delta_O2(phi: float) -> float:
        gas = _equilibrium_at_phi(fuel_pct, ox_pct, phi, T0_K, P_bar, combustion_mode)
        return _dry_frac(gas, "O2") * 100.0 - (measured_O2_pct_dry or 0)

    def delta_CO2(phi: float) -> float:
        gas = _equilibrium_at_phi(fuel_pct, ox_pct, phi, T0_K, P_bar, combustion_mode)
        return _dry_frac(gas, "CO2") * 100.0 - (measured_CO2_pct_dry or 0)

    method = "O2" if measured_O2_pct_dry is not None else "CO2"
    try:
        if method == "O2":
            phi = brentq(delta_O2, 0.1, 1.5, xtol=1e-4, maxiter=50)
        else:
            phi = brentq(delta_CO2, 0.1, 1.5, xtol=1e-4, maxiter=50)
    except Exception:
        phi = 0.5  # fallback

    gas = _equilibrium_at_phi(fuel_pct, ox_pct, phi, T0_K, P_bar, combustion_mode)
    FAR, FAR_stoich, AFR, AFR_stoich = compute_ratios(fuel_pct, ox_pct, phi)

    wet = {s: float(x) for s, x in zip(gas.species_names, gas.X) if x > 1e-10}
    # Dry: remove H2O, renormalize
    X_dry = np.array(gas.X, dtype=float)
    h2o_idx = gas.species_index("H2O")
    h2o_x = float(X_dry[h2o_idx]) if h2o_idx >= 0 else 0.0
    if h2o_idx >= 0:
        X_dry[h2o_idx] = 0.0
    s = X_dry.sum()
    X_dry = X_dry / s if s > 0 else X_dry
    dry = {s: float(x) for s, x in zip(gas.species_names, X_dry) if x > 1e-10}

    return {
        "phi": phi,
        "FAR": FAR,
        "AFR": AFR,
        "T_ad": float(gas.T),
        "exhaust_composition_wet": wet,
        "exhaust_composition_dry": dry,
        "O2_pct_dry": _dry_frac(gas, "O2") * 100.0,
        "CO2_pct_dry": _dry_frac(gas, "CO2") * 100.0,
        "H2O_pct_wet": h2o_x * 100.0,
        "method": method,
    }
