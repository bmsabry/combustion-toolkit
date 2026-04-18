"""PSR → PFR combustor network using Cantera ReactorNet.

PSR seed strategies (`psr_seed`):
    unreacted    — seed the reactor with the cold inlet mixture; rely on
                   the integrator to ignite. Most honest, most fragile: short
                   tau or weak mixtures can leave the reactor extinguished.
    hot_eq       — seed with a plain `equilibrate(constraint)` of the inlet.
                   All species at their equilibrium levels, including NO. Fast
                   to converge on T but tends to lock NO near its (very high)
                   equilibrium value.
    cold_ignited — like hot_eq but with NOx-family species zeroed after
                   equilibration, so NO has to rebuild kinetically (Zeldovich).
                   Default: gives physically sensible NO for short residence
                   times without being stuck at equilibrium NO.
    autoignition — integrate a closed 0D constant-HP reactor from the
                   inlet state long enough to ignite, then use THAT state as
                   the seed. Honest about ignition delay; still a useful warm
                   start for the steady-PSR integration.

Equilibrium constraint (`eq_constraint`):
    HP — constant enthalpy + pressure (physically correct for an
         adiabatic PSR at steady pressure; the default)
    UV — constant internal energy + specific volume (closed vessel)
    TP — isothermal at the inlet T (rarely what you want)
    Only relevant for `hot_eq` and `cold_ignited` seeds.

Integration strategy (`integration`):
    steady_state — Cantera's built-in `advance_to_steady_state()`. Fast when
                   it works; can return prematurely for reactors dominated
                   by slow kinetics (e.g. Zeldovich NO).
    chunked      — advance in `100*tau` chunks, test ΔT and ΔNO for
                   convergence, stop once both stabilize. Robust; default.
    step         — call `net.step()` repeatedly and track convergence on
                   each internal timestep. Finest control, slowest.

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

from .mixture import make_gas_mixed, mech_yaml


# NOx-family species to zero out in the cold-ignited warm start.
_NOX_FAMILY = (
    "NO", "NO2", "N2O", "N",
    "NH", "NH2", "NH3", "NNH", "HNO",
    "CN", "HCN", "H2CN", "HCNN", "HCNO", "HOCN", "HNCO", "NCO",
)

# Allowed dispatch keys
_SEED_OPTIONS = ("unreacted", "hot_eq", "cold_ignited", "autoignition")
_CONSTRAINT_OPTIONS = ("HP", "UV", "TP")
_INTEGRATION_OPTIONS = ("steady_state", "chunked", "step")


def _safe_idx(gas: ct.Solution, species: str) -> int:
    """Return species index, or -1 if the species is not in the mechanism.
    Cantera 3.x raises CanteraError on missing species instead of returning -1;
    this helper restores the old sentinel behavior."""
    try:
        return gas.species_index(species)
    except Exception:
        return -1


def _ppm_vd(gas: ct.Solution, species: str) -> float:
    """ppm, volumetric, dry (water removed) for the given species."""
    idx = _safe_idx(gas, species)
    if idx < 0:
        return 0.0
    h2o_idx = _safe_idx(gas, "H2O")
    X = np.array(gas.X, dtype=float)
    if h2o_idx >= 0:
        X[h2o_idx] = 0.0
    s = X.sum()
    if s <= 0:
        return 0.0
    X_dry = X / s
    return float(X_dry[idx] * 1e6)


def _o2_pct_dry(gas: ct.Solution) -> float:
    idx = _safe_idx(gas, "O2")
    if idx < 0:
        return 0.0
    h2o_idx = _safe_idx(gas, "H2O")
    X = np.array(gas.X, dtype=float)
    if h2o_idx >= 0:
        X[h2o_idx] = 0.0
    s = X.sum()
    return float(X[idx] / s * 100.0) if s > 0 else 0.0


# ---------- PSR seeders ----------

def _seed_unreacted(inlet_T: float, inlet_P: float, inlet_X, mech: str = "gri30.yaml") -> ct.Solution:
    """Seed with the cold, unreacted inlet mixture. The integrator is left
    to ignite on its own."""
    g = ct.Solution(mech)
    g.TPX = float(inlet_T), float(inlet_P), inlet_X
    return g


def _seed_hot_equilibrium(
    inlet_T: float, inlet_P: float, inlet_X,
    constraint: str = "HP", mech: str = "gri30.yaml",
) -> ct.Solution:
    """Seed with a plain equilibrium of the inlet under the given constraint."""
    g = ct.Solution(mech)
    g.TPX = float(inlet_T), float(inlet_P), inlet_X
    g.equilibrate(constraint)
    return g


def _seed_ignited_no_NOx(
    inlet_T: float, inlet_P: float, inlet_X,
    constraint: str = "HP", mech: str = "gri30.yaml",
) -> ct.Solution:
    """Return a Cantera Solution initialized to equilibrium of the inlet (under
    the given constraint) with all NOx-family species zeroed out, to allow
    kinetic NO build-up."""
    g = ct.Solution(mech)
    g.TPX = float(inlet_T), float(inlet_P), inlet_X
    g.equilibrate(constraint)
    X = np.array(g.X, dtype=float)
    for sp in _NOX_FAMILY:
        idx = _safe_idx(g, sp)
        if idx >= 0:
            X[idx] = 0.0
    s = X.sum()
    if s > 0:
        X = X / s
    g.TPX = g.T, float(inlet_P), X
    return g


def _seed_autoignition(
    inlet_T: float, inlet_P: float, inlet_X,
    mech: str = "gri30.yaml",
    max_time_s: float = 1.0,
) -> ct.Solution:
    """Integrate a closed 0D constant-HP reactor from the cold inlet state
    forward in time past ignition (defined as a >200 K rise from inlet).
    Returns a Solution at the post-ignition burnt state. If ignition doesn't
    happen within max_time_s, returns the final (possibly still-cold) state."""
    g = ct.Solution(mech)
    g.TPX = float(inlet_T), float(inlet_P), inlet_X
    r = ct.IdealGasConstPressureReactor(g, energy="on")
    net = ct.ReactorNet([r])
    net.rtol = 1e-9
    net.atol = 1e-15
    T0 = float(g.T)
    t = 0.0
    dt = 1e-4
    while t < max_time_s:
        t += dt
        try:
            net.advance(t)
        except Exception:
            break
        if float(r.phase.T) - T0 > 200.0:
            # push a little past ignition to stabilize
            try:
                net.advance(t + 10.0 * dt)
            except Exception:
                pass
            break
        if dt < 0.01:
            dt *= 1.5
    g2 = ct.Solution(mech)
    g2.TPX = float(r.phase.T), float(inlet_P), r.phase.X
    return g2


def _dispatch_seed(
    psr_seed: str,
    eq_constraint: str,
    inlet_T: float,
    inlet_P: float,
    inlet_X,
    mech: str = "gri30.yaml",
) -> ct.Solution:
    if psr_seed == "unreacted":
        return _seed_unreacted(inlet_T, inlet_P, inlet_X, mech)
    if psr_seed == "hot_eq":
        return _seed_hot_equilibrium(inlet_T, inlet_P, inlet_X, eq_constraint, mech)
    if psr_seed == "cold_ignited":
        return _seed_ignited_no_NOx(inlet_T, inlet_P, inlet_X, eq_constraint, mech)
    if psr_seed == "autoignition":
        return _seed_autoignition(inlet_T, inlet_P, inlet_X, mech)
    raise ValueError(f"Unknown psr_seed: {psr_seed!r}")


# ---------- PSR integrators ----------

def _integrate_chunked(
    net: ct.ReactorNet, psr: ct.IdealGasReactor,
    tau_psr_s: float,
    max_wall_time_s: float = 30.0,
) -> None:
    """Integrate the PSR until both T and NO stabilize.

    Convergence protocol:
      * Advance in chunks of 10·tau (minimum 2 ms of simulated time).
      * Require a MINIMUM integration time of max(50·tau, 100 ms). A
        well-posed CSTR reaches steady state in ~5–20 residence times;
        50·τ is a comfortable safety margin.
      * Declare converged only when |ΔT|<0.005 K AND |ΔNO/NO|<1e-4 hold
        over TWO consecutive chunks.
      * Absolute caps: simulated time ≤ max(5000·τ, 2 s); wall time
        ≤ max_wall_time_s.
    """
    NO_idx = _safe_idx(psr.phase, "NO")
    chunk = max(10.0 * tau_psr_s, 0.002)
    t = 0.0
    prev_T = -1.0
    prev_NO = -1.0
    stable_count = 0
    # Integrate at least 50·τ (min 100 ms) but cap at 2 s of simulated time.
    min_total = min(max(50.0 * tau_psr_s, 0.1), 2.0)
    max_total = min(max(5000.0 * tau_psr_s, 2.0), 10.0)
    wall0 = time.monotonic()
    for _ in range(5000):
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
        if t >= min_total and prev_T >= 0:
            if abs(T - prev_T) < 0.005 and abs(NO - prev_NO) < 1e-4 * max(NO, 1e-12):
                stable_count += 1
                if stable_count >= 2:
                    break
            else:
                stable_count = 0
        prev_T, prev_NO = T, NO


def _integrate_steady_state(
    net: ct.ReactorNet, psr: ct.IdealGasReactor,
    tau_psr_s: float,
    max_wall_time_s: float = 30.0,
) -> None:
    """Use Cantera's built-in advance_to_steady_state. Falls back to
    chunked on error."""
    try:
        net.advance_to_steady_state()
    except Exception:
        _integrate_chunked(net, psr, tau_psr_s, max_wall_time_s)


def _integrate_step(
    net: ct.ReactorNet, psr: ct.IdealGasReactor,
    tau_psr_s: float,
    max_wall_time_s: float = 30.0,
) -> None:
    """Step-by-step integration using net.step() with a minimum-simulated-time
    gate before convergence is tested.

    Same rationale as `_integrate_chunked`: require ≥ max(50·τ, 100 ms)
    of simulated time before the convergence criterion
    (|ΔT|<0.005 K ∧ |ΔNO/NO|<1e-4) can trigger, and only break after 50
    consecutive stable internal steps. Hard caps: simulated time
    ≤ max(5000·τ, 2 s); wall time ≤ max_wall_time_s.
    """
    NO_idx = _safe_idx(psr.phase, "NO")
    prev_T = -1.0
    prev_NO = -1.0
    # Integrate at least 50·τ (min 100 ms) but cap at 2 s of simulated time.
    min_total = min(max(50.0 * tau_psr_s, 0.1), 2.0)
    max_total = min(max(5000.0 * tau_psr_s, 2.0), 10.0)
    stable_count = 0
    wall0 = time.monotonic()
    for _ in range(500000):
        if time.monotonic() - wall0 > max_wall_time_s:
            break
        try:
            t_now = net.step()
        except Exception:
            break
        if t_now > max_total:
            break
        T = float(psr.phase.T)
        NO = float(psr.phase.X[NO_idx]) if NO_idx >= 0 else 0.0
        if t_now >= min_total and prev_T >= 0:
            if abs(T - prev_T) < 0.005 and abs(NO - prev_NO) < 1e-4 * max(NO, 1e-12):
                stable_count += 1
                if stable_count >= 50:  # require sustained stability
                    break
            else:
                stable_count = 0
        prev_T, prev_NO = T, NO


def _dispatch_integration(
    integration: str,
    net: ct.ReactorNet, psr: ct.IdealGasReactor,
    tau_psr_s: float,
) -> None:
    if integration == "chunked":
        _integrate_chunked(net, psr, tau_psr_s)
        return
    if integration == "steady_state":
        _integrate_steady_state(net, psr, tau_psr_s)
        return
    if integration == "step":
        _integrate_step(net, psr, tau_psr_s)
        return
    raise ValueError(f"Unknown integration: {integration!r}")


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
    psr_seed: str = "cold_ignited",
    eq_constraint: str = "HP",
    integration: str = "chunked",
    heat_loss_fraction: float = 0.0,
    mechanism: str = "gri30",
) -> dict:
    """PSR then PFR. Returns emissions at PSR exit and PFR exit, plus a profile.

    If T_fuel_K / T_air_K are provided, the two streams are mixed adiabatically
    before entering the PSR. Otherwise both default to T0_K (old behavior).

    Reactor-option parameters (`psr_seed`, `eq_constraint`, `integration`)
    default to the original behavior ("cold_ignited" + "HP" + "chunked"), so
    callers who don't set them get identical results to the legacy
    implementation.
    """
    # Validate option strings up front for clearer errors
    if psr_seed not in _SEED_OPTIONS:
        raise ValueError(f"psr_seed must be one of {_SEED_OPTIONS}, got {psr_seed!r}")
    if eq_constraint not in _CONSTRAINT_OPTIONS:
        raise ValueError(
            f"eq_constraint must be one of {_CONSTRAINT_OPTIONS}, got {eq_constraint!r}"
        )
    if integration not in _INTEGRATION_OPTIONS:
        raise ValueError(
            f"integration must be one of {_INTEGRATION_OPTIONS}, got {integration!r}"
        )
    if not (0.0 <= heat_loss_fraction <= 0.5):
        raise ValueError(
            f"heat_loss_fraction must be in [0, 0.5], got {heat_loss_fraction}"
        )

    T_f = float(T_fuel_K) if T_fuel_K is not None else float(T0_K)
    T_a = float(T_air_K) if T_air_K is not None else float(T0_K)
    mech_path = mech_yaml(mechanism)
    gas, _, _, T_mixed = make_gas_mixed(fuel_pct, ox_pct, phi, T_f, T_a, P_bar, mechanism=mechanism)
    X_in = np.array(gas.X, dtype=float)
    P_Pa = gas.P

    # Upstream reservoir: fresh pre-mixed reactants at the adiabatic mixed T
    inlet_gas = ct.Solution(mech_path)
    inlet_gas.TPX = T_mixed, P_Pa, X_in
    upstream = ct.Reservoir(inlet_gas)

    # PSR seed — dispatch based on psr_seed + eq_constraint
    psr_gas = _dispatch_seed(psr_seed, eq_constraint, T_mixed, P_Pa, X_in, mech=mech_path)
    psr = ct.IdealGasReactor(psr_gas, energy="on")
    # CRITICAL: Cantera's IdealGasReactor defaults to V=1.0 m³. mdot below is sized
    # for V_psr=1e-3 m³ so we MUST set psr.volume to match — otherwise the effective
    # residence time is 1000× the requested tau_psr_s, NO runs to equilibrium, and
    # the PSR behaves like a closed batch reactor.
    V_psr = 1.0e-3  # m³ reference — only mdot/tau is physical, volume just needs to match
    psr.volume = V_psr
    mdot = psr_gas.density * V_psr / max(tau_psr_s, 1e-9)

    # Downstream reservoir must be at the same pressure as the PSR; otherwise
    # the PressureController will bleed the PSR toward the downstream pressure.
    downstream_gas = ct.Solution(mech_path)
    downstream_gas.TPX = psr_gas.T, psr_gas.P, psr_gas.X
    downstream = ct.Reservoir(downstream_gas)

    mfc = ct.MassFlowController(upstream=upstream, downstream=psr, mdot=mdot)
    # K is the pressure-coupling coefficient of the outflow controller.
    # Making this larger keeps P_psr pinned to P_downstream during transients.
    out = ct.PressureController(upstream=psr, downstream=downstream, primary=mfc, K=1e-2)

    # Optional heat loss: hold the PSR at T_target = T_ad - f·(T_ad − T_in) via a
    # high-conductance wall to an ambient reservoir at T_target. With large U,
    # the reactor's energy balance is dominated by the wall, pinning T at
    # T_target while the mass-flow/chemistry proceed normally. This is the
    # standard parametrisation used by combustor designers (quench fraction).
    T_target = 0.0
    ambient = None
    wall = None
    if heat_loss_fraction > 0.0:
        eq_gas = ct.Solution(mech_path)
        eq_gas.TPX = T_mixed, P_Pa, X_in
        eq_gas.equilibrate("HP")
        T_ad_ref = float(eq_gas.T)
        T_target = T_ad_ref - float(heat_loss_fraction) * (T_ad_ref - float(T_mixed))
        ambient_gas = ct.Solution(mech_path)
        ambient_gas.TPX = T_target, P_Pa, eq_gas.X
        ambient = ct.Reservoir(ambient_gas)
        # U*A with A=1 m² → U in W/m²/K. 1e7 ≫ mdot·cp for our scales (mdot~O(1)
        # kg/s, cp~1500, so 1e7 K/(K·s) dominates). Reactor T locks to T_target.
        wall = ct.Wall(psr, ambient, U=1.0e7, A=1.0)

    net = ct.ReactorNet([psr])
    net.rtol = 1e-9
    net.atol = 1e-15
    _dispatch_integration(integration, net, psr, tau_psr_s)

    T_psr = float(psr.phase.T)
    NO_psr = _ppm_vd(psr.phase, "NO")
    CO_psr = _ppm_vd(psr.phase, "CO")
    O2_psr = _o2_pct_dry(psr.phase)
    fuel_idx = [i for i in (_safe_idx(psr.phase, s) for s in ("CH4", "C2H6", "C3H8", "H2")) if i >= 0]
    fuel_left = float(sum(psr.phase.Y[i] for i in fuel_idx))
    inlet_fuel = float(sum(inlet_gas.Y[i] for i in fuel_idx))
    conv_psr = 1.0 - fuel_left / max(inlet_fuel, 1e-20)
    conv_psr = max(0.0, min(1.0, conv_psr))

    # ---- PFR: ideal plug-flow along L_pfr at velocity V_pfr ----
    pfr_gas = ct.Solution(mech_path)
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
        "psr_seed": psr_seed,
        "eq_constraint": eq_constraint,
        "integration": integration,
        "heat_loss_fraction": float(heat_loss_fraction),
        "T_target_K": float(T_target),  # 0.0 if heat_loss_fraction == 0
        "profile": profile,
    }
