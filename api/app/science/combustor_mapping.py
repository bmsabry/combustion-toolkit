"""LMS100 DLE 4-circuit combustor mapping — correlation-based emissions
and dynamics model.

No reactor-network kinetics. Per-circuit T_AFT comes from a complete-
combustion flame-temperature solve. Emissions (NOx15, CO15) and dynamics
(PX36_SEL = low-frequency, PX36_SEL_HI = high-frequency) are predicted
from a linear model anchored at the LMS100 design point, with a Phi_OP
multiplier (HI only) and a P3 power-law scaling for part-load operation.

The correction chain for each output Y ∈ {NOx15, CO15, PX36_SEL, PX36_SEL_HI}:

    Y_lin   = Y_ref
              + Σ_k (dY/dx_k) × (x_k − x_k_ref)     over k in
                {DT_Main, N2, C3, Phi_OP, Tflame, T3}
              (Tflame, T3 derivatives only apply to NOx15 and CO15)

    Y_mult  = Y_lin × phi_OP_mult(Phi_OP)    (ONLY for PX36_SEL_HI;
                                              other outputs: Y_mult = Y_lin)
              where phi_OP_mult = 1.0        for Phi_OP ≥ 0.55
                                = 0.8        for Phi_OP ≤ 0.45
                                = linear interp between

    Y_final = Y_mult × (P3 / 638)^exponent
              exponents: NOx15=0.467, CO15=-1.0, SEL=0.44, SEL_HI=0.44

Inputs:
    DT_Main (°F)   = (T_AFT_OM − T_AFT_IM in K) × 1.8
    Tflame  (°F)   = mass-flow-weighted average of the 4 circuit T_AFT
                      values, converted from K to °F
    T3      (°F)   = cycle T3 (K) → °F
    P3      (psia) = cycle P3 (bar) × 14.5038
    C3_eff  (%)    = 0.8·(C2H6+C2H4+C2H2) + (C3H8+C4H10+C5H12+C6H14+C7H16+C8H18)
                     (C2-class coefficient 0.8; C3 and all heavier HCs at 1.0)
    N2      (%)    = fuel N2 mole %
    Phi_OP         = user-set outer-pilot equivalence ratio
"""
from __future__ import annotations

from typing import Dict

from .complete_combustion import run as complete_combustion_run  # kept for legacy callers
from .cycle import _t_bulk_with_mix_and_water as _hp_eq_with_water
from .mixture import compute_ratios


# ----- reference design point (100 % load, LMS100 DLE, Tamb 44 °F) -----------
_REF = {
    "NOx15":       45.0,   # ppmvd @ 15 % O2
    "CO15":        130.0,  # ppmvd @ 15 % O2  (re-anchored 2026-05-02 from 180.0)
    "PX36_SEL":    4.3,    # low-frequency dynamics
    "PX36_SEL_HI": 2.2,    # high-frequency dynamics
}

_REFPT = {
    "DT_Main_F":  450.0,
    "Phi_OP":     0.65,
    "C3_pct":     7.5,
    "N2_pct":     0.5,
    "Tflame_F":   3035.0,
    "T3_F":       700.0,
    "P3_psia":    638.0,
}

# Linear derivatives (d output / d input-variable). 0 means no sensitivity.
# Phi_OP / Phi_IP rows are "per +0.1 change" in the source table; stored here
# already converted to "per unit phi" by pre-multiplying by 10.
# Phi_IP applies only above 0.25 (one-sided ramp). See _phi_ip_delta below.
_DERIV = {
    # All four outputs treat ∂/∂DT_Main piecewise — the entries here are
    # 0 to avoid double-counting in the generic linear loop. Per-output
    # piecewise helpers handle the actual contribution:
    #   NOx15        → _nox15_dt_main_contribution()
    #                  linear above 150 °F floor, frozen below
    #   CO15         → _co15_dt_main_contribution()
    #                  linear above 75 °F, flat 25–75, reversed below 25
    #   PX36_SEL     → _px36_dt_main_contribution(slope=-0.004)
    #                  linear up to 650 °F ceiling, frozen above
    #   PX36_SEL_HI  → _px36_dt_main_contribution(slope=-0.0004)
    #                  same 650 °F ceiling
    "DT_Main": {"NOx15": 0.0,    "CO15":  0.0,   "PX36_SEL":  0.0,    "PX36_SEL_HI":  0.0},
    "N2":      {"NOx15": -0.25,  "CO15":  2.0,   "PX36_SEL":  0.0,    "PX36_SEL_HI":  0.0},
    "C3":      {"NOx15":  0.75,  "CO15": -12.0,  "PX36_SEL":  0.04,   "PX36_SEL_HI":  0.0266},
    "Phi_OP":  {"NOx15":  17.5,  "CO15":  -70.0, "PX36_SEL": -1.5,    "PX36_SEL_HI": -0.15},
    "Phi_IP":  {"NOx15":  15.0,  "CO15": -100.0, "PX36_SEL":  0.0,    "PX36_SEL_HI":  0.0},
    # NOx15 ∂/∂Tflame is piecewise in Tflame and handled by
    # _nox15_tflame_contribution() below — the entry here is 0 to avoid
    # double-counting in the generic linear loop. CO15 ∂/∂Tflame stays
    # as a single slope of −1.0 ppm/°F.
    "Tflame":  {"NOx15":  0.0,   "CO15": -1.0,   "PX36_SEL":  0.0,    "PX36_SEL_HI":  0.0},
    "T3":      {"NOx15":  0.065, "CO15":  0.0,   "PX36_SEL":  0.0,    "PX36_SEL_HI":  0.0},
}

# DT_Main piecewise slopes for PX36 outputs (linear up to clamp, then flat).
# Same slope as the original _DERIV row, just with an upper clamp added so
# very wide IM-vs-OM spreads don't keep dragging PX36 down indefinitely.
_DT_MAIN_PX36_SEL_SLOPE    = -0.004    # psi/°F — same magnitude as old _DERIV
_DT_MAIN_PX36_SEL_HI_SLOPE = -0.0004   # psi/°F — same magnitude as old _DERIV
_DT_MAIN_PX36_CLAMP_F      = 650.0     # above this DT_Main, contribution is frozen

# NOx15 piecewise DT_Main (linear above the floor, frozen below). The
# slope direction means low DT_Main → reduced NOx; the floor stops that
# reduction from growing without bound when DT_Main pushes well below
# typical operating values.
_DT_MAIN_NOX15_SLOPE  = 0.0375  # ppm/°F — same magnitude as old _DERIV
_DT_MAIN_NOX15_FLOOR_F = 150.0  # below this DT_Main, contribution is frozen

# CO15 piecewise DT_Main (linear → flat plateau → reversed). The
# generic linear loop would push CO15 deeply negative at low DT_Main
# (slope is 11x stronger than NOx); the flat plateau caps the reduction
# at DT_Main = 75 °F and the reversed slope below 25 °F brings CO15
# back UP — physically the kinetic floor + IM-cold-spot dynamics flip
# direction once the spread is very flat.
_DT_MAIN_CO15_SLOPE     = 0.424  # ppm/°F (above 75 °F) — same as old _DERIV
_DT_MAIN_CO15_FLAT_HI_F = 75.0   # above this, slope = +0.424
_DT_MAIN_CO15_FLAT_LO_F = 25.0   # below this, slope = -0.424; in between, slope = 0

# Phi_IP activation threshold. Below this the IP derivative contributes 0.
_PHI_IP_FLOOR = 0.25

# P3 scaling exponents: Y_final = Y_mult × (P3 / P3_ref)^exponent
_P3_EXP = {
    "NOx15":       0.467,
    "CO15":       -1.0,
    "PX36_SEL":    1.35,    # bumped 2026-05-02 (1.00 → 1.35); slightly
                            # super-linear P3 sensitivity layered on top of
                            # the new T_Bulk derivative.
                            # (Earlier excursions: 0.50 → 0.56 → 0.60 → 0.65
                            #  → 0.75 → 0.90 → 1.50 → 1.70 → 1.00 → 1.35)
    "PX36_SEL_HI": 0.44,
}


# ----- helpers ---------------------------------------------------------------

def _K_to_F(T_K: float) -> float:
    return (float(T_K) - 273.15) * 9.0 / 5.0 + 32.0


def _nox15_tflame_contribution(Tflame_F: float,
                                Tref_F: float = 3035.0,
                                brk_hi_F: float = 2850.0,
                                brk_lo_F: float = 2750.0,
                                slope_hi: float = 0.12,
                                slope_mid: float = 0.04,
                                slope_lo: float = 0.0) -> float:
    """Piecewise-integrated NOx15 contribution from Tflame.

    The ∂NOx15/∂Tflame is a step function of Tflame:
        Tflame ≥ 2850 °F       → slope = 0.12   ppm/°F
        2750 ≤ Tflame < 2850   → slope = 0.04   ppm/°F
        Tflame < 2750 °F       → slope = 0.0    ppm/°F  (frozen)

    This function returns the running integral of that slope from the
    reference temperature (3035 °F) down to `Tflame_F`, so the final
    contribution is continuous at every breakpoint — no jumps as Tflame
    crosses 2850 or 2750.
    """
    T = float(Tflame_F)
    # High regime — single linear segment
    if T >= brk_hi_F:
        return slope_hi * (T - Tref_F)
    # Middle regime — 0.12 all the way down to 2850, then 0.04 below
    if T >= brk_lo_F:
        return slope_hi * (brk_hi_F - Tref_F) + slope_mid * (T - brk_hi_F)
    # Low regime — frozen at the running total at 2750
    return slope_hi * (brk_hi_F - Tref_F) + slope_mid * (brk_lo_F - brk_hi_F) \
           + slope_lo * (T - brk_lo_F)


def _px36_dt_main_contribution(DT_Main_F: float,
                                slope_per_F: float,
                                DT_ref_F:   float = 450.0,
                                DT_clamp_F: float = _DT_MAIN_PX36_CLAMP_F) -> float:
    """Piecewise PX36 contribution from DT_Main, linear up to DT_clamp_F
    then frozen at the clamp value.

    DT_Main < DT_clamp_F → slope_per_F × (DT_Main − DT_ref_F)
    DT_Main ≥ DT_clamp_F → slope_per_F × (DT_clamp_F − DT_ref_F)

    Used for both PX36_SEL (slope -0.004 psi/°F) and PX36_SEL_HI
    (slope -0.0004 psi/°F). The clamp keeps very wide IM/OM spreads
    from continuing to drag PX36 down — physically the dynamics signal
    saturates once DT_Main pushes past 650 °F. NOx15 has its own
    piecewise helper (_nox15_dt_main_contribution, floor at 150 °F);
    CO15 has its own piecewise helper (_co15_dt_main_contribution,
    flat plateau 25–75 °F + reversed slope below).
    """
    DT = float(DT_Main_F)
    DT_clamped = min(DT_clamp_F, DT)
    return slope_per_F * (DT_clamped - DT_ref_F)


def _co15_dt_main_contribution(DT_Main_F: float,
                                slope_per_F:  float = _DT_MAIN_CO15_SLOPE,
                                DT_ref_F:     float = 450.0,
                                DT_flat_hi_F: float = _DT_MAIN_CO15_FLAT_HI_F,
                                DT_flat_lo_F: float = _DT_MAIN_CO15_FLAT_LO_F) -> float:
    """Piecewise CO15 contribution from DT_Main:

      DT_Main > DT_flat_hi_F (75 °F)      → slope_per_F × (DT_Main − DT_ref_F)
      DT_flat_lo_F ≤ DT ≤ DT_flat_hi_F    → flat plateau at the value reached
                                            at DT_flat_hi_F
                                            = slope × (75 − 450) = −159.0 ppm
      DT_Main < DT_flat_lo_F (25 °F)      → reversed slope (−slope_per_F)
                                            applied below 25 °F
                                            = -159 + (−slope) × (DT − 25)

    The integral is continuous at both breakpoints (75 and 25 °F).

    Slope direction: above 75 °F a wider IM/OM spread ↑ CO (cold-spot
    region grows). In [25, 75] the contribution flattens — incremental
    spread changes don't add CO. Below 25 °F the slope reverses: the
    spread is so flat that further reduction stops making things worse
    and a kinetic-floor / IM-cold-spot dynamics flip dominates,
    nudging CO back up.
    """
    DT = float(DT_Main_F)
    plateau = slope_per_F * (DT_flat_hi_F - DT_ref_F)
    if DT >= DT_flat_hi_F:
        return slope_per_F * (DT - DT_ref_F)
    if DT >= DT_flat_lo_F:
        return plateau
    # Below the flat plateau: reversed slope = -slope_per_F
    return plateau + (-slope_per_F) * (DT - DT_flat_lo_F)


def _nox15_dt_main_contribution(DT_Main_F: float,
                                 slope_per_F: float = _DT_MAIN_NOX15_SLOPE,
                                 DT_ref_F:    float = 450.0,
                                 DT_floor_F:  float = _DT_MAIN_NOX15_FLOOR_F) -> float:
    """Piecewise NOx15 contribution from DT_Main: linear above the 150 °F
    floor, frozen below.

    DT_Main > DT_floor_F → slope_per_F × (DT_Main − DT_ref_F)
    DT_Main ≤ DT_floor_F → slope_per_F × (DT_floor_F − DT_ref_F)
                           = +0.0375 × (150 − 450) = −11.25 ppm  [frozen]

    Slope direction (+0.0375 ppm/°F) means a wider IM/OM spread (larger
    DT_Main) pushes NOx UP — physically the larger spread implies a
    hotter peak flame zone, exponentially more thermal NOx. Conversely,
    a very flat split (small DT_Main) reduces NOx — but only down to a
    floor: at DT_Main below ~150 °F the engine isn't realistically
    operating in that condition AND the linear extrapolation would
    eventually drive the contribution past −16.875 ppm (DT_Main → 0 °F),
    which is more reduction than the operating envelope supports. The
    floor stops the reduction from growing without bound.
    """
    DT = float(DT_Main_F)
    DT_clamped = max(DT_floor_F, DT)
    return slope_per_F * (DT_clamped - DT_ref_F)


def _px36_sel_tflame_contribution(Tflame_F: float,
                                   Tref_F: float = 3035.0,
                                   T_lo_F:  float = 2950.0,
                                   T_hi_F:  float = 3060.0,
                                   slope_per_F: float = 0.318 / 50.0) -> float:
    """Piecewise-linear PX36_SEL contribution from T_Bulk (Tflame).

    Slope is +0.318 psi per +50 °F (≈ +0.00636 psi/°F), centered on the
    LMS100 reference Tflame_F = 3035 °F. Clamps:
        Tflame ≤ 2950 °F  → contribution frozen at the 2950 °F value
                            (= -0.541 psi)        # was 2900 °F → -0.859 psi
        2950 < Tflame < 3060 → linear: slope_per_F × (Tflame - 3035)
        Tflame ≥ 3060 °F  → contribution frozen at the 3060 °F value
                            (= +0.159 psi)

    Returns the additive psi shift on PX36_SEL. Applied BEFORE the
    (P3/638)^exp pressure scaling so it composes multiplicatively
    with the pressure correction at the same operating point.
    Sign convention: positive ↑ T_Bulk → positive ↑ PX36_SEL.
    """
    T = float(Tflame_F)
    T_clamped = max(T_lo_F, min(T_hi_F, T))
    return slope_per_F * (T_clamped - Tref_F)


def _phi_OP_multiplier(phi_OP: float) -> float:
    """1.0 for φ ≥ 0.55, 0.8 for φ ≤ 0.45, linear interp between."""
    p = float(phi_OP)
    if p >= 0.55:
        return 1.0
    if p <= 0.45:
        return 0.8
    # Linear interpolation across the 0.10 band.
    return 0.8 + (1.0 - 0.8) * (p - 0.45) / (0.55 - 0.45)


def _T_AFT(fuel_pct: Dict[str, float], ox_pct: Dict[str, float], phi: float,
           T_fuel_K: float, T_air_K: float, P_bar: float,
           WFR: float, water_mode: str) -> float:
    """Per-circuit / bulk-zone adiabatic flame T via Cantera HP-equilibrium.

    Uses the exact same path the Cycle panel uses for T_Bulk
    (`cycle._t_bulk_with_mix_and_water`):
      - 3-stream enthalpy mix of fuel @ T_fuel_K + air @ T_air_K + optional
        water (liquid h_fg or steam) at the given φ
      - Cantera HP-equilibrium (full Gibbs minimization, with NO/OH/O/H
        dissociation) on the mixed reactants

    This guarantees the Mapping panel's per-circuit T_AFT values and the
    new T_Bulk in the snapshot bar all line up with the Cycle panel's T_Bulk
    when the air trees agree (W36/W3 ↔ combustor_bypass_frac).

    If phi ≈ 0 (no fuel — e.g. a deactivated pilot circuit), short-circuit
    to T_air_K — no fuel means no heat release means the stream stays at T3.
    Cantera's set_equivalence_ratio(0, ...) is a degenerate case best
    avoided.
    """
    if phi < 1e-4:
        return float(T_air_K)
    try:
        return float(_hp_eq_with_water(
            fuel_pct, ox_pct,
            T_fuel_K=float(T_fuel_K), T_air_K=float(T_air_K),
            P_bar=float(P_bar), phi=float(phi),
            WFR=float(WFR), water_mode=str(water_mode),
        ))
    except Exception:
        return float(T_air_K)


# ----- main entry ------------------------------------------------------------

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
    WFR: float = 0.0,
    water_mode: str = "liquid",
    nox_mult: float = 1.0,
    co_mult: float = 1.0,
    px36_mult: float = 1.0,
) -> dict:
    """Run the 4-circuit correlation-based mapping for any operating point."""

    # --- air accounting ------------------------------------------------------
    w36w3 = max(0.0, min(1.0, float(W36_over_W3)))
    caf   = max(0.0, min(1.0, float(com_air_frac)))
    W36 = float(W3_kg_s) * w36w3
    flame_air   = W36 * caf
    cooling_air = W36 * (1.0 - caf)

    m_air_IP = flame_air * float(frac_IP_pct) / 100.0
    m_air_OP = flame_air * float(frac_OP_pct) / 100.0
    m_air_IM = flame_air * float(frac_IM_pct) / 100.0
    m_air_OM = flame_air * float(frac_OM_pct) / 100.0

    # --- stoichiometry (FAR_stoich is phi-independent) ----------------------
    _FAR, FAR_stoich, _AFR, _AFR_s = compute_ratios(fuel_pct, ox_pct, 1.0)

    m_fuel_IP = m_air_IP * float(phi_IP) * FAR_stoich
    m_fuel_OP = m_air_OP * float(phi_OP) * FAR_stoich
    m_fuel_IM = m_air_IM * float(phi_IM) * FAR_stoich
    m_fuel_OM_raw = float(m_fuel_total_kg_s) - m_fuel_IP - m_fuel_OP - m_fuel_IM
    m_fuel_OM = max(0.0, m_fuel_OM_raw)
    FAR_OM = (m_fuel_OM / m_air_OM) if m_air_OM > 0 else 0.0
    phi_OM = (FAR_OM / FAR_stoich) if FAR_stoich > 0 else 0.0
    phi_OM_clamped = min(max(phi_OM, 0.0), 3.0)
    fuel_residual = float(m_fuel_total_kg_s) - (m_fuel_IP + m_fuel_OP + m_fuel_IM + m_fuel_OM)

    # --- per-circuit T_AFT (complete-combustion) ----------------------------
    T_AFT_IP = _T_AFT(fuel_pct, ox_pct, phi_IP,         T_fuel_K, T3_K, P3_bar, WFR, water_mode)
    T_AFT_OP = _T_AFT(fuel_pct, ox_pct, phi_OP,         T_fuel_K, T3_K, P3_bar, WFR, water_mode)
    T_AFT_IM = _T_AFT(fuel_pct, ox_pct, phi_IM,         T_fuel_K, T3_K, P3_bar, WFR, water_mode)
    T_AFT_OM = _T_AFT(fuel_pct, ox_pct, phi_OM_clamped, T_fuel_K, T3_K, P3_bar, WFR, water_mode)

    circuits_out = {
        "IP": {"phi": float(phi_IP),         "m_air_kg_s": m_air_IP, "m_fuel_kg_s": m_fuel_IP, "T_AFT_complete_K": T_AFT_IP},
        "OP": {"phi": float(phi_OP),         "m_air_kg_s": m_air_OP, "m_fuel_kg_s": m_fuel_OP, "T_AFT_complete_K": T_AFT_OP},
        "IM": {"phi": float(phi_IM),         "m_air_kg_s": m_air_IM, "m_fuel_kg_s": m_fuel_IM, "T_AFT_complete_K": T_AFT_IM},
        "OM": {"phi": float(phi_OM_clamped), "m_air_kg_s": m_air_OM, "m_fuel_kg_s": m_fuel_OM, "T_AFT_complete_K": T_AFT_OM},
    }

    # --- derived quantities --------------------------------------------------
    # DT_Main: °F difference between OM and IM flame temperatures (Δ K × 1.8)
    DT_Main_F = (T_AFT_OM - T_AFT_IM) * 1.8

    # Tflame ≡ T_Bulk: single-zone Cantera HP-equilibrium adiabatic flame T
    # at the bulk equivalence ratio. We sum all four circuits' air + all the
    # fuel, form the bulk FAR, derive φ_Bulk, and burn that mixture once via
    # Cantera (same HP-equilibrium path as the per-circuit T_AFT calls — but
    # called once on the aggregate, not four times on the splits).
    #
    # Why this and not the prior 4-circuit mass-weighted average:
    #   The NOx correlation reference (Tflame_ref = 3035 °F) was anchored on
    #   the cycle's single-zone T_Bulk. The mass-weighted average of four
    #   separately-burning circuits is a different physical quantity and runs
    #   ~70-120 °F cooler (Jensen's inequality on the concave T_AFT(φ) curve,
    #   plus dilution from any φ ≈ 0 dead circuits like a deactivated pilot).
    #   Using the single-zone T here keeps the evaluation consistent with the
    #   calibration anchor and matches the cycle's reported T_Bulk to within
    #   the air-tree mismatch (W36/W3 vs combustor_bypass_frac), which is a
    #   separate knob and tackled in the UI layer.
    flame_air_total = m_air_IP + m_air_OP + m_air_IM + m_air_OM
    if flame_air_total > 0 and FAR_stoich > 0:
        FAR_Bulk = float(m_fuel_total_kg_s) / flame_air_total
        phi_Bulk = FAR_Bulk / FAR_stoich
    else:
        FAR_Bulk = 0.0
        phi_Bulk = 0.0
    Tflame_K = _T_AFT(fuel_pct, ox_pct, phi_Bulk,
                      T_fuel_K, T3_K, P3_bar, WFR, water_mode)
    Tflame_F = _K_to_F(Tflame_K)
    T3_F     = _K_to_F(T3_K)
    P3_psia  = float(P3_bar) * 14.5038

    # Propane-equivalent ("C3_eff") rolls every higher-than-CH4 hydrocarbon
    # into a single equivalent mole-percent that drives the NOx/CO/PX36
    # correlation. C2-class species get the empirical 0.8 coefficient from
    # the original calibration; C3 and every heavier hydrocarbon contribute
    # at 1.0 (treated as propane-equivalent on a mole basis).
    #
    #   Species              coefficient
    #   C2H6 / C2H4 / C2H2   0.8
    #   C3H8                 1.0
    #   C4H10                1.0
    #   C5H12                1.0
    #   C6H14                1.0
    #   C7H16                1.0
    #   C8H18                1.0
    C2_pct = (float(fuel_pct.get("C2H6", 0.0))
              + float(fuel_pct.get("C2H4", 0.0))
              + float(fuel_pct.get("C2H2", 0.0)))
    Cge3_pct = (float(fuel_pct.get("C3H8",  0.0))
                + float(fuel_pct.get("C4H10", 0.0))
                + float(fuel_pct.get("C5H12", 0.0))
                + float(fuel_pct.get("C6H14", 0.0))
                + float(fuel_pct.get("C7H16", 0.0))
                + float(fuel_pct.get("C8H18", 0.0)))
    C3_eff = 0.8 * C2_pct + Cge3_pct
    N2_pct = float(fuel_pct.get("N2", 0.0))

    # --- correlation chain ---------------------------------------------------
    # Phi_IP contribution is one-sided: only the portion of phi_IP ABOVE
    # _PHI_IP_FLOOR (= 0.25) contributes. For phi_IP ≤ 0.25 the IP derivative
    # contributes zero — physically this means a lean pilot at or below 0.25
    # is not hot enough to drive emissions above the baseline already captured
    # by the other terms.
    phi_IP_delta_positive = max(0.0, float(phi_IP) - _PHI_IP_FLOOR)
    deltas = {
        "DT_Main": DT_Main_F - _REFPT["DT_Main_F"],
        "N2":      N2_pct    - _REFPT["N2_pct"],
        "C3":      C3_eff    - _REFPT["C3_pct"],
        "Phi_OP":  float(phi_OP) - _REFPT["Phi_OP"],
        "Phi_IP":  phi_IP_delta_positive,
        "Tflame":  Tflame_F  - _REFPT["Tflame_F"],
        "T3":      T3_F      - _REFPT["T3_F"],
    }
    pressure_ratio = P3_psia / _REFPT["P3_psia"]
    phi_op_mult = _phi_OP_multiplier(phi_OP)

    y_lin: Dict[str, float] = {}
    y_100pct: Dict[str, float] = {}   # after linear + phi_OP mult, before P3 scaling
    y_final: Dict[str, float] = {}

    for name in ("NOx15", "CO15", "PX36_SEL", "PX36_SEL_HI"):
        # Step 1: linear corrections
        y = _REF[name]
        for key in ("DT_Main", "N2", "C3", "Phi_OP", "Phi_IP", "Tflame", "T3"):
            y += _DERIV[key][name] * deltas[key]
        # NOx15 gets a piecewise-integrated Tflame contribution on top of the
        # generic linear step (which contributes 0 for NOx15, intentionally).
        # NOx15 also gets a piecewise DT_Main contribution: linear above
        # the 150 °F floor, frozen below — so very flat IM/OM splits don't
        # keep dragging NOx down without bound.
        if name == "NOx15":
            y += _nox15_tflame_contribution(Tflame_F)
            y += _nox15_dt_main_contribution(DT_Main_F)
        # CO15 gets a piecewise DT_Main contribution: linear above 75 °F,
        # flat plateau between 25–75, reversed slope below 25.
        if name == "CO15":
            y += _co15_dt_main_contribution(DT_Main_F)
        # PX36_SEL gets a clamped-linear Tflame contribution (anchored at
        # 3035 °F, slope +0.318 psi per +50 °F, frozen below 2950 °F and
        # above 3060 °F). PX36_SEL_HI is intentionally NOT given a Tflame
        # term — only the low-frequency trace responds to bulk flame T.
        if name == "PX36_SEL":
            y += _px36_sel_tflame_contribution(Tflame_F)
        # PX36_SEL and PX36_SEL_HI get a clamped-linear DT_Main term:
        # the slope (matching the old _DERIV magnitudes) is active up to
        # DT_Main = 650 °F, then frozen so very wide spreads stop pushing
        # the dynamics signal indefinitely.
        if name == "PX36_SEL":
            y += _px36_dt_main_contribution(DT_Main_F, _DT_MAIN_PX36_SEL_SLOPE)
        elif name == "PX36_SEL_HI":
            y += _px36_dt_main_contribution(DT_Main_F, _DT_MAIN_PX36_SEL_HI_SLOPE)
        y_lin[name] = y

        # Step 2: Phi_OP multiplier (ONLY for PX36_SEL_HI)
        y_m = y * phi_op_mult if name == "PX36_SEL_HI" else y
        y_100pct[name] = y_m

        # Step 3: P3 power-law scaling
        y_f = y_m * (pressure_ratio ** _P3_EXP[name])
        y_final[name] = y_f

    # Step 4: Emissions Transfer Function — BRNDMD-dependent post-multipliers
    # on NOx15, CO15 and PX36_SEL. Applied at all three output stages so
    # the panel's "linear / 100% / final" diagnostic numbers stay consistent.
    # PX36_SEL_HI does not get a post-multiplier (its tuning lives in the
    # Phi_OP-multiplier branch; adding another knob would double-count).
    nm = max(0.0, float(nox_mult))
    cm = max(0.0, float(co_mult))
    pm = max(0.0, float(px36_mult))
    y_lin["NOx15"]    *= nm; y_100pct["NOx15"]    *= nm; y_final["NOx15"]    *= nm
    y_lin["CO15"]     *= cm; y_100pct["CO15"]     *= cm; y_final["CO15"]     *= cm
    y_lin["PX36_SEL"] *= pm; y_100pct["PX36_SEL"] *= pm; y_final["PX36_SEL"] *= pm

    # --- response -----------------------------------------------------------
    return {
        "circuits": circuits_out,
        "air_accounting": {
            "W3_kg_s":        float(W3_kg_s),
            "W36_kg_s":       float(W36),
            "flame_air_kg_s": float(flame_air),
            "cooling_air_kg_s": float(cooling_air),
        },
        "phi_OM": float(phi_OM),
        "FAR_stoich": float(FAR_stoich),
        "fuel_residual_kg_s": float(fuel_residual),
        "derived": {
            "DT_Main_F":       float(DT_Main_F),
            "Tflame_K":        float(Tflame_K),
            "Tflame_F":        float(Tflame_F),
            "T_Bulk_K":        float(Tflame_K),   # alias — single-zone bulk T
            "T_Bulk_F":        float(Tflame_F),
            "phi_Bulk":        float(phi_Bulk),
            "FAR_Bulk":        float(FAR_Bulk),
            "T3_F":            float(T3_F),
            "P3_psia":         float(P3_psia),
            "C3_effective_pct": float(C3_eff),
            "N2_pct":          float(N2_pct),
            "phi_OP_mult":     float(phi_op_mult),
            "pressure_ratio":  float(pressure_ratio),
        },
        "correlations": {
            "NOx15":       float(y_final["NOx15"]),
            "CO15":        float(y_final["CO15"]),
            "PX36_SEL":    float(y_final["PX36_SEL"]),
            "PX36_SEL_HI": float(y_final["PX36_SEL_HI"]),
        },
        "correlations_100pct_load": {
            "NOx15":       float(y_100pct["NOx15"]),
            "CO15":        float(y_100pct["CO15"]),
            "PX36_SEL":    float(y_100pct["PX36_SEL"]),
            "PX36_SEL_HI": float(y_100pct["PX36_SEL_HI"]),
        },
        "correlations_linear": {
            "NOx15":       float(y_lin["NOx15"]),
            "CO15":        float(y_lin["CO15"]),
            "PX36_SEL":    float(y_lin["PX36_SEL"]),
            "PX36_SEL_HI": float(y_lin["PX36_SEL_HI"]),
        },
        "reference": {
            "values":     dict(_REF),
            "conditions": dict(_REFPT),
        },
    }
