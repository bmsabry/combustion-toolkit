"""PSR → PFR combustor network using Cantera ReactorNet."""
from __future__ import annotations

from typing import Dict, List

import cantera as ct
import numpy as np

from .mixture import make_gas


def _ppm_vd(gas: ct.Solution, species: str) -> float:
    """ppm, volumetric, dry (water removed) for the given species."""
    idx = gas.species_index(species)
    if idx < 0:
        return 0.0
    h2o_idx = gas.species_index("H2O")
    X = np.array(gas.X, dtype=float)
    if h2o_idx >= 0:
        X[h2o_idx] = 0.0
    s = X.sum()
    if s <= 0:
        return 0.0
    X_dry = X / s
    return float(X_dry[idx] * 1e6)


def _o2_pct_dry(gas: ct.Solution) -> float:
    idx = gas.species_index("O2")
    if idx < 0:
        return 0.0
    h2o_idx = gas.species_index("H2O")
    X = np.array(gas.X, dtype=float)
    if h2o_idx >= 0:
        X[h2o_idx] = 0.0
    s = X.sum()
    return float(X[idx] / s * 100.0) if s > 0 else 0.0


def run(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    phi: float,
    T0_K: float,
    P_bar: float,
    tau_psr_s: float,
    L_pfr_m: float,
    V_pfr_m_s: float,
    profile_points: int = 60,
) -> dict:
    """PSR then PFR. Returns emissions at PSR exit and PFR exit, plus a profile."""
    gas, _, _ = make_gas(fuel_pct, ox_pct, phi, T0_K, P_bar)

    # Mass flow rate — set via reservoir+mass-flow-controller approach
    # Use an upstream reservoir at inlet state, a PSR reactor with constant mass, and an outlet reservoir
    inlet_gas = ct.Solution("gri30.yaml")
    inlet_gas.TPX = gas.T, gas.P, gas.X
    upstream = ct.Reservoir(inlet_gas)

    # PSR reactor: start near equilibrium to avoid blow-out at short tau
    psr_gas = ct.Solution("gri30.yaml")
    psr_gas.TPX = gas.T, gas.P, gas.X
    psr_gas.equilibrate("HP")  # warm start
    psr = ct.IdealGasReactor(psr_gas, energy="on")

    downstream = ct.Reservoir(psr_gas)

    # Mass flow rate from residence time: mdot = rho * V / tau
    # V chosen arbitrarily (reactor volume); here we use 1 L as reference, so mdot = rho * 0.001 / tau
    V_psr = 1.0e-3  # m³ — scales with mdot, irrelevant to steady state
    mdot = psr_gas.density * V_psr / max(tau_psr_s, 1e-9)

    mfc = ct.MassFlowController(upstream=upstream, downstream=psr, mdot=mdot)
    out = ct.PressureController(upstream=psr, downstream=downstream, primary=mfc, K=1e-5)

    net = ct.ReactorNet([psr])
    try:
        net.advance_to_steady_state()
    except Exception:
        # If steady-state fails, integrate long enough
        net.advance(tau_psr_s * 100)

    T_psr = float(psr.thermo.T)
    NO_psr = _ppm_vd(psr.thermo, "NO")
    CO_psr = _ppm_vd(psr.thermo, "CO")
    O2_psr = _o2_pct_dry(psr.thermo)
    # crude conversion measure: fraction of fuel consumed — use CO+CO2 vs CH4 residual
    fuel_idx = [psr.thermo.species_index(s) for s in ("CH4", "C2H6", "C3H8", "H2") if psr.thermo.species_index(s) >= 0]
    fuel_left = float(sum(psr.thermo.Y[i] for i in fuel_idx))
    # Reference fuel mass fraction in inlet:
    inlet_fuel = float(sum(inlet_gas.Y[i] for i in fuel_idx))
    conv_psr = 1.0 - fuel_left / max(inlet_fuel, 1e-20)
    conv_psr = max(0.0, min(1.0, conv_psr))

    # ---- PFR: solve an ideal plug-flow reactor along length L_pfr at velocity V_pfr ----
    pfr_gas = ct.Solution("gri30.yaml")
    pfr_gas.TPX = psr.thermo.T, psr.thermo.P, psr.thermo.X
    tau_pfr_s = L_pfr_m / max(V_pfr_m_s, 1e-9)
    dt = tau_pfr_s / max(profile_points - 1, 1)

    # Constant-pressure PFR modeled as an IdealGasConstPressureReactor stepping in time
    pfr_reactor = ct.IdealGasConstPressureReactor(pfr_gas, energy="on")
    pfr_net = ct.ReactorNet([pfr_reactor])

    # Build profile including PSR starting point so frontend can span the whole combustor
    L_psr_equiv_cm = (tau_psr_s * V_pfr_m_s) * 100.0  # "equivalent length" so x-axis is consistent
    profile: List[dict] = [
        {
            "x": 0.0,
            "T": float(inlet_gas.T),
            "NO_ppm": 0.0,
            "CO_ppm": 0.0,
            "conv": 0.0,
        },
        {
            "x": L_psr_equiv_cm,
            "T": T_psr,
            "NO_ppm": NO_psr,
            "CO_ppm": CO_psr,
            "conv": conv_psr * 100.0,
        },
    ]

    t = 0.0
    for i in range(1, profile_points):
        t_new = dt * i
        try:
            pfr_net.advance(t_new)
        except Exception:
            break
        x_cm = L_psr_equiv_cm + (t_new / tau_pfr_s) * (L_pfr_m * 100.0)
        T_i = float(pfr_reactor.thermo.T)
        NO_i = _ppm_vd(pfr_reactor.thermo, "NO")
        CO_i = _ppm_vd(pfr_reactor.thermo, "CO")
        fuel_left_i = float(sum(pfr_reactor.thermo.Y[j] for j in fuel_idx))
        conv_i = 1.0 - fuel_left_i / max(inlet_fuel, 1e-20)
        profile.append(
            {
                "x": x_cm,
                "T": T_i,
                "NO_ppm": NO_i,
                "CO_ppm": CO_i,
                "conv": max(0.0, min(100.0, conv_i * 100.0)),
            }
        )

    T_exit = profile[-1]["T"]
    NO_exit = profile[-1]["NO_ppm"]
    CO_exit = profile[-1]["CO_ppm"]
    conv_exit = profile[-1]["conv"] / 100.0

    # NOx / CO corrected to 15% O2 dry
    O2_exit = _o2_pct_dry(pfr_reactor.thermo)
    corr = (20.95 - 15.0) / max(20.95 - O2_exit, 1e-6)
    NO_15 = NO_exit * corr
    CO_15 = CO_exit * corr

    return {
        "T_psr": T_psr,
        "T_exit": T_exit,
        "NO_ppm_vd_psr": NO_psr,
        "NO_ppm_vd_exit": NO_exit,
        "CO_ppm_vd_psr": CO_psr,
        "CO_ppm_vd_exit": CO_exit,
        "NO_ppm_15O2": NO_15,
        "CO_ppm_15O2": CO_15,
        "O2_pct_dry_psr": O2_psr,
        "O2_pct_dry_exit": O2_exit,
        "conv_psr": conv_psr * 100.0,
        "conv_exit": conv_exit * 100.0,
        "tau_psr_ms": tau_psr_s * 1000.0,
        "tau_pfr_ms": tau_pfr_s * 1000.0,
        "tau_total_ms": (tau_psr_s + tau_pfr_s) * 1000.0,
        "L_psr_cm": L_psr_equiv_cm,
        "L_pfr_cm": L_pfr_m * 100.0,
        "L_total_cm": L_psr_equiv_cm + L_pfr_m * 100.0,
        "profile": profile,
    }
