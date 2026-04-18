"""Cantera-backed sweeps for the Flame Speed panel.

Runs a 1D FreeFlame solve at each point in a grid — slow (5–15 s per point) but
faithful to the kinetics and transport of the actual mixture. Used in Accurate
mode so the SL-vs-φ / SL-vs-T / SL-vs-P curves show real H₂ physics (rich peak
past φ=1, true pressure exponent, etc.) instead of a hydrocarbon correlation
scaled to the current operating point.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from .flame_speed import run as _free_flame_run


def run(
    sweep_var: str,                    # "phi" | "P" | "T"
    sweep_values: List[float],
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    phi: float,
    T0_K: float,
    P_bar: float,
    T_fuel_K: Optional[float] = None,
    T_air_K: Optional[float] = None,
    domain_length_m: float = 0.03,
) -> dict:
    """Run FreeFlame at each sweep value, holding other params at the baseline.

    For sweep_var="T", T0_K becomes the sweep value and T_fuel_K/T_air_K are
    overridden to the same value (so the mixture inlet T exactly equals the
    swept T — this is the natural "unburnt-T sweep" interpretation).
    """
    if sweep_var not in ("phi", "P", "T"):
        raise ValueError(f"sweep_var must be phi, P, or T; got {sweep_var!r}")

    points: List[dict] = []
    for v in sweep_values:
        if sweep_var == "phi":
            args = dict(
                fuel_pct=fuel_pct, ox_pct=ox_pct, phi=float(v),
                T0_K=T0_K, P_bar=P_bar, domain_length_m=domain_length_m,
                T_fuel_K=T_fuel_K, T_air_K=T_air_K,
            )
        elif sweep_var == "P":
            args = dict(
                fuel_pct=fuel_pct, ox_pct=ox_pct, phi=phi,
                T0_K=T0_K, P_bar=float(v), domain_length_m=domain_length_m,
                T_fuel_K=T_fuel_K, T_air_K=T_air_K,
            )
        else:  # T
            args = dict(
                fuel_pct=fuel_pct, ox_pct=ox_pct, phi=phi,
                T0_K=float(v), P_bar=P_bar, domain_length_m=domain_length_m,
                T_fuel_K=float(v), T_air_K=float(v),
            )
        try:
            r = _free_flame_run(**args)
            points.append({
                "x": float(v),
                "SL": float(r["SL"]),
                "T_mixed_inlet_K": float(r.get("T_mixed_inlet_K", T0_K)),
                "alpha_th_u": float(r.get("alpha_th_u", 0.0)),
                "converged": True,
            })
        except Exception as e:  # noqa: BLE001
            # Point failed to converge — log and continue with the rest of the sweep.
            points.append({
                "x": float(v),
                "SL": 0.0,
                "T_mixed_inlet_K": 0.0,
                "alpha_th_u": 0.0,
                "converged": False,
                "error": str(e)[:120],
            })

    return {
        "sweep_var": sweep_var,
        "points": points,
    }
