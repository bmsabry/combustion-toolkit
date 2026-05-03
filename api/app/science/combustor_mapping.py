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
    "DT_Main": {"NOx15": 0.0375, "CO15":  0.424, "PX36_SEL": -0.004,  "PX36_SEL_HI": -0.0004},
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

# Phi_IP activation threshold. Below this the IP derivative contributes 0.
_PHI_IP_FLOOR = 0.25

# P3 scaling exponents: Y_final = Y_mult × (P3 / P3_ref)^exponent
_P3_EXP = {
    "NOx15":       0.467,
    "CO15":       -1.0,
    "PX36_SEL":    0.65,    # bumped 2026-05-02 (0.50 → 0.56 → 0.60 → 0.65);
                            # stronger P3 sensitivity on the low-freq acoustic trace
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
        if name == "NOx15":
            y += _nox15_tflame_contribution(Tflame_F)
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
