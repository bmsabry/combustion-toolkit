"""PSR → PFR combustor network using Cantera ReactorNet.

PSR seeding strategy (cold-ignited):
    The PSR is seeded with the HP-equilibrium state of the inlet mixture with
    all NOx-family species zeroed out. This represents an ignited primary zone
    where NOx has not yet formed — NO then builds up kinetically via the
    Zeldovich mechanism as the reactor is integrated forward in time. This
    avoids the bias of a naive `equilibrate("HP")` warm start, which seeds NO
    already near its (very high) equilibrium level and can leave the reactor
    stuck near that value at short residence times.

Integration strategy:
    Instead of `advance_to_steady_state()` (which can return prematurely with
    Zeldovich-dominated reactors), we advance explicitly in chunks and check
    for true convergence of both T and NO. The solver keeps stepping until
    the state stabilizes or a safety cap is hit.

Fuel/air temperatures:
    Fuel and air can be provided at different temperatures. They are mixed
    adiabatically (enthalpy-weighted) before being fed to the PSR reservoir.
    If T_fuel == T_air, the mix reduces to the previous single-inlet behavior.
"""
from __future__ import annotations

import time
from typing import Dict, List, Optional

import cantera as ct
import numpy as np

from .mixture import make_gas_mixed


# NOx-family species to zero out in the cold-ignited warm start.
_NOX_FAMILY = (
    "NO", "NO2", "N2O", "N",
    "NH", "NH2", "NH3", "NNH", "HNO",
    "CN", "HCN", "H2CN", "HCNN", "HCNO", "HOCN", "HNCO", "NCO",
)


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


def _seed_ignited_no_NOx(inlet_T: float, inlet_P: float, inlet_X, mech: str = "gri30.yaml") -> ct.Solution:
    """Return a Cantera Solution initialized to HP-equilibrium of the inlet with
    all NOx-family species zeroed out, to allow kinetic NO build-up."""
    g = ct.Solution(mech)
    g.TPX = float(inlet_T), float(inlet_P), inlet_X
    g.equilibrate("HP")
    X = np.array(g.X, dtype=float)
    for sp in _NOX_FAMILY:
        idx = g.species_index(sp)
        if idx >= 0:
            X[idx] = 0.0
    s = X.sum()
    if s > 0:
        X = X / s
    g.TPX = g.T, float(inlet_P), X
    return g


def _advance_psr_to_steady(net: ct.ReactorNet, psr: ct.IdealGasReactor,
                           tau_psr_s: float,
                           max_wall_time_s: float = 30.0) -> None:
    """Integrate the PSR in chunks until both T and NO stop changing, or until
    a safety cap is reached.

    Chunk size is 100× tau (or at least 100 ms). Convergence tolerance:
    |ΔT| < 0.02 K and |ΔNO/NO| < 1e-4 between successive chunks.
    """
    NO_idx = psr.phase.species_index("NO")
    chunk = max(100.0 * tau_psr_s, 0.1)
    t = 0.0
    prev_T = -1.0
    prev_NO = -1.0
    max_total = max(1.0e5 * tau_psr_s, 30.0)
    wall0 = time.monotonic()
    for _ in range(200):
        if time.monotonic() - wall0 > max_wall_time_s:
            break
        t += chunk
        if t > max_total:
            try:
                net.advance(max_total)
            except Exception:
                pass
            break
        try:
            net.advance(t)
        except Exception:
            break
        T = float(psr.phase.T)
        NO = float(psr.phase.X[NO_idx]) if NO_idx >= 0 else 0.0
        if prev_T >= 0 and abs(T - prev_T) < 0.02 and abs(NO - prev_NO) < 1e-4 * max(NO, 1e-12):
            break
        prev_T, prev_NO = T, NO


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
    T_fuel_K: Optional[float] = None,
    T_air_K: Optional[float] = None,
) -> dict:
    """PSR then PFR. Returns emissions at PSR exit and PFR exit, plus a profile.

    If T_fuel_K / T_air_K are provided, the two streams are mixed adiabatically
    before entering the PSR. Otherwise both default to T0_K (old behavior).
    """
    T_f = float(T_fuel_K) if T_fuel_K is not None else float(T0_K)
    T_a = float(T_air_K) if T_air_K is not None else float(T0_K)
    gas, _, _, T_mixed = make_gas_mixed(fuel_pct, ox_pct, phi, T_f, T_a, P_bar)
    X_in = np.array(gas.X, dtype=float)
    P_Pa = gas.P

    # Upstream reservoir: fresh pre-mixed reactants at the adiabatic mixed T
    inlet_gas = ct.Solution("gri30.yaml")
    inlet_gas.TPX = T_mixed, P_Pa, X_in
    upstream = ct.Reservoir(inlet_gas)

    # PSR seeded "ignited but NOx-free" so thermal NO has to form kinetically
    psr_gas = _seed_ignited_no_NOx(T_mixed, P_Pa, X_in)
    psr = ct.IdealGasReactor(psr_gas, energy="on")

    # Downstream reservoir (state irrelevant at steady state)
    downstream_gas = ct.Solution("gri30.yaml")
    downstream_gas.TPX = psr_gas.T, psr_gas.P, psr_gas.X
    downstream = ct.Reservoir(downstream_gas)

    V_psr = 1.0e-3  # m³ reference — only mdot/tau is physical
    mdot = psr_gas.density * V_psr / max(tau_psr_s, 1e-9)

    mfc = ct.MassFlowController(upstream=upstream, downstream=psr, mdot=mdot)
    out = ct.PressureController(upstream=psr, downstream=downstream, primary=mfc, K=1e-5)

    net = ct.ReactorNet([psr])
    net.rtol = 1e-9
    net.atol = 1e-15
    _advance_psr_to_steady(net, psr, tau_psr_s)

    T_psr = float(psr.phase.T)
    NO_psr = _ppm_vd(psr.phase, "NO")
    CO_psr = _ppm_vd(psr.phase, "CO")
    O2_psr = _o2_pct_dry(psr.phase)
    fuel_idx = [psr.phase.species_index(s) for s in ("CH4", "C2H6", "C3H8", "H2") if psr.phase.species_index(s) >= 0]
    fuel_left = float(sum(psr.phase.Y[i] for i in fuel_idx))
    inlet_fuel = float(sum(inlet_gas.Y[i] for i in fuel_idx))
    conv_psr = 1.0 - fuel_left / max(inlet_fuel, 1e-20)
    conv_psr = max(0.0, min(1.0, conv_psr))

    # ---- PFR: ideal plug-flow along L_pfr at velocity V_pfr ----
    pfr_gas = ct.Solution("gri30.yaml")
    pfr_gas.TPX = psr.phase.T, psr.phase.P, psr.phase.X
    tau_pfr_s = L_pfr_m / max(V_pfr_m_s, 1e-9)
    dt = tau_pfr_s / max(profile_points - 1, 1)

    pfr_reactor = ct.IdealGasConstPressureReactor(pfr_gas, energy="on")
    pfr_net = ct.ReactorNet([pfr_reactor])
    pfr_net.rtol = 1e-9
    pfr_net.atol = 1e-15

    L_psr_equiv_cm = (tau_psr_s * V_pfr_m_s) * 100.0
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

    for i in range(1, profile_points):
        t_new = dt * i
        try:
            pfr_net.advance(t_new)
        except Exception:
            break
        x_cm = L_psr_equiv_cm + (t_new / tau_pfr_s) * (L_pfr_m * 100.0)
        T_i = float(pfr_reactor.phase.T)
        NO_i = _ppm_vd(pfr_reactor.phase, "NO")
        CO_i = _ppm_vd(pfr_reactor.phase, "CO")
        fuel_left_i = float(sum(pfr_reactor.phase.Y[j] for j in fuel_idx))
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

    O2_exit = _o2_pct_dry(pfr_reactor.phase)
    corr = (20.95 - 15.0) / max(20.95 - O2_exit, 1e-6)
    NO_15 = NO_exit * corr
    CO_15 = CO_exit * corr

    return {
        "T_psr": T_psr,
        "T_exit": T_exit,
        "T_mixed_inlet_K": T_mixed,
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
