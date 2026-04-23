"""4-circuit combustor mapping for the LMS100 DLE premixer.

Reactor topology (per call):

    ┌── PSR_IP (τ=3.5ms) ── PFR_IP (τ=1.5ms) ──┐   pilot path = 5.0 ms
    ├── PSR_OP (τ=3.5ms) ── PFR_OP (τ=1.5ms) ──┤                            + cooling air
    │                                          │                               (T3, ox_humid)
    ├── PSR_IM (τ=0.5ms) ── PFR_IM (τ=0.5ms) ──┼──► MIX ──► BULK PFR ──► COMBUSTOR EXIT
    └── PSR_OM (τ=0.5ms) ── PFR_OM (τ=0.5ms) ──┘   main path = 1.0 ms     (τ_bulk = τ_total − 5.0 ms)

Air accounting:
    W3              = compressor-discharge (post-bleed)
    W36             = W3 × (W36/W3)                    combustor-dome flow
    flame air       = W36 × com_air_frac               to the 4 circuits
    cooling/bypass  = W36 × (1 − com_air_frac)         effusion cooling, rejoins
                                                       at the mix point

Pilot NOx handling — pilots (IP, OP) are diffusion flames, so a premixed-PSR
at the nominal (lean) pilot φ under-predicts NOx. Instead, we anchor an
exponential fit at:
    (φ = 0.25, 6 ppm)   user-specified floor for lean pilots
    (φ = 1.0,  NOx_phi1)  — the PSR+PFR result at the CURRENT operating
                            conditions (T3, P3, T_fuel, ox, tau's) run
                            at φ = 1. This captures how the stoichiometric
                            thermal-NO answer shifts with pressure / inlet T.
For φ ≤ 0.25, NOx is clamped to the 6 ppm floor. Mains (IM, OM) use the
actual kinetic NOx from the PSR+PFR plus their fixed calibration adder.

Everything else (T, CO, major species, H2O) comes from the kinetics.
"""
from __future__ import annotations

from typing import Dict, Optional

import cantera as ct
import numpy as np

from .combustor import (
    _integrate_chunked,
    _o2_pct_dry,
    _ppm_vd,
    _safe_idx,
    _seed_ignited_no_NOx,
)
from .complete_combustion import run as complete_combustion_run
from .mixture import (
    _normalize_to_mech,
    compute_ratios,
    make_gas_mixed,
    mech_yaml,
)
from .water_mix import make_gas_mixed_with_water


# ----------------------------- helpers ----------------------------------------

def _pilot_nox_fit(
    phi: float,
    anchor_phi: float = 1.0,
    anchor_ppm: float = 180.0,
    floor_ppm: float = 6.0,
    floor_phi: float = 0.25,
) -> float:
    """Pilot NOx (ppm vol-dry) from a simple exponential fit.

    NOx = floor_ppm                              for phi <= floor_phi
    NOx = floor_ppm * exp(k * (phi - floor_phi))  otherwise,
    with k chosen so that NOx(anchor_phi) = anchor_ppm.

    Default anchors (6 ppm at phi=0.25, 180 ppm at phi=1.0) give
    k = ln(30)/0.75 ≈ 4.535.
    """
    if phi <= floor_phi:
        return float(floor_ppm)
    if anchor_phi <= floor_phi or anchor_ppm <= floor_ppm:
        return float(floor_ppm)
    k = np.log(anchor_ppm / floor_ppm) / (anchor_phi - floor_phi)
    return float(floor_ppm * np.exp(k * (phi - floor_phi)))


def _override_NO(gas: ct.Solution, NO_ppm_vd_target: float) -> None:
    """Replace NO mole fraction in `gas` so that _ppm_vd(gas, 'NO') ≈ target.
    Compensates by draining N2 to keep the mole-fraction sum at 1."""
    NO_idx = _safe_idx(gas, "NO")
    if NO_idx < 0:
        return
    N2_idx = _safe_idx(gas, "N2")
    H2O_idx = _safe_idx(gas, "H2O")
    X = np.array(gas.X, dtype=float)
    X_h2o = float(X[H2O_idx]) if H2O_idx >= 0 else 0.0
    X_NO_target = max(0.0, NO_ppm_vd_target * 1e-6 * (1.0 - X_h2o))
    delta = X_NO_target - float(X[NO_idx])
    X[NO_idx] = X_NO_target
    if N2_idx >= 0:
        X[N2_idx] = max(0.0, float(X[N2_idx]) - delta)
    s = X.sum()
    if s > 0:
        X = X / s
    # TPX with the same T, P keeps thermo consistent with the adjusted X.
    gas.TPX = float(gas.T), float(gas.P), X


def _x_dry_pct(gas: ct.Solution, species: str) -> float:
    idx = _safe_idx(gas, species)
    if idx < 0:
        return 0.0
    h2o_idx = _safe_idx(gas, "H2O")
    X = np.array(gas.X, dtype=float)
    if h2o_idx >= 0:
        X[h2o_idx] = 0.0
    s = X.sum()
    return float(X[idx] / s * 100.0) if s > 0 else 0.0


def _pure_stream_gas(
    ox_pct: Dict[str, float],
    T_K: float,
    P_bar: float,
    mechanism: str,
) -> ct.Solution:
    """Build an oxidizer-only (cooling/bypass) stream at (T, P)."""
    mech_path = mech_yaml(mechanism)
    gas = ct.Solution(mech_path)
    ox_x = _normalize_to_mech(ox_pct, mechanism)
    X = np.zeros(gas.n_species)
    for s, v in ox_x.items():
        idx = _safe_idx(gas, s)
        if idx >= 0:
            X[idx] = v
    s = X.sum()
    if s > 0:
        X = X / s
    gas.TPX = float(T_K), float(P_bar) * 1e5, X
    return gas


def _advance_pfr(gas: ct.Solution, tau_s: float, mech_path: str) -> ct.Solution:
    """Advance a const-pressure reactor for `tau_s` seconds. Returns a new
    Solution at the outlet state (Cantera's reactor.phase points at the live
    reactor; copying into a fresh Solution frees the reactor safely)."""
    if tau_s <= 0:
        out = ct.Solution(mech_path)
        out.TPX = float(gas.T), float(gas.P), gas.X
        return out
    work = ct.Solution(mech_path)
    work.TPX = float(gas.T), float(gas.P), gas.X
    r = ct.IdealGasConstPressureReactor(work, energy="on")
    net = ct.ReactorNet([r])
    net.rtol = 1e-9
    net.atol = 1e-15
    try:
        net.advance(tau_s)
    except Exception:
        pass
    out = ct.Solution(mech_path)
    out.TPX = float(r.phase.T), float(r.phase.P), r.phase.X
    return out


def _mix_streams(
    gases: list,
    mdots: list,
    mech_path: str,
) -> ct.Solution:
    """Mass-flow-weighted adiabatic enthalpy + mass-fraction mix at constant P.

    All `gases` must share the same mechanism and be at the same P (or close).
    Returns a new Cantera Solution at the mixed state.
    """
    total_mdot = float(sum(mdots))
    if total_mdot <= 0:
        out = ct.Solution(mech_path)
        out.TPX = float(gases[0].T), float(gases[0].P), gases[0].X
        return out

    # Mass-fraction mix (mass conservative for any species set)
    n_species = gases[0].n_species
    Y_mix = np.zeros(n_species)
    h_mix = 0.0
    P_sum = 0.0
    for mdot, g in zip(mdots, gases):
        if mdot <= 0:
            continue
        Y_mix += float(mdot) * np.array(g.Y, dtype=float)
        h_mix += float(mdot) * float(g.enthalpy_mass)
        P_sum += float(mdot) * float(g.P)
    Y_mix /= total_mdot
    h_mix /= total_mdot
    P_mix = P_sum / total_mdot

    mix = ct.Solution(mech_path)
    # HPY: given h, P, Y — Cantera solves for T and X consistent with that.
    mix.HPY = h_mix, P_mix, Y_mix
    return mix


def _run_circuit(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    phi: float,
    T_fuel_K: float,
    T_air_K: float,
    P_bar: float,
    tau_psr_s: float,
    tau_pfr_s: float,
    WFR: float,
    water_mode: str,
    mechanism: str,
) -> dict:
    """Run one DLE circuit: PSR(τ_psr) → PFR(τ_pfr). Returns T_psr, T_pfr,
    outlet X vector, NO and CO ppm-v-dry at PFR exit, and the
    complete-combustion AFT reference for the same inlet."""
    mech_path = mech_yaml(mechanism)
    P_Pa = float(P_bar) * 1e5

    # Degenerate case: no fuel. Treat the circuit as a pure cooling-air
    # passthrough at T_air so it still contributes to the mix.
    if phi <= 1e-4:
        gas = _pure_stream_gas(ox_pct, T_air_K, P_bar, mechanism)
        return {
            "T_mixed_K": float(T_air_K),
            "T_PSR_K": float(T_air_K),
            "T_PFR_K": float(T_air_K),
            "X_PFR": np.array(gas.X, dtype=float),
            "NO_ppm_vd": 0.0,
            "CO_ppm_vd": 0.0,
            "T_AFT_complete_K": float(T_air_K),
        }

    # Pre-mixed (fuel + air [+ water]) inlet state at adiabatic mix T
    if WFR and WFR > 0:
        gas_in, _, _, T_mixed, _Y_w = make_gas_mixed_with_water(
            fuel_pct, ox_pct, phi, T_fuel_K, T_air_K, P_bar, WFR, water_mode,
            mechanism=mechanism,
        )
    else:
        gas_in, _, _, T_mixed = make_gas_mixed(
            fuel_pct, ox_pct, phi, T_fuel_K, T_air_K, P_bar, mechanism=mechanism,
        )
    X_in = np.array(gas_in.X, dtype=float)

    # PSR — cold-ignited seed (NOx-family zeroed so kinetic NO can rebuild)
    psr_gas = _seed_ignited_no_NOx(T_mixed, P_Pa, X_in, constraint="HP", mech=mech_path)
    psr = ct.IdealGasReactor(psr_gas, energy="on")
    V_psr = 1.0e-3
    psr.volume = V_psr
    mdot = psr_gas.density * V_psr / max(tau_psr_s, 1e-9)

    upstream_gas = ct.Solution(mech_path)
    upstream_gas.TPX = T_mixed, P_Pa, X_in
    upstream = ct.Reservoir(upstream_gas)

    downstream_gas = ct.Solution(mech_path)
    downstream_gas.TPX = psr_gas.T, psr_gas.P, psr_gas.X
    downstream = ct.Reservoir(downstream_gas)

    mfc = ct.MassFlowController(upstream=upstream, downstream=psr, mdot=mdot)
    ct.PressureController(upstream=psr, downstream=downstream, primary=mfc, K=1e-2)

    net = ct.ReactorNet([psr])
    net.rtol = 1e-9
    net.atol = 1e-15
    _integrate_chunked(net, psr, tau_psr_s)

    T_psr = float(psr.phase.T)
    X_psr = np.array(psr.phase.X, dtype=float)
    P_psr = float(psr.phase.P)

    # PFR — const-P reactor advanced for tau_pfr_s
    pfr_in = ct.Solution(mech_path)
    pfr_in.TPX = T_psr, P_psr, X_psr
    pfr_out = _advance_pfr(pfr_in, tau_pfr_s, mech_path)

    NO_ppm = _ppm_vd(pfr_out, "NO")
    CO_ppm = _ppm_vd(pfr_out, "CO")

    # Complete-combustion AFT (non-dissociating upper bound) for the same inlet
    try:
        cc = complete_combustion_run(
            fuel_pct, ox_pct, phi,
            T_fuel_K=T_fuel_K, T_air_K=T_air_K, P_bar=P_bar,
            WFR=WFR, water_mode=water_mode, mechanism=mechanism,
        )
        T_complete = float(cc["T_ad"])
    except Exception:
        T_complete = T_psr

    return {
        "T_mixed_K": float(T_mixed),
        "T_PSR_K": T_psr,
        "T_PFR_K": float(pfr_out.T),
        "X_PFR": np.array(pfr_out.X, dtype=float),
        "NO_ppm_vd": NO_ppm,
        "CO_ppm_vd": CO_ppm,
        "T_AFT_complete_K": T_complete,
    }


# ----------------------------- main entry -------------------------------------

def run(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    T3_K: float,
    P3_bar: float,
    T_fuel_K: float,
    W3_kg_s: float,
    W36_over_W3: float,
    com_air_frac: float,
    frac_IP_pct: float,
    frac_OP_pct: float,
    frac_IM_pct: float,
    frac_OM_pct: float,
    phi_IP: float,
    phi_OP: float,
    phi_IM: float,
    m_fuel_total_kg_s: float,
    tau_total_ms: float = 5.0,
    tau_psr_pilot_ms: float = 3.5,
    tau_pfr_pilot_ms: float = 1.5,
    tau_psr_main_ms: float = 0.5,
    tau_pfr_main_ms: float = 0.5,
    WFR: float = 0.0,
    water_mode: str = "liquid",
    mechanism: str = "gri30",
    pilot_NOx_anchor_phi: float = 1.0,
    pilot_NOx_anchor_ppm: Optional[float] = None,
    im_nox_adder_ppm: float = 12.0,
    om_nox_adder_ppm: float = 17.2,
) -> dict:
    """Run the 4-circuit combustor mapping. See module docstring for topology."""
    mech_path = mech_yaml(mechanism)
    P_Pa = float(P3_bar) * 1e5

    # --- air accounting -------------------------------------------------------
    w36w3 = max(0.0, min(1.0, float(W36_over_W3)))
    caf = max(0.0, min(1.0, float(com_air_frac)))
    W36 = float(W3_kg_s) * w36w3
    flame_air = W36 * caf
    cooling_air = W36 * (1.0 - caf)

    m_air_IP = flame_air * float(frac_IP_pct) / 100.0
    m_air_OP = flame_air * float(frac_OP_pct) / 100.0
    m_air_IM = flame_air * float(frac_IM_pct) / 100.0
    m_air_OM = flame_air * float(frac_OM_pct) / 100.0

    # --- stoichiometry (FAR_stoich is phi-independent) -----------------------
    _FAR, FAR_stoich, _AFR, _AFR_s = compute_ratios(fuel_pct, ox_pct, 1.0)

    # --- fuel per circuit (OM is the float) ----------------------------------
    m_fuel_IP = m_air_IP * float(phi_IP) * FAR_stoich
    m_fuel_OP = m_air_OP * float(phi_OP) * FAR_stoich
    m_fuel_IM = m_air_IM * float(phi_IM) * FAR_stoich
    m_fuel_OM_raw = float(m_fuel_total_kg_s) - m_fuel_IP - m_fuel_OP - m_fuel_IM
    m_fuel_OM = max(0.0, m_fuel_OM_raw)
    FAR_OM = (m_fuel_OM / m_air_OM) if m_air_OM > 0 else 0.0
    phi_OM = (FAR_OM / FAR_stoich) if FAR_stoich > 0 else 0.0
    # Clamp to a plausible band for the kinetic solver. Out-of-band conditions
    # still compute but results should be inspected.
    phi_OM_clamped = min(max(phi_OM, 0.0), 3.0)
    fuel_residual = float(m_fuel_total_kg_s) - (m_fuel_IP + m_fuel_OP + m_fuel_IM + m_fuel_OM)

    # --- per-class residence times ------------------------------------------
    # Pilots (diffusion-like) get a longer PSR; mains (fast premixed) get a
    # shorter near-field PFR. Each class runs its own path, all streams
    # converge at the mix plane regardless of the time coordinate.
    tau_psr_pilot_s  = max(tau_psr_pilot_ms,  0.05) * 1e-3
    tau_pfr_pilot_s  = max(tau_pfr_pilot_ms,  0.0)  * 1e-3
    tau_psr_main_s   = max(tau_psr_main_ms,   0.05) * 1e-3
    tau_pfr_main_s   = max(tau_pfr_main_ms,   0.0)  * 1e-3
    pilot_path_ms    = float(tau_psr_pilot_ms + tau_pfr_pilot_ms)
    main_path_ms     = float(tau_psr_main_ms  + tau_pfr_main_ms)
    max_path_ms      = max(pilot_path_ms, main_path_ms)

    # --- pilot NOx upper anchor ---------------------------------------------
    # Run the pilot-class PSR+PFR at phi=pilot_NOx_anchor_phi (default 1.0)
    # with the current T3/P3/T_fuel/fuel/ox to get the stoichiometric-
    # premixed NOx at this operating point. That value anchors the pilot
    # exp-fit, so the pilot curve tracks pressure / inlet T correctly.
    if pilot_NOx_anchor_ppm is None:
        try:
            anchor_res = _run_circuit(
                fuel_pct, ox_pct, float(pilot_NOx_anchor_phi),
                T_fuel_K, T3_K, P3_bar,
                tau_psr_pilot_s, tau_pfr_pilot_s,
                WFR, water_mode, mechanism,
            )
            anchor_ppm = float(anchor_res["NO_ppm_vd"])
            # Guard: anchor MUST exceed the 6 ppm floor for the exp-fit to
            # be well-defined. Otherwise fall back to the legacy 180 ppm.
            if anchor_ppm <= 6.5:
                anchor_ppm = 180.0
                anchor_source = "fallback_180_psr_failed"
            else:
                anchor_source = "psr_at_phi_anchor"
        except Exception:
            anchor_ppm = 180.0
            anchor_source = "fallback_180_psr_exception"
    else:
        anchor_ppm = max(6.5, float(pilot_NOx_anchor_ppm))
        anchor_source = "user_override"

    # Fixed main-circuit NOx adders (ppm, vol-dry) applied on top of the
    # kinetic PSR+PFR NO. Compensates for sub-grid effects the 0D network
    # can't see (imperfect premix, local rich zones, unsteady pockets).
    # Defaults calibrated to LMS100 DLE hardware: IM +12 ppm, OM +17.2 ppm.
    # Each tuple: (name, phi, m_air, m_fuel, is_pilot, nox_adder,
    #              tau_psr_s, tau_pfr_s)
    circuits_spec = [
        ("IP", float(phi_IP),         m_air_IP, m_fuel_IP, True,  0.0,                     tau_psr_pilot_s, tau_pfr_pilot_s),
        ("OP", float(phi_OP),         m_air_OP, m_fuel_OP, True,  0.0,                     tau_psr_pilot_s, tau_pfr_pilot_s),
        ("IM", float(phi_IM),         m_air_IM, m_fuel_IM, False, float(im_nox_adder_ppm), tau_psr_main_s,  tau_pfr_main_s),
        ("OM", float(phi_OM_clamped), m_air_OM, m_fuel_OM, False, float(om_nox_adder_ppm), tau_psr_main_s,  tau_pfr_main_s),
    ]

    circuits_out: Dict[str, dict] = {}
    # For the mix step we accumulate (gas, mdot) pairs across all 4 circuits
    # plus the cooling stream.
    mix_gases: list = []
    mix_mdots: list = []

    for name, phi_i, m_air_i, m_fuel_i, is_pilot, nox_adder_ppm, tau_psr_i, tau_pfr_i in circuits_spec:
        res = _run_circuit(
            fuel_pct, ox_pct, phi_i,
            T_fuel_K, T3_K, P3_bar,
            tau_psr_i, tau_pfr_i,
            WFR, water_mode, mechanism,
        )

        # Kinetic NOx from the PFR exit; pilots use exp-fit, mains get adder.
        if is_pilot:
            NOx_report = _pilot_nox_fit(
                phi_i,
                anchor_phi=pilot_NOx_anchor_phi,
                anchor_ppm=anchor_ppm,
            )
        else:
            NOx_report = float(res["NO_ppm_vd"]) + float(nox_adder_ppm)

        circuits_out[name] = {
            "phi": phi_i,
            "m_air_kg_s": float(m_air_i),
            "m_fuel_kg_s": float(m_fuel_i),
            "T_AFT_complete_K": float(res["T_AFT_complete_K"]),
            "T_PSR_K": float(res["T_PSR_K"]),
            "T_PFR_K": float(res["T_PFR_K"]),
            "NOx_ppm_vd": float(NOx_report),
            "CO_ppm_vd": float(res["CO_ppm_vd"]),
        }

        # Build a gas state to feed into the mix step
        gas_for_mix = ct.Solution(mech_path)
        gas_for_mix.TPX = res["T_PFR_K"], P_Pa, res["X_PFR"]

        # Override NO in the mix gas so the bulk PFR starts from the reported
        # NOx (not the raw kinetic value). Pilots: fitted NOx. Mains: kinetic +
        # adder. Skipped for cold circuits (phi ≈ 0) since there is no NO yet.
        if phi_i > 1e-6 and (is_pilot or nox_adder_ppm != 0.0):
            _override_NO(gas_for_mix, NOx_report)

        # Total mdot through the circuit = air + fuel
        mix_gases.append(gas_for_mix)
        mix_mdots.append(float(m_air_i + m_fuel_i))

    # --- cooling/effusion air stream (at T3) ---------------------------------
    if cooling_air > 0:
        cool_gas = _pure_stream_gas(ox_pct, T3_K, P3_bar, mechanism)
        mix_gases.append(cool_gas)
        mix_mdots.append(cooling_air)

    # --- mix + bulk PFR ------------------------------------------------------
    mix_gas = _mix_streams(mix_gases, mix_mdots, mech_path)
    # Bulk PFR runs from the mix plane to the combustor exit. The mix plane
    # sits at t = max(pilot_path, main_path); pilots take the longest to
    # arrive, so the bulk time is τ_total − max_path.
    tau_bulk_s = max(0.0, (float(tau_total_ms) - max_path_ms) * 1e-3)
    exit_gas = _advance_pfr(mix_gas, tau_bulk_s, mech_path)

    # --- exit emissions ------------------------------------------------------
    NOx_exit_vd = _ppm_vd(exit_gas, "NO")
    CO_exit_vd = _ppm_vd(exit_gas, "CO")
    O2_exit_dry = _o2_pct_dry(exit_gas)
    CO2_exit_dry = _x_dry_pct(exit_gas, "CO2")
    h2o_idx = _safe_idx(exit_gas, "H2O")
    H2O_exit_wet = float(exit_gas.X[h2o_idx]) * 100.0 if h2o_idx >= 0 else 0.0

    # 15% O2 reference correction (standard gas turbine convention)
    corr = (20.95 - 15.0) / max(20.95 - O2_exit_dry, 1e-6)
    NOx_15 = NOx_exit_vd * corr
    CO_15 = CO_exit_vd * corr

    return {
        "exit": {
            "T_K": float(exit_gas.T),
            "NOx_ppm_15O2": float(NOx_15),
            "CO_ppm_15O2": float(CO_15),
            "NOx_ppm_vd": float(NOx_exit_vd),
            "CO_ppm_vd": float(CO_exit_vd),
            "O2_pct_dry": float(O2_exit_dry),
            "CO2_pct_dry": float(CO2_exit_dry),
            "H2O_pct_wet": float(H2O_exit_wet),
        },
        "circuits": circuits_out,
        "air_accounting": {
            "W3_kg_s": float(W3_kg_s),
            "W36_kg_s": float(W36),
            "flame_air_kg_s": float(flame_air),
            "cooling_air_kg_s": float(cooling_air),
        },
        "tau_ms": {
            "psr_pilot": float(tau_psr_pilot_ms),
            "pfr_pilot": float(tau_pfr_pilot_ms),
            "psr_main": float(tau_psr_main_ms),
            "pfr_main": float(tau_pfr_main_ms),
            "pfr_bulk": float(tau_bulk_s * 1000.0),
            "total": float(tau_total_ms),
        },
        "phi_OM": float(phi_OM),
        "FAR_stoich": float(FAR_stoich),
        "fuel_residual_kg_s": float(fuel_residual),
        "mechanism": mechanism,
        "pilot_NOx_anchor_phi": float(pilot_NOx_anchor_phi),
        "pilot_NOx_anchor_ppm_used": float(anchor_ppm),
        "pilot_NOx_anchor_source": anchor_source,
    }
