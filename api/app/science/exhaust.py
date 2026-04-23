"""Inverse exhaust analysis: given measured O2 or CO2 (dry), find phi + exhaust composition."""
from __future__ import annotations

from typing import Dict, Optional

import cantera as ct
import numpy as np
from scipy.optimize import brentq

from .complete_combustion import run as complete_combustion_run
from .mixture import compute_ratios, make_gas, make_gas_mixed
from .water_mix import make_gas_mixed_with_water


def _equilibrium_at_phi(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    phi: float,
    T0: float,
    P_bar: float,
    mode: str,
    T_fuel_K: Optional[float] = None,
    T_air_K: Optional[float] = None,
    WFR: float = 0.0,
    water_mode: str = "liquid",
) -> tuple:
    """Return (gas_at_equilibrium, T_mixed_inlet_K). If T_fuel/T_air provided,
    the adiabatic mix T is used as the pre-combustion inlet T; otherwise T0."""
    T_f = float(T_fuel_K) if T_fuel_K is not None else float(T0)
    T_a = float(T_air_K) if T_air_K is not None else float(T0)
    if WFR and WFR > 0:
        gas, _, _, T_mixed, _Y_w = make_gas_mixed_with_water(
            fuel_pct, ox_pct, phi, T_f, T_a, P_bar, WFR, water_mode
        )
    elif T_fuel_K is not None or T_air_K is not None:
        gas, _, _, T_mixed = make_gas_mixed(fuel_pct, ox_pct, phi, T_f, T_a, P_bar)
    else:
        gas, _, _ = make_gas(fuel_pct, ox_pct, phi, T0, P_bar)
        T_mixed = float(T0)
    # mode currently collapses to HP equilibrium either way (previous behavior)
    gas.equilibrate("HP")
    return gas, T_mixed


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
    T_fuel_K: Optional[float] = None,
    T_air_K: Optional[float] = None,
    WFR: float = 0.0,
    water_mode: str = "liquid",
) -> dict:
    """Given a measurement of either O2 or CO2 in dry exhaust, invert to find phi and return full exhaust state.

    If T_fuel_K / T_air_K are provided, the pre-combustion mixture T is the
    adiabatic enthalpy-balance mix of the two streams. Otherwise both default to T0_K.
    WFR > 0 enables 3-stream water injection (liquid or steam).
    """
    if measured_O2_pct_dry is None and measured_CO2_pct_dry is None:
        raise ValueError("Provide measured_O2_pct_dry or measured_CO2_pct_dry")

    # Binary search phi in [0.1, 1.5]
    def delta_O2(phi: float) -> float:
        gas, _ = _equilibrium_at_phi(
            fuel_pct, ox_pct, phi, T0_K, P_bar, combustion_mode, T_fuel_K, T_air_K,
            WFR, water_mode,
        )
        return _dry_frac(gas, "O2") * 100.0 - (measured_O2_pct_dry or 0)

    def delta_CO2(phi: float) -> float:
        gas, _ = _equilibrium_at_phi(
            fuel_pct, ox_pct, phi, T0_K, P_bar, combustion_mode, T_fuel_K, T_air_K,
            WFR, water_mode,
        )
        return _dry_frac(gas, "CO2") * 100.0 - (measured_CO2_pct_dry or 0)

    method = "O2" if measured_O2_pct_dry is not None else "CO2"
    try:
        if method == "O2":
            phi = brentq(delta_O2, 0.1, 1.5, xtol=1e-4, maxiter=50)
        else:
            phi = brentq(delta_CO2, 0.1, 1.5, xtol=1e-4, maxiter=50)
    except Exception:
        phi = 0.5  # fallback

    gas, T_mixed = _equilibrium_at_phi(
        fuel_pct, ox_pct, phi, T0_K, P_bar, combustion_mode, T_fuel_K, T_air_K,
        WFR, water_mode,
    )
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

    # --- Parallel inversion under the complete-combustion assumption -------
    # Measured exhaust gas — if read at the gas turbine STACK or after
    # dilution — has cooled well below any dissociation regime, so CO2, H2O,
    # O2, N2 are stable and the equilibrium dissociation products (CO, OH,
    # H, O, NO) are at trace level. Complete combustion is therefore the
    # more physical assumption for those measurement locations, whereas
    # equilibrium is only appropriate right at the flame with no dilution
    # (combustor_air_frac = 1). We invert phi against the measurement under
    # BOTH assumptions and report both to the user so they can pick.
    def _cc_dry_frac(phi_val: float, species: str) -> float:
        try:
            r = complete_combustion_run(
                fuel_pct, ox_pct, phi_val,
                T_fuel_K=T_fuel_K if T_fuel_K is not None else T0_K,
                T_air_K=T_air_K if T_air_K is not None else T0_K,
                P_bar=P_bar, WFR=WFR, water_mode=water_mode,
            )
            return float(r["mole_fractions_dry"].get(species, 0.0))
        except Exception:
            return 0.0

    def delta_O2_cc(p: float) -> float:
        return _cc_dry_frac(p, "O2") * 100.0 - (measured_O2_pct_dry or 0)

    def delta_CO2_cc(p: float) -> float:
        return _cc_dry_frac(p, "CO2") * 100.0 - (measured_CO2_pct_dry or 0)

    try:
        if method == "O2":
            phi_cc = brentq(delta_O2_cc, 0.1, 1.5, xtol=1e-4, maxiter=50)
        else:
            phi_cc = brentq(delta_CO2_cc, 0.1, 1.5, xtol=1e-4, maxiter=50)
    except Exception:
        phi_cc = float(phi)

    try:
        r_cc = complete_combustion_run(
            fuel_pct, ox_pct, phi_cc,
            T_fuel_K=T_fuel_K if T_fuel_K is not None else T0_K,
            T_air_K=T_air_K if T_air_K is not None else T0_K,
            P_bar=P_bar, WFR=WFR, water_mode=water_mode,
        )
        cc_block = {
            "phi": float(phi_cc),
            "FAR": float(r_cc["FAR"]),
            "AFR": float(r_cc["AFR"]),
            "T_ad": float(r_cc["T_ad"]),
            "T_mixed_inlet_K": float(r_cc["T_mixed_inlet_K"]),
            "exhaust_composition_wet": {s: float(v) for s, v in r_cc["mole_fractions"].items()},
            "exhaust_composition_dry": {s: float(v) for s, v in r_cc["mole_fractions_dry"].items()},
            "O2_pct_dry": float(r_cc["O2_pct_dry"]),
            "CO2_pct_dry": float(r_cc["CO2_pct_dry"]),
            "CO_pct_dry": float(r_cc.get("CO_pct_dry", 0.0)),
            "H2O_pct_wet": float(r_cc["H2O_pct_wet"]),
        }
    except Exception:
        cc_block = {}

    return {
        "phi": phi,
        "FAR": FAR,
        "AFR": AFR,
        "T_ad": float(gas.T),
        "T_mixed_inlet_K": float(T_mixed),
        "exhaust_composition_wet": wet,
        "exhaust_composition_dry": dry,
        "O2_pct_dry": _dry_frac(gas, "O2") * 100.0,
        "CO2_pct_dry": _dry_frac(gas, "CO2") * 100.0,
        "H2O_pct_wet": h2o_x * 100.0,
        "method": method,
        # Complete-combustion companion (the physically correct assumption
        # for stack or diluted-exit measurements).
        "complete_combustion": cc_block,
    }
