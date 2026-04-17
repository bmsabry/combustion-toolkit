"""Full NASA-7 thermophysical properties for arbitrary mixtures using Cantera."""
from __future__ import annotations

from typing import Dict

import cantera as ct

from .mixture import _normalize_to_gri


def run(mixture_pct_or_frac: Dict[str, float], T_K: float, P_bar: float) -> dict:
    """Compute rho, cp, mu, k, Pr, a, h, s, g at (T, P) for the given mixture."""
    gas = ct.Solution("gri30.yaml")
    # Accept either mole% (sum ≈ 100) or mole fractions (sum ≈ 1). Normalize.
    total = sum(mixture_pct_or_frac.values())
    if total > 10:  # assume percent
        frac = _normalize_to_gri(mixture_pct_or_frac)
    else:
        frac = {k: v for k, v in mixture_pct_or_frac.items() if v > 0}
        s = sum(frac.values())
        frac = {k: v / s for k, v in frac.items()} if s > 0 else frac

    x_str = ", ".join(f"{k}:{v:.10f}" for k, v in frac.items() if k in gas.species_names)
    if not x_str:
        raise ValueError("No recognized species in mixture")
    gas.TPX = float(T_K), float(P_bar) * 1e5, x_str

    gas.transport_model = "mixture-averaged"
    mu = float(gas.viscosity)
    k = float(gas.thermal_conductivity)
    cp = float(gas.cp_mass)
    cv = float(gas.cv_mass)
    gamma = cp / cv if cv > 0 else 0.0
    pr = mu * cp / k if k > 0 else 0.0
    sound = float(gas.sound_speed)
    return {
        "T": float(gas.T),
        "P": float(gas.P) / 1e5,  # bar
        "mw": float(gas.mean_molecular_weight),
        "density": float(gas.density),
        "cp": cp,
        "cv": cv,
        "gamma": gamma,
        "viscosity": mu,
        "thermal_conductivity": k,
        "prandtl": pr,
        "sound_speed": sound,
        "enthalpy": float(gas.enthalpy_mass),
        "entropy": float(gas.entropy_mass),
        "gibbs": float(gas.gibbs_mass),
    }
