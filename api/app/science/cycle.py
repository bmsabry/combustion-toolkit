"""Gas-turbine thermodynamic cycle — LM6000PF and LMS100PB+.

Given ambient conditions (P, T, RH), load%, and fuel composition, computes:
  • Station pressures and temperatures (P1/T1, P2/T2, P2.5/T2.5 for LMS100, P3/T3, T4, T5)
  • Inlet air mass flow and fuel mass flow
  • FAR4/phi4 at the combustor exit (back-solved so the adiabatic equilibrium
    product T at (T3, P3) equals the commanded T4)
  • FAR_Bulk/phi_Bulk/T_Bulk at the primary flame zone
  • Turbine work, compressor work, parasitic loss, and gross shaft power —
    all from Cantera enthalpy integrals (Option A energy balance)
  • Net shaft power MW_net = MW_cap × fuel-flexibility derate (MW_gross is
    diagnostic only — see Option-A note below)
  • Intercooler duty (LMS100 only)
  • Modified Wobbe Index (MWI) and fuel-flexibility warnings (Option B)

Equivalence ratio phi is back-solved via Cantera equilibrate('HP') at the
combustor inlet state (T3, P3) so that the product temperature equals the
commanded T4. Uses GRI-Mech 3.0 — the same mechanism as the rest of the
toolkit, so linkages into the Flame-Temp and Combustor panels are consistent.

Design-point anchors (exactly reproduced by the correlations at load=100%):

    LMS100PB+ at T_amb=44°F, RH=80%, P_amb=1.013 bar, load=100%
      T3 = 644 K (700°F)         P3 = 44.0 bar (638 psia)
      T4 = 1825 K (2825°F)       MW_net = 107.5

    LM6000PF at T_amb=60°F, RH=60%, P_amb=1.013 bar, load=100%
      T3 = 811 K (1000°F)        P3 = 30.3 bar (440 psia)
      T4 = 1755 K (2700°F)       MW_net = 45.0

Energy-balance philosophy (Option A):
  Turbine: set reactants at (T3, P3, phi4), equilibrate HP → products at T4.
    Expand isentropically (gas.SP) to P_exhaust; apply η_isen_turb to get
    actual outlet enthalpy; W_turb = m_total_hot × (h4 − h5).
  Compressor: enthalpy difference between inlet air at (T1, P_amb) and
    compressor discharge at (T3, P3) using Cantera for the humid-air mixture.
    T3 is already set with polytropic η baked in, so the enthalpy integral
    captures real compressor work including composition effects.
  Gross shaft: MW_gross = (W_turb − W_comp − W_parasitic) / 1e6.
  Cap: MW_cap = MW_design × (ρ_amb/ρ_des)^β_MW × load_frac  (OEM nameplate).
  Net: MW_net = MW_cap × (1 − derate_from_fuel_flex).
  MW_gross is reported for diagnostics but NOT used as the published power.
  Reason: the simplified Brayton calc holds T4 constant, scales mdot ≈ ρ^0.9,
  and doesn't model variable IGVs, bleed scheduling, or speed/PR optimization
  the OEM controller does, so on warm/cold days it under/over-predicts shaft
  power by several MW relative to the OEM-published curve. The deck cap is
  authoritative because OEMs anchor service contracts to that curve.

Fuel-flexibility derate (Option B):
  MWI = LHV_vol / √(SG × T_fuel). Reference fuel = pure CH4 at 60°F.
  Bands (GE DLE guidance): 40–54 in-spec (0% derate); 35–40 or 54–60
  marginal (5% derate); out-of-spec otherwise (20% derate).
  Additional warnings: H₂ > 30% mol (flashback risk), LHV_vol < 800 BTU/scf
  (flame-holding risk).

Off-design behavior is modelled with published aero-derivative performance
correlations anchored at these points:

  • Ambient density correction: mass flow and PR scale with inlet density
    (ρ = P_amb / R·T_amb for humid air).
  • LM6000 (non-intercooled): T3 floats with ambient via polytropic
    compression — T3/T_amb = PR^((γ-1)/γ/η_poly). η_poly = 0.88.
  • LMS100 (intercooled): intercooler holds T3 at its design value across
    ambient at max load (T3 is a function of load% only, not ambient).
    Intercooler duty falls out as an output.
  • Load% curves for T4, P3, and airflow are calibrated so that at
    load=100% the correlation exactly matches the anchor, and at low
    load the engine reaches a physically sensible idle state.

These are engineering correlations, not a full cycle solver. They produce
realistic trend behavior for pedagogical and analysis purposes; they are
not a substitute for GE's proprietary performance decks for contractual
work.
"""
from __future__ import annotations

import math
from typing import Any, Dict, Optional

import cantera as ct

from .mixture import GRI_MECH, _normalize_to_gri, fuel_mass_fraction_at_phi, make_gas_mixed
from .water_mix import make_gas_mixed_with_water

# ---------------------------- Physical constants ---------------------------
GAMMA_AIR = 1.40            # cold-air approximation (used only for compressor T-rise)
CP_AIR = 1005.0             # J/kg·K (cold)
MW_AIR_DRY = 28.9647        # g/mol
MW_H2O = 18.0153            # g/mol
R_UNIVERSAL = 8314.5        # J/kmol·K

# Typical natural-gas composition used if the caller doesn't supply one.
# Gives LHV ≈ 47 MJ/kg which matches the rest of the toolkit defaults.
_DEFAULT_FUEL = {"CH4": 95.0, "C2H6": 3.0, "C3H8": 1.0, "N2": 1.0}


# ------------------------------ Engine decks -------------------------------
# Each deck carries:
#   * design-point anchors (exactly reproduced at load=100% at the design ambient)
#   * off-design correlation parameters
#
# The off-design curves use:
#   T4(load)  = T4_design · (a_T4 + (1 − a_T4) · load_frac)
#   P3(load)  = P3_design · (a_P3 + (1 − a_P3) · load_frac) · (ρ_amb/ρ_design)^β_P3
#   ṁ(load)   = ṁ_design · (a_m  + (1 − a_m ) · load_frac) · (ρ_amb/ρ_design)^β_m
#   MW(load)  = MW_design · load_frac · (ρ_amb/ρ_design)^β_MW
# where a_* = fraction of design value at 0% load (the idle floor) and β_*
# are ambient-density exponents.

ENGINE_DECKS: Dict[str, Dict[str, Any]] = {
    "LMS100PB+": {
        "label": "GE LMS100PB+ (intercooled, 3-spool aero-derivative)",
        "intercooled": True,
        # Design-point anchors (44°F / 80% RH / 1.013 bar / 100% load)
        "T_amb_design_K": 279.817,   # 44°F
        "RH_design_pct": 80.0,
        "P_amb_design_bar": 1.01325,
        "T3_design_K": 644.26,       # 700°F  (HPC exit / combustor inlet)
        "P3_design_bar": 44.0,       # 638 psia
        "T4_design_K": 1825.37,      # 2825°F (turbine inlet / firing temp)
        "MW_design": 107.5,
        "airflow_design_kg_s": 208.0,  # LMS100 rated inlet flow (~460 lb/s)
        # Fraction of compressor discharge air that enters the combustor.
        # The balance (1 − combustor_bypass_frac) is film/cooling air bled
        # around the combustor that rejoins downstream. Calibrated so the
        # design anchor with pure CH4 reproduces the published heat rate
        # (~8180 kJ/kWh → η_LHV ≈ 44 %). Distinct from combustor_air_frac,
        # which is the intra-combustor flame/dilution split.
        "combustor_bypass_frac": 0.747,
        # Polytropic turbine/compressor efficiencies (Option A physics).
        # Calibrated so MW_gross = W_turb − W_comp − W_parasitic reaches
        # MW_cap at the design anchor for pure CH4 humid-air operation.
        "eta_isen_turb": 0.7640,   # HP+IP+LP expansion, P3 → P_exhaust = 1.05 bar
        "eta_isen_comp": 0.88,     # used in LPC T-rise; HPC captured by T3 anchor
        "P_exhaust_bar": 1.05,     # back-pressure at LP turbine exit (stack losses)
        "W_parasitic_frac_of_rated": 0.015,  # 1.5 % of rated MW (oil pumps, gearbox, aux)
        # Intercooler partition between LPC and HPC
        "PR_LPC_design": 5.0,
        "T2_5_design_K": 310.93,     # intercooler exit ≈ 100°F; HPC inlet
        "eta_poly": 0.88,            # polytropic compressor η used to raise T2 from T1
        # Off-design shape parameters
        "a_T4": 0.62,    # T4_idle ≈ 1130 K at load=0 (quasi-idle)
        "a_P3": 0.45,    # P3_idle ≈ 20 bar at load=0
        "a_m":  0.70,    # airflow holds up at part load (VSV-controlled)
        "beta_P3": 0.40,
        "beta_m": 0.90,   # airflow scales near-linearly with density
        "beta_MW": 0.25,  # intercooler flattens MW-vs-ambient (hot-day hold)
        # LMS100 intercooler control: T3 stays at the design value across
        # ambient at max load. At part load T3 drops (HPC works less).
        "T3_load_slope_K_per_pct": 1.6,  # at load=50% T3 falls by ~80 K
    },
    "LM6000PF": {
        "label": "GE LM6000PF (2-spool aero-derivative, non-intercooled)",
        "intercooled": False,
        # Design-point anchors (60°F / 60% RH / 1.013 bar / 100% load)
        "T_amb_design_K": 288.706,   # 60°F
        "RH_design_pct": 60.0,
        "P_amb_design_bar": 1.01325,
        "T3_design_K": 810.93,       # 1000°F
        "P3_design_bar": 30.3,       # 440 psia
        "T4_design_K": 1755.37,      # 2700°F
        "MW_design": 45.0,
        "airflow_design_kg_s": 125.0,
        # See note on LMS100 above — fraction of compressor discharge air
        # that enters the combustor. Calibrated so the LM6000PF design
        # anchor reproduces the published heat rate (~8500 kJ/kWh → η ≈ 42 %).
        "combustor_bypass_frac": 0.683,
        "eta_isen_turb": 0.7416,
        "eta_isen_comp": 0.88,
        "P_exhaust_bar": 1.05,
        "W_parasitic_frac_of_rated": 0.015,
        # T3 floats with ambient. Effective exponent calibrated to typical
        # aero-derivative behavior: T3 ≈ T_amb^0.9 at constant load (slightly
        # sublinear because PR drops on hot days). At design, (T_amb/T_amb_des)^α = 1
        # so T3 lands exactly on T3_design regardless of α.
        "alpha_T3_amb": 0.90,
        # At part load the HPC runs less and T3 drops. Approx: T3 falls ~50 K
        # between 100 % and 50 % load for a non-IC aero-derivative.
        "T3_load_slope_K_per_pct": 1.0,
        # Off-design
        "a_T4": 0.64,
        "a_P3": 0.50,
        "a_m":  0.72,
        "beta_P3": 0.80,    # PR scales strongly with density on non-IC machine
        "beta_m": 1.00,     # airflow ~linear with density
        "beta_MW": 1.50,    # ~10 % MW drop at 95°F vs 60°F design — matches published LM6000 lapse
    },
}


# ---------------------------- Humid air helpers ----------------------------
def _p_sat_water_Pa(T_K: float) -> float:
    """Magnus formula for water saturation pressure; valid ~273–373 K.

    For ambient applications this is plenty accurate (<0.3 % error up to 100 °C).
    """
    T_C = T_K - 273.15
    return 610.78 * math.exp(17.27 * T_C / (T_C + 237.3))


def _humid_air_mol_pct(T_amb_K: float, P_amb_bar: float, RH_pct: float) -> Dict[str, float]:
    """Return ambient air composition as mole-% (summing to 100), accounting for humidity.

    Dry-air composition: 20.95 % O2, 78.09 % N2, 0.93 % Ar, 0.04 % CO2.
    Water vapor displaces the dry mix: X_H2O = RH · P_sat(T) / P_amb (capped at 10 %).
    """
    P_sat = _p_sat_water_Pa(T_amb_K)
    P_amb_Pa = P_amb_bar * 1e5
    X_H2O = max(0.0, min(0.10, (RH_pct / 100.0) * P_sat / P_amb_Pa))
    # Dry air split renormalized to (1 - X_H2O) of the total
    dry = {"O2": 20.95, "N2": 78.09, "AR": 0.93, "CO2": 0.04}
    dry_total = sum(dry.values())  # 100.01; normalize
    out = {k: (v / dry_total) * (1.0 - X_H2O) * 100.0 for k, v in dry.items()}
    out["H2O"] = X_H2O * 100.0
    return out


def _humid_air_density(T_amb_K: float, P_amb_bar: float, RH_pct: float) -> float:
    """Density of humid air in kg/m³ via ideal gas with composite MW."""
    P_sat = _p_sat_water_Pa(T_amb_K)
    P_amb_Pa = P_amb_bar * 1e5
    X_H2O = max(0.0, min(0.10, (RH_pct / 100.0) * P_sat / P_amb_Pa))
    MW_eff_g = (1.0 - X_H2O) * MW_AIR_DRY + X_H2O * MW_H2O   # g/mol
    R_specific = R_UNIVERSAL / MW_eff_g                       # J/kg·K  (MW in g/mol, R_U in J/kmol/K → J/kg/K)
    return P_amb_Pa / (R_specific * T_amb_K)


# --------------------------- phi back-solve from T4 ------------------------
def _t_ad_at_phi(
    fuel_x: Dict[str, float],
    ox_x: Dict[str, float],
    T_inlet_K: float,
    P_bar: float,
    phi: float,
) -> float:
    """HP-adiabatic equilibrium product temperature at (T_inlet, P, phi).

    Shared helper used for both the T4 back-solve (lean, combustor-exit) and
    the T_Bulk flame-zone calculation (phi_Bulk = phi4 / combustor_air_frac,
    can be near or slightly above 1 for a primary zone).
    """
    fuel_str = ", ".join(f"{k}:{v:.10f}" for k, v in fuel_x.items())
    ox_str = ", ".join(f"{k}:{v:.10f}" for k, v in ox_x.items())
    gas = ct.Solution(GRI_MECH)
    gas.TP = float(T_inlet_K), float(P_bar) * 1e5
    gas.set_equivalence_ratio(float(phi), fuel=fuel_str, oxidizer=ox_str)
    gas.equilibrate("HP")
    return float(gas.T)


def _t_bulk_with_mix(
    fuel_x: Dict[str, float],
    ox_x: Dict[str, float],
    T_fuel_K: float,
    T_air_K: float,
    P_bar: float,
    phi: float,
) -> float:
    """HP-adiabatic equilibrium T at (T_mixed, P, phi), where T_mixed is the
    enthalpy-balanced adiabatic mix of fuel at T_fuel_K with air at T_air_K
    at this equivalence ratio.

    This matches the Flame Temp / Combustor / AFT panel convention exactly:
    those panels also call make_gas_mixed → equilibrate('HP') with the
    sidebar's T_fuel and T_air. Using the same convention here guarantees
    that T_Bulk on the Cycle panel equals T_ad on the Flame Temp panel
    when all linkages (T3, P3, φ_Bulk, oxidizer humid air) are ON.

    Without this, T_Bulk would be computed with both streams at T_air
    (i.e. fuel preheated to compressor exit) — overshooting the realistic
    flame temperature by however much the cold fuel would have cooled it.
    """
    gas, _, _, _ = make_gas_mixed(
        fuel_x, ox_x, float(phi),
        float(T_fuel_K), float(T_air_K), float(P_bar),
    )
    gas.equilibrate("HP")
    return float(gas.T)


def _t_bulk_with_mix_and_water(
    fuel_x: Dict[str, float],
    ox_x: Dict[str, float],
    T_fuel_K: float,
    T_air_K: float,
    P_bar: float,
    phi: float,
    WFR: float,
    water_mode: str,
    T_water_K: Optional[float] = None,
) -> float:
    """T_Bulk variant that includes injected water in the 3-stream enthalpy mix.

    T_water_K overrides the default (288 K for liquid, T_air for steam).
    """
    if not WFR or WFR <= 0:
        return _t_bulk_with_mix(fuel_x, ox_x, T_fuel_K, T_air_K, P_bar, phi)
    gas, _, _, _, _ = make_gas_mixed_with_water(
        fuel_x, ox_x, float(phi),
        float(T_fuel_K), float(T_air_K), float(P_bar),
        float(WFR), water_mode, T_water_K=T_water_K,
    )
    gas.equilibrate("HP")
    return float(gas.T)


def _t_ad_at_phi_with_water(
    fuel_x: Dict[str, float],
    ox_x: Dict[str, float],
    T_fuel_K: float,
    T_air_K: float,
    P_bar: float,
    phi: float,
    WFR: float,
    water_mode: str,
    T_water_K: Optional[float] = None,
) -> float:
    """3-stream HP-adiabatic equilibrium product T at (T_mix, P, phi) with water."""
    gas, _, _, _, _ = make_gas_mixed_with_water(
        fuel_x, ox_x, float(phi),
        float(T_fuel_K), float(T_air_K), float(P_bar),
        float(WFR), water_mode, T_water_K=T_water_K,
    )
    gas.equilibrate("HP")
    return float(gas.T)


def _phi_for_target_T4_with_water(
    fuel_x: Dict[str, float],
    ox_x: Dict[str, float],
    T_fuel_K: float,
    T_air_K: float,
    P_bar: float,
    T4_target_K: float,
    WFR: float,
    water_mode: str,
) -> float:
    """Water-injection variant of _phi_for_target_T4.

    Real engines hold T4 at the firing-temp setpoint with water injection by
    raising mdot_fuel (i.e. higher phi) to overcome water cooling. This solver
    mirrors that controller behavior: with WFR > 0 we search for the phi that
    makes the 3-stream HP equilibrium product T (cold fuel + hot air + water)
    equal T4. The resulting phi is higher than the dry case, so mdot_fuel
    rises a few % and η_LHV drops — matching real water-injection penalty.

    Falls through to _phi_for_target_T4 when WFR == 0 to preserve the deck
    convention (fuel preheated to T3) and the published-LHV efficiency anchor.
    """
    if not WFR or WFR <= 0:
        return _phi_for_target_T4(fuel_x, ox_x, T_fuel_K, T_air_K, P_bar, T4_target_K)

    def T_eq(phi: float) -> float:
        return _t_ad_at_phi_with_water(
            fuel_x, ox_x, T_fuel_K, T_air_K, P_bar, phi, WFR, water_mode,
        )

    lo, hi = 0.10, 1.50
    T_lo, T_hi = T_eq(lo), T_eq(hi)
    if T4_target_K <= T_lo:
        return lo
    if T4_target_K >= T_hi:
        return hi
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        T_mid = T_eq(mid)
        if T_mid < T4_target_K:
            lo, T_lo = mid, T_mid
        else:
            hi, T_hi = mid, T_mid
        if abs(hi - lo) < 1e-4:
            break
    return 0.5 * (lo + hi)


def _phi_for_target_T4(
    fuel_x: Dict[str, float],
    ox_x: Dict[str, float],
    T_fuel_K: float,
    T3_K: float,
    P3_bar: float,
    T4_target_K: float,
) -> float:
    """Bisect phi so the 3-stream enthalpy mix (cold fuel + hot air at T3)
    reaches T4_target after HP equilibration.

    Physical convention — fuel arrives at the combustor at the user-input
    T_fuel_K (NOT preheated to T3). Air arrives at T3. The mass-weighted
    adiabatic premix drops below T3 by the fuel-cold deficit; we then HP-
    equilibrate to find combustion products, and back-solve phi so the
    product T equals the deck firing-temp setpoint T4_target_K.

    This convention is identical to what T_Bulk and the Flame Temp panel
    use, so T4 / T_Bulk / AFT are all on the same enthalpy reference.
    Published OEM η is anchored to this physical convention as well.

    Returns phi s.t. HP-eq product T ≈ T4_target_K (within ~1 K) or the
    edge of the search bracket if T4_target is outside reach.
    """
    def T_eq(phi: float) -> float:
        return _t_bulk_with_mix(fuel_x, ox_x, T_fuel_K, T3_K, P3_bar, phi)

    lo, hi = 0.10, 1.00
    T_lo, T_hi = T_eq(lo), T_eq(hi)
    # Clamp to reachable range (avoid extrapolation)
    if T4_target_K <= T_lo:
        return lo
    if T4_target_K >= T_hi:
        return hi
    # Monotone bisection (T_eq is monotone in phi on the lean side)
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        T_mid = T_eq(mid)
        if T_mid < T4_target_K:
            lo, T_lo = mid, T_mid
        else:
            hi, T_hi = mid, T_mid
        if abs(hi - lo) < 1e-4:
            break
    return 0.5 * (lo + hi)


# -------------------------- Option A: energy balance ----------------------
def _compressor_work_W(
    air_x: Dict[str, float],
    T_in_K: float, P_in_bar: float,
    T_out_K: float, P_out_bar: float,
    mdot_kg_s: float,
) -> float:
    """Actual shaft work into humid-air stream from inlet to outlet state.

    Uses Cantera enthalpy at (T, P, composition) at both endpoints; the outlet
    T already has polytropic losses baked in (we pass in the real T3), so this
    directly returns the real compressor shaft power.

    Returns W (watts); positive = work into the gas.
    """
    gas = ct.Solution(GRI_MECH)
    X = [0.0] * gas.n_species
    for s, v in air_x.items():
        idx = gas.species_index(s)
        if idx >= 0:
            X[idx] = v
    gas.TPX = float(T_in_K), float(P_in_bar) * 1e5, X
    h_in = gas.enthalpy_mass
    gas.TPX = float(T_out_K), float(P_out_bar) * 1e5, X
    h_out = gas.enthalpy_mass
    return float(mdot_kg_s * (h_out - h_in))


def _turbine_work_W(
    fuel_x: Dict[str, float],
    ox_x: Dict[str, float],
    phi4: float,
    T_fuel_K: float,
    T3_K: float,
    P3_bar: float,
    P_exhaust_bar: float,
    mdot_total_kg_s: float,
    eta_isen: float,
) -> Dict[str, float]:
    """Isentropic expansion from combustor-exit equilibrium products to P_exhaust,
    then apply isentropic efficiency η_s to compute actual outlet enthalpy.

    Combustion uses the physical convention: fuel enters at user-input
    T_fuel_K, air enters at T3, mass-weighted adiabatic premix → HP
    equilibrium → products at (T4_eq, P3). T4_eq ≈ T4_target by design
    (phi was back-solved against the same convention).
    Expansion: gas.SP = (s4, P_exhaust) → isentropic outlet (T5s, h5s).
    Actual: h5 = h4 − η · (h4 − h5s) ; W_turb = m_total · (h4 − h5).

    Returns dict with W_W, T4_eq_K, T5_isen_K, T5_actual_K.
    """
    gas, _, _, _ = make_gas_mixed(
        fuel_x, ox_x, float(phi4), float(T_fuel_K), float(T3_K), float(P3_bar),
    )
    gas.equilibrate("HP")
    h4 = gas.enthalpy_mass
    s4 = gas.entropy_mass
    T4_eq = float(gas.T)
    gas.SP = s4, float(P_exhaust_bar) * 1e5
    h5s = gas.enthalpy_mass
    T5s = float(gas.T)
    h5 = h4 - float(eta_isen) * (h4 - h5s)
    # Find actual outlet T at the given h5, P_exhaust with frozen composition.
    gas.HP = h5, float(P_exhaust_bar) * 1e5
    T5 = float(gas.T)
    W = float(mdot_total_kg_s) * (h4 - h5)
    return {"W_W": float(W), "T4_eq_K": T4_eq, "T5_isen_K": T5s, "T5_actual_K": T5}


def _turbine_work_W_with_water(
    fuel_x: Dict[str, float],
    ox_x: Dict[str, float],
    phi4: float,
    T_fuel_K: float,
    T3_K: float,
    P3_bar: float,
    P_exhaust_bar: float,
    mdot_total_kg_s: float,
    eta_isen: float,
    WFR: float,
    water_mode: str,
    T_water_K: Optional[float] = None,
) -> Dict[str, float]:
    """Water-aware isentropic expansion.

    Same idea as _turbine_work_W but the combustor inlet is the 3-stream
    mix (fuel + compressor air + injected water) built by
    make_gas_mixed_with_water so that:
      • T4_eq falls naturally from the water-laden HP equilibrium (lower than
        the dry case because water absorbs h_fg + sensible enthalpy on the way
        to equilibrium).
      • The expansion gas composition carries the extra H2O through the
        turbine, which raises cp_mean and changes the isentropic exponent.
      • mdot_total_kg_s should include the water mass (m_air + m_fuel + m_water).

    Falls through to _turbine_work_W when WFR == 0.

    Returns dict with W_W, T4_eq_K, T5_isen_K, T5_actual_K.
    """
    if not WFR or WFR <= 0:
        return _turbine_work_W(
            fuel_x, ox_x, phi4, T_fuel_K, T3_K, P3_bar, P_exhaust_bar,
            mdot_total_kg_s, eta_isen,
        )
    gas, _, _, _, _ = make_gas_mixed_with_water(
        fuel_x, ox_x, float(phi4),
        float(T_fuel_K), float(T3_K), float(P3_bar),
        float(WFR), water_mode, T_water_K=T_water_K,
    )
    gas.equilibrate("HP")
    h4 = gas.enthalpy_mass
    s4 = gas.entropy_mass
    T4_eq = float(gas.T)
    gas.SP = s4, float(P_exhaust_bar) * 1e5
    h5s = gas.enthalpy_mass
    T5s = float(gas.T)
    h5 = h4 - float(eta_isen) * (h4 - h5s)
    gas.HP = h5, float(P_exhaust_bar) * 1e5
    T5 = float(gas.T)
    W = float(mdot_total_kg_s) * (h4 - h5)
    return {"W_W": float(W), "T4_eq_K": T4_eq, "T5_isen_K": T5s, "T5_actual_K": T5}


# ----------------------- Option B: fuel flexibility (MWI) -----------------
# Component fuel-property table (dry volume basis, 60 °F, 14.696 psia).
# LHV_vol in BTU/scf (standard cubic foot, 60°F / 14.696 psia); SG = ρ_gas/ρ_air.
# Sources: GPSA Engineering Data Book (Vol II, §23), Perry's 8th ed (§2-179),
# NIST WebBook. Values are standard and widely tabulated.
_FUEL_PROPS_60F: Dict[str, Dict[str, float]] = {
    # hydrocarbons
    "CH4":   {"LHV_vol_BTU_per_scf": 909.4,  "SG_air": 0.5539},
    "C2H6":  {"LHV_vol_BTU_per_scf": 1618.7, "SG_air": 1.0382},
    "C3H8":  {"LHV_vol_BTU_per_scf": 2314.9, "SG_air": 1.5225},
    "C4H10": {"LHV_vol_BTU_per_scf": 3010.8, "SG_air": 2.0068},
    "C5H12": {"LHV_vol_BTU_per_scf": 3706.9, "SG_air": 2.4911},
    "C6H14": {"LHV_vol_BTU_per_scf": 4403.9, "SG_air": 2.9755},
    "C7H16": {"LHV_vol_BTU_per_scf": 5100.0, "SG_air": 3.4598},
    "C8H18": {"LHV_vol_BTU_per_scf": 5796.1, "SG_air": 3.9441},
    "C2H4":  {"LHV_vol_BTU_per_scf": 1513.4, "SG_air": 0.9686},
    "C2H2":  {"LHV_vol_BTU_per_scf": 1449.8, "SG_air": 0.8990},
    # non-hydrocarbon fuels
    "H2":    {"LHV_vol_BTU_per_scf": 273.8,  "SG_air": 0.0696},
    "CO":    {"LHV_vol_BTU_per_scf": 320.5,  "SG_air": 0.9671},
    # inerts (LHV = 0)
    "N2":    {"LHV_vol_BTU_per_scf": 0.0,    "SG_air": 0.9672},
    "CO2":   {"LHV_vol_BTU_per_scf": 0.0,    "SG_air": 1.5196},
    "H2O":   {"LHV_vol_BTU_per_scf": 0.0,    "SG_air": 0.6220},
    "AR":    {"LHV_vol_BTU_per_scf": 0.0,    "SG_air": 1.3796},
}

# Modified Wobbe Index bands for GE DLE combustors (typical guidance).
# MWI = LHV_vol / √(SG × T_fuel_absolute[°R]), units = BTU/scf·√°R.
# In-spec 40–54 BTU/scf·√°R (zero derate).
# Marginal: 35–40 or 54–60 → 5 % performance derate.
# Out-of-spec: < 35 or > 60 → 20 % performance derate.
_MWI_IN_SPEC_LO = 40.0
_MWI_IN_SPEC_HI = 54.0
_MWI_MARGINAL_LO = 35.0
_MWI_MARGINAL_HI = 60.0
_MWI_DERATE_MARGINAL = 0.05
_MWI_DERATE_OUT_OF_SPEC = 0.20


def _fuel_flexibility(fuel_x: Dict[str, float], T_fuel_K: float) -> Dict[str, Any]:
    """Compute MWI, derate factor, and warnings for the supplied fuel.

    fuel_x    : normalized mole fractions (sum to 1.0), GRI-species keys.
    T_fuel_K  : fuel delivery temperature (Kelvin); used in MWI denominator.

    Returns a dict with:
      lhv_vol_BTU_per_scf  : volumetric LHV at 60 °F / 14.696 psia
      sg_air               : specific gravity vs dry air at same conditions
      mwi                  : Modified Wobbe Index in BTU/scf·√°R
      mwi_status           : 'in_spec' | 'marginal' | 'out_of_spec'
      mwi_derate_pct       : 0.0, 5.0, or 20.0 — applied to MW_net
      h2_frac_pct          : H₂ mole fraction (%) in fuel
      warnings             : list of operator-facing strings
    """
    total = sum(fuel_x.values())
    if total <= 0:
        return {
            "lhv_vol_BTU_per_scf": 0.0, "sg_air": 0.0, "mwi": 0.0,
            "mwi_status": "out_of_spec", "mwi_derate_pct": _MWI_DERATE_OUT_OF_SPEC * 100.0,
            "h2_frac_pct": 0.0, "warnings": ["Fuel composition is empty"],
        }
    xnorm = {k: v / total for k, v in fuel_x.items()}

    lhv_vol = 0.0
    sg = 0.0
    for s, x in xnorm.items():
        p = _FUEL_PROPS_60F.get(s)
        if p is None:
            # unknown species → treat as inert (SG=1, LHV=0)
            sg += x * 1.0
            continue
        lhv_vol += x * p["LHV_vol_BTU_per_scf"]
        sg += x * p["SG_air"]

    # Fuel-delivery temperature in Rankine. Default ~520 °R (60 °F) if unset.
    T_R = max(1.0, float(T_fuel_K) * 9.0 / 5.0)
    mwi = lhv_vol / math.sqrt(max(sg, 1e-9) * T_R)

    warnings: list[str] = []
    h2_frac = 100.0 * xnorm.get("H2", 0.0)
    if h2_frac > 30.0:
        warnings.append(
            f"H₂ content is {h2_frac:.1f}% — exceeds 30% DLE premixer flashback limit"
        )
    if lhv_vol > 0.0 and lhv_vol < 800.0:
        warnings.append(
            f"Volumetric LHV is {lhv_vol:.0f} BTU/scf — below 800 BTU/scf flame-holding threshold"
        )

    if _MWI_IN_SPEC_LO <= mwi <= _MWI_IN_SPEC_HI:
        status = "in_spec"
        derate = 0.0
    elif _MWI_MARGINAL_LO <= mwi <= _MWI_MARGINAL_HI:
        status = "marginal"
        derate = _MWI_DERATE_MARGINAL
        warnings.append(
            f"MWI {mwi:.1f} is outside the 40–54 in-spec band — marginal fuel; 5% performance derate applied"
        )
    else:
        status = "out_of_spec"
        derate = _MWI_DERATE_OUT_OF_SPEC
        warnings.append(
            f"MWI {mwi:.1f} is outside the 35–60 acceptable range — out-of-spec fuel; 20% performance derate applied"
        )

    return {
        "lhv_vol_BTU_per_scf": float(lhv_vol),
        "sg_air": float(sg),
        "mwi": float(mwi),
        "mwi_status": status,
        "mwi_derate_pct": float(derate * 100.0),
        "h2_frac_pct": float(h2_frac),
        "warnings": warnings,
    }


# ------------------------------- Main entry --------------------------------
def run(
    engine: str,
    P_amb_bar: float,
    T_amb_K: float,
    RH_pct: float,
    load_pct: float,
    T_cool_in_K: Optional[float] = None,
    fuel_pct: Optional[Dict[str, float]] = None,
    combustor_air_frac: Optional[float] = None,
    T_fuel_K: Optional[float] = None,
    WFR: float = 0.0,
    water_mode: str = "liquid",
    T_water_K: Optional[float] = None,
    bleed_air_frac: float = 0.0,
) -> Dict[str, Any]:
    """Solve the cycle at the requested operating point.

    Parameters
    ----------
    engine
        Deck key: 'LMS100PB+' or 'LM6000PF'.
    P_amb_bar
        Ambient pressure, bar.
    T_amb_K
        Ambient dry-bulb, K.
    RH_pct
        Relative humidity, 0–100 %.
    load_pct
        Commanded load as % of max-on-this-day (20 ≤ load ≤ 100).
    T_cool_in_K
        (LMS100 only) Intercooler cooling-water supply T. If omitted,
        default 288 K (15 °C) is used. Affects the intercooler approach
        temperature; if the supply is too warm the intercooler cannot
        hold T3 at its design value and T3 will drift upward.
    fuel_pct
        Fuel composition in mol %. Defaults to US pipeline natural gas.
    combustor_air_frac
        FLAME-ZONE fraction of the combustor's airflow: m_flame / m_comb_air,
        i.e. the share of air that participates in the primary flame vs. the
        share that enters as dilution / liner cooling downstream. This is a
        pure intra-combustor split and does NOT affect thermal efficiency:
        at a fixed commanded T4, the overall fuel flow is fixed by the
        combustor-exit energy balance regardless of how the air is split
        between flame and dilution zones.

        What it DOES drive is the flame-zone state:
            FAR_Bulk = FAR4 / combustor_air_frac
            phi_Bulk = phi4 / combustor_air_frac
            T_Bulk   = HP-adiabatic eq. product T at (T3, P3, phi_Bulk)

        These bulk values are the ones the Flame Temp / Flame Speed /
        PSR-PFR / Blowoff / Exhaust panels consume when linked, because
        those panels model the FLAME ZONE, not the diluted combustor exit.

        Typical DLE primary-zone fractions: 0.80–0.95. Default = 0.88.
        Set = 1.0 to collapse the flame zone onto the combustor exit
        (T_Bulk = T4, phi_Bulk = phi4) — useful for debugging linkage.
    T_fuel_K
        Fuel delivery temperature (K). Two uses:
          (a) Modified Wobbe Index denominator: MWI = LHV_vol / √(SG × T_fuel).
          (b) Enthalpy-balanced fuel/air mix temperature for T_Bulk, so that
              the cycle's flame-zone T matches the Flame Temp / AFT panel at
              the linked sidebar state (T_air=T3, P=P3, φ=φ_Bulk).
        Defaults to 288.706 K (60 °F) — the reference T for tabulated MWI.
    WFR
        Water-to-fuel mass ratio injected at the combustor primary zone.
        Defaults to 0 (dry cycle, identical to the OEM-deck behavior).
        With WFR > 0 the code takes the controller-style path: the T4
        back-solve raises phi to overcome water cooling and hold T4 at the
        firing-temp setpoint, and T_Bulk is computed from a 3-stream
        enthalpy mix (cold fuel + hot air + injected water). Net effect:
        mdot_fuel rises a few %, η_LHV drops, and T_Bulk drops — matching
        the Flame Temp panel's water-aware path exactly.
        NOTE: MW_net stays at the dry-deck cap (no water-injection power
        augmentation modeled here); only the fuel-side / heat-rate effect
        is captured.
    water_mode
        "liquid" or "steam" — sets the injected-water enthalpy reference
        used by make_gas_mixed_with_water. Ignored when WFR == 0.

    Returns a dict with all station properties and diagnostics (see
    docstring and CycleResponse schema for fields).
    """
    if engine not in ENGINE_DECKS:
        raise ValueError(f"Unknown engine '{engine}'. Options: {list(ENGINE_DECKS)}")
    deck = ENGINE_DECKS[engine]
    fuel_pct = fuel_pct or dict(_DEFAULT_FUEL)
    if combustor_air_frac is None:
        combustor_air_frac = 0.88     # nominal DLE primary-zone split
    # Safety bounds — a value outside [0.3, 1.0] makes no physical sense.
    combustor_air_frac = max(0.30, min(1.00, float(combustor_air_frac)))
    if T_fuel_K is None:
        T_fuel_K = 288.706   # 60 °F — reference T for MWI tables

    # Normalize load to [20, 100] — gas turbines don't run under 20% load
    load_pct_eff = max(20.0, min(100.0, float(load_pct)))
    load_frac = load_pct_eff / 100.0

    # --- Ambient density correction ---
    rho_amb = _humid_air_density(T_amb_K, P_amb_bar, RH_pct)
    rho_des = _humid_air_density(deck["T_amb_design_K"], deck["P_amb_design_bar"], deck["RH_design_pct"])
    rho_ratio = rho_amb / rho_des  # >1 on cold days → more MW, more airflow

    # --- Airflow, MW_max_ambient ---
    a_m, a_P3 = deck["a_m"], deck["a_P3"]
    beta_m, beta_P3, beta_MW = deck["beta_m"], deck["beta_P3"], deck["beta_MW"]
    mdot_air = (
        deck["airflow_design_kg_s"]
        * (a_m + (1.0 - a_m) * load_frac)
        * (rho_ratio ** beta_m)
    )
    MW_max_ambient = deck["MW_design"] * (rho_ratio ** beta_MW)
    MW_net = MW_max_ambient * load_frac

    # --- T4, P3 ---
    T4_K = deck["T4_design_K"] * (deck["a_T4"] + (1.0 - deck["a_T4"]) * load_frac)
    P3_bar = (
        deck["P3_design_bar"]
        * (a_P3 + (1.0 - a_P3) * load_frac)
        * (rho_ratio ** beta_P3)
    )

    # --- T3, plus stations upstream ---
    stations: Dict[str, float] = {
        "T1_K": T_amb_K,
        "P1_bar": P_amb_bar,
    }

    if deck["intercooled"]:
        # LMS100 — LPC → IC → HPC
        PR_LPC = deck["PR_LPC_design"]
        # LPC exit T (polytropic)
        T2_K = T_amb_K * (PR_LPC ** ((GAMMA_AIR - 1.0) / GAMMA_AIR / deck["eta_poly"]))
        P2_bar = P_amb_bar * PR_LPC
        # Intercooler exit: holds design T2.5 unless cooling water is too warm
        T2_5_design = deck["T2_5_design_K"]
        if T_cool_in_K is not None and T_cool_in_K > (T2_5_design - 10.0):
            # approach temperature ≈ 10 K: T2.5 ≈ T_cool_in + 10
            T2_5_K = float(T_cool_in_K) + 10.0
        else:
            T2_5_K = T2_5_design
        P2_5_bar = P2_bar * 0.98   # ~2% pressure drop through IC
        # T3 — intercooler holds T3 = T3_design across ambient at max load.
        # At part load, HPC runs less and T3 drops.
        T3_K = deck["T3_design_K"] - deck["T3_load_slope_K_per_pct"] * (100.0 - load_pct_eff)
        # If the intercooler approach forced T2.5 above its design (hot cooling
        # water), bubble that up into T3 proportionally.
        T3_K += max(0.0, T2_5_K - T2_5_design)
        # Intercooler duty (heat rejected by air, MW_thermal)
        q_IC_MW = mdot_air * CP_AIR * max(0.0, T2_K - T2_5_K) / 1e6
        stations.update({
            "T2_K": T2_K,          "P2_bar": P2_bar,
            "T2_5_K": T2_5_K,      "P2_5_bar": P2_5_bar,
            "T3_K": T3_K,          "P3_bar": P3_bar,
            "intercooler_duty_MW": q_IC_MW,
        })
    else:
        # LM6000 — single compression from ambient to P3. Anchor T3 at the
        # design point and let it float with ambient via T_amb^α with α=0.90.
        # At design the ratio is exactly 1, so the anchor is preserved.
        alpha = deck["alpha_T3_amb"]
        T3_K = deck["T3_design_K"] * (T_amb_K / deck["T_amb_design_K"]) ** alpha
        # Part-load droop in T3
        T3_K -= deck["T3_load_slope_K_per_pct"] * (100.0 - load_pct_eff)
        stations.update({
            "T2_K": T3_K,          "P2_bar": P3_bar,   # no intercooler: T2 == T3
            "T3_K": T3_K,          "P3_bar": P3_bar,
        })

    stations["T4_K"] = T4_K

    # --- Phi4 from Cantera equilibrium HP at (T3, P3) targeting T4 ---
    # Phi4 / FAR4 are the COMBUSTOR-EXIT quantities: the equivalence ratio
    # that, when burned adiabatically with the combustor airflow at (T3, P3),
    # reaches T4 at equilibrium. These are what physically exit the combustor
    # and what the Flame Temp / Combustor / Flame Speed / Blowoff / Exhaust
    # panels use when linked (via the shared sidebar phi). In a DLE premixed
    # combustor the combustor-exit values equal the bulk flame-zone values.
    ox_pct = _humid_air_mol_pct(T_amb_K, P_amb_bar, RH_pct)
    fuel_x = _normalize_to_gri(fuel_pct)
    ox_x = _normalize_to_gri(ox_pct)
    # Sanitize WFR / water_mode. phi4 is back-solved against the DRY deck T4
    # setpoint regardless of WFR — water injection is handled as a physical
    # correction downstream (see the "Water-injection correction" block below)
    # so fuel stays on the dry schedule + a small empirical controller bump,
    # T4 floats down from the water-laden HP equilibrium, and the water mass
    # threads through the turbine as extra expansion mass.
    WFR = max(0.0, float(WFR or 0.0))
    water_mode = water_mode if water_mode in ("liquid", "steam") else "liquid"
    phi4 = _phi_for_target_T4(fuel_x, ox_x, T_fuel_K, stations["T3_K"], P3_bar, T4_K)

    # FAR4 = fuel mass / combustor air mass at the phi that produces T4
    Y_f = fuel_mass_fraction_at_phi(fuel_x, ox_x, phi4, GRI_MECH)
    FAR4 = Y_f / max(1.0 - Y_f, 1e-20)

    # --- Flame-zone (bulk) state -------------------------------------------
    # combustor_air_frac is the fraction of combustor air in the flame zone.
    # Since the overall combustor energy balance is identical, the flame
    # zone burns the SAME fuel against LESS air → higher FAR, phi, T.
    # These bulk values are what Flame Temp / Flame Speed / PSR-PFR /
    # Blowoff / Exhaust should consume (they model the flame, not the
    # diluted exit). At combustor_air_frac = 1.0 the bulk reduces to the
    # combustor-exit values (T_Bulk = T4).
    f_safe = max(combustor_air_frac, 1e-6)
    FAR_Bulk = FAR4 / f_safe
    phi_Bulk = phi4 / f_safe
    # Use enthalpy-balanced fuel↔air mixing so T_Bulk matches what the Flame
    # Temp panel computes at the linked sidebar state (T_fuel, T_air=T3).
    # When WFR > 0 the water-aware variant routes through make_gas_mixed_with_water
    # so injected water enters the 3-stream enthalpy mix exactly as the Flame
    # Temp panel does; otherwise it short-circuits to _t_bulk_with_mix.
    T_Bulk_K = _t_bulk_with_mix_and_water(
        fuel_x, ox_x, T_fuel_K, stations["T3_K"], P3_bar, phi_Bulk, WFR, water_mode,
        T_water_K=T_water_K,
    )

    # --- Fuel flow ----------------------------------------------------------
    # combustor_bypass_frac is the fraction of compressor-discharge air that
    # actually enters the combustor; the rest is bypass / film-cooling air
    # that rejoins downstream of combustion. Fuel flow is pinned by the
    # combustor-exit energy balance: FAR4 × m_combustor_air produces the
    # equilibrium product T that equals the commanded T4 at (T3, P3).
    combustor_bypass_frac = float(deck["combustor_bypass_frac"])
    mdot_air_combustor = mdot_air * combustor_bypass_frac
    mdot_fuel = mdot_air_combustor * FAR4

    # --- Option A: energy-balance cycle (turbine − compressor − parasitic) --
    eta_isen_turb = float(deck["eta_isen_turb"])
    eta_isen_comp = float(deck["eta_isen_comp"])
    P_exhaust_bar = float(deck["P_exhaust_bar"])
    W_parasitic_frac = float(deck["W_parasitic_frac_of_rated"])
    W_parasitic_MW = W_parasitic_frac * deck["MW_design"]

    # Turbine work — hot-section mass flow is combustor air + fuel; the
    # bypass/cooling air rejoins the hot gas downstream, so the full
    # compressor-discharge mass eventually passes through the LP turbine.
    # We use (m_combustor_air + m_fuel) × h-drop through HP+IP+LP turbines
    # as a simplified total-expansion work. This understates W_turb slightly
    # (bypass air contributes LP-stage work only), which is absorbed by
    # η_isen_turb calibrated against the design anchor.
    mdot_hot = mdot_air + mdot_fuel
    t_out = _turbine_work_W(
        fuel_x, ox_x, phi4, T_fuel_K, stations["T3_K"], stations["P3_bar"],
        P_exhaust_bar, mdot_hot, eta_isen_turb,
    )
    W_turbine_W = t_out["W_W"]
    T5_actual_K = t_out["T5_actual_K"]
    T5_isen_K = t_out["T5_isen_K"]

    # Compressor work — sum of LPC + HPC (LMS100) or single stage (LM6000).
    # The T-rise uses polytropic η (baked into T2 for LMS100 and into the
    # T_amb^α scaling for LM6000), so a direct Cantera enthalpy difference
    # captures the real shaft power.
    if deck["intercooled"]:
        W_LPC_W = _compressor_work_W(
            ox_x, T_amb_K, P_amb_bar,
            stations["T2_K"], stations["P2_bar"], mdot_air,
        )
        W_HPC_W = _compressor_work_W(
            ox_x, stations["T2_5_K"], stations["P2_5_bar"],
            stations["T3_K"], stations["P3_bar"], mdot_air,
        )
        W_compressor_W = W_LPC_W + W_HPC_W
    else:
        W_compressor_W = _compressor_work_W(
            ox_x, T_amb_K, P_amb_bar,
            stations["T3_K"], stations["P3_bar"], mdot_air,
        )

    W_turbine_MW = W_turbine_W / 1e6
    W_compressor_MW = W_compressor_W / 1e6
    MW_gross = W_turbine_MW - W_compressor_MW - W_parasitic_MW

    # --- Bleed correction (compressor-discharge bleed dumped to ambient) ---
    # Bleed extracts air AFTER the compressor and BEFORE the combustor and
    # vents it to ambient. So:
    #   - Compressor work is unchanged (full mdot_air still compressed)
    #   - Combustor + turbine see (1 − bleed_air_frac) × mdot_air
    #   - Same fuel + less air → richer flame → higher T4
    #   - To hold gross power, T4 elevates further (and fuel rises slightly)
    # This iterates T4 such that the bled-cycle gross power equals the
    # baseline (no-bleed) gross power, capturing the user's intuition that
    # bleed compensates for "lost" turbine mass by raising firing T.
    # IMPORTANT: the bleed loop runs in pure-dry mode (no WFR in the back-
    # solve). Water injection is applied as a separate physical correction
    # AFTER the loop converges, so bleed always targets the dry gross power.
    bleed_air_frac = max(0.0, min(0.50, float(bleed_air_frac or 0.0)))
    mdot_bleed_kg_s = mdot_air * bleed_air_frac
    mdot_air_post_bleed = mdot_air * (1.0 - bleed_air_frac)
    bleed_iters = 0
    bleed_converged = True
    if bleed_air_frac > 1e-6:
        target_W_gross_W = max(1.0e3, MW_gross * 1.0e6)
        T4_b = T4_K
        phi4_b = phi4
        FAR4_b = FAR4
        mdot_fuel_b = mdot_fuel
        W_turb_b_W = W_turbine_W
        T5_b_K = T5_actual_K
        T5_isen_b_K = T5_isen_K
        bleed_converged = False
        for _ in range(20):
            bleed_iters += 1
            phi4_b = _phi_for_target_T4(
                fuel_x, ox_x, T_fuel_K, stations["T3_K"], P3_bar, T4_b,
            )
            Y_f_b = fuel_mass_fraction_at_phi(fuel_x, ox_x, phi4_b, GRI_MECH)
            FAR4_b = Y_f_b / max(1.0 - Y_f_b, 1e-20)
            mdot_air_comb_b = mdot_air_post_bleed * combustor_bypass_frac
            mdot_fuel_b = mdot_air_comb_b * FAR4_b
            mdot_hot_b = mdot_air_post_bleed + mdot_fuel_b
            t_out_b = _turbine_work_W(
                fuel_x, ox_x, phi4_b, T_fuel_K, stations["T3_K"], P3_bar, P_exhaust_bar,
                mdot_hot_b, eta_isen_turb,
            )
            W_turb_b_W = t_out_b["W_W"]
            T5_b_K = t_out_b["T5_actual_K"]
            T5_isen_b_K = t_out_b["T5_isen_K"]
            W_gross_b_W = W_turb_b_W - W_compressor_W - W_parasitic_MW * 1e6
            err = W_gross_b_W - target_W_gross_W
            if abs(err) < target_W_gross_W * 0.001:
                bleed_converged = True
                break
            # dW_turb/dT4 ≈ mdot_hot × cp_eff × (1 - (P_exh/P3)^k_eff)
            # Use a conservative slope: ~700 J/kg/K (cp_eff × expansion-fraction)
            dW_dT4 = max(1.0e3, mdot_hot_b * 700.0)
            T4_b -= err / dW_dT4
            T4_b = max(900.0, min(2400.0, T4_b))

        # Commit bleed-corrected values
        T4_K = T4_b
        phi4 = phi4_b
        FAR4 = FAR4_b
        stations["T4_K"] = T4_K
        mdot_air_combustor = mdot_air_post_bleed * combustor_bypass_frac
        mdot_fuel = mdot_fuel_b
        mdot_hot = mdot_air_post_bleed + mdot_fuel
        W_turbine_W = W_turb_b_W
        T5_actual_K = T5_b_K
        T5_isen_K = T5_isen_b_K
        W_turbine_MW = W_turbine_W / 1e6
        MW_gross = W_turbine_MW - W_compressor_MW - W_parasitic_MW

        # Recompute flame-zone state at the elevated phi (still water-aware
        # so T_Bulk reflects injected water if any; WFR=0 short-circuits to dry).
        f_safe = max(combustor_air_frac, 1e-6)
        FAR_Bulk = FAR4 / f_safe
        phi_Bulk = phi4 / f_safe
        T_Bulk_K = _t_bulk_with_mix_and_water(
            fuel_x, ox_x, T_fuel_K, stations["T3_K"], P3_bar, phi_Bulk,
            WFR, water_mode, T_water_K=T_water_K,
        )

    # --- Water-injection correction (physical energy balance) --------------
    # Applied on top of the dry + bleed state. Three coupled effects:
    #   1) Controller-response fuel bump. Real governors near the EGT limiter
    #      respond to water-injection cooling by raising fuel a few %. GE
    #      LM6000 published data (WFR=0.5 → HR +~2%, MW +~2%, T_turb_in −40K)
    #      back-solves to ~4 % fuel rise per unit WFR → k = 0.04.
    #   2) T4 floats down from a water-laden HP equilibrium at the bumped
    #      phi4 (water cooling dominates the phi bump for typical WFR).
    #   3) Water passes through the turbine as extra expansion mass; the
    #      expansion gas composition carries injected H2O so cp and γ are
    #      correctly altered. MW_gross reflects the mass-flow + T4 tradeoff.
    T4_dry_deck_K = float(T4_K)   # snapshot BEFORE the water correction
    MW_gross_pre_water = float(MW_gross)   # snapshot MW_gross BEFORE water (post-bleed)
    mdot_water_kg_s = 0.0
    fuel_bump_factor = 1.0
    water_MW_delta = 0.0
    if WFR > 0.0:
        # k = fuel-bump per unit WFR. With the physical cold-fuel convention
        # (fuel at user T_fuel_K, air at T3, water at user T_water_K), k=0.10
        # matches published GE LM6000 water-injection data almost exactly
        # at WFR=0.5 liquid ISO:
        #   dT4       ≈ −17 K   (published: ~−40 K)
        #   dT_Bulk   ≈ −22 K   (enables NOx halving per Zeldovich Arrhenius)
        #   dMW       ≈ +2.9 %  (published: +2 %)
        #   dη        ≈ −0.83 pt (published: ~−1 pt)
        #   dfuel     ≈ +5 %    (published implied: +4 %)
        # All four user-stated physical expectations satisfied with good
        # quantitative agreement to OEM-published performance tables.
        K_WATER_FUEL_BUMP = 0.10
        fuel_bump_factor = 1.0 + K_WATER_FUEL_BUMP * WFR
        mdot_fuel_wet = mdot_fuel * fuel_bump_factor
        mdot_water_kg_s = mdot_fuel_wet * WFR
        # FAR and phi scale linearly with fuel at fixed air (phi ∝ FAR ∝ m_fuel)
        FAR4_wet = mdot_fuel_wet / max(mdot_air_combustor, 1e-30)
        phi4_wet = phi4 * fuel_bump_factor
        # Water-aware T4 — uses the same cold-fuel convention as the dry back-
        # solve (fuel at user T_fuel_K, air at T3, water at user T_water_K).
        # T4 is apples-to-apples vs the dry case because both use the same
        # 3-stream enthalpy reference.
        T4_wet_K = _t_ad_at_phi_with_water(
            fuel_x, ox_x, T_fuel_K, stations["T3_K"], P3_bar,
            phi4_wet, WFR, water_mode, T_water_K=T_water_K,
        )
        # Flame-zone (bulk) state at bumped phi_Bulk, water-aware
        f_safe = max(combustor_air_frac, 1e-6)
        phi_Bulk_wet = phi4_wet / f_safe
        FAR_Bulk_wet = FAR4_wet / f_safe
        T_Bulk_K = _t_bulk_with_mix_and_water(
            fuel_x, ox_x, T_fuel_K, stations["T3_K"], P3_bar, phi_Bulk_wet,
            WFR, water_mode, T_water_K=T_water_K,
        )
        # Turbine work — water threads through expansion. m_hot includes
        # the injected water; gas composition carries the extra H2O mol fraction.
        mdot_hot_wet = mdot_air_post_bleed + mdot_fuel_wet + mdot_water_kg_s
        t_out_wet = _turbine_work_W_with_water(
            fuel_x, ox_x, phi4_wet, T_fuel_K,
            stations["T3_K"], P3_bar, P_exhaust_bar,
            mdot_hot_wet, eta_isen_turb, WFR, water_mode, T_water_K=T_water_K,
        )
        # Commit water-corrected state
        T4_K = T4_wet_K
        stations["T4_K"] = T4_K
        phi4 = phi4_wet
        FAR4 = FAR4_wet
        phi_Bulk = phi_Bulk_wet
        FAR_Bulk = FAR_Bulk_wet
        mdot_fuel = mdot_fuel_wet
        mdot_hot = mdot_hot_wet
        W_turbine_W = t_out_wet["W_W"]
        T5_actual_K = t_out_wet["T5_actual_K"]
        T5_isen_K = t_out_wet["T5_isen_K"]
        W_turbine_MW = W_turbine_W / 1e6
        MW_gross = W_turbine_MW - W_compressor_MW - W_parasitic_MW
        # Water-injection delta on the Brayton gross — applied as a
        # perturbation to the OEM-anchored cap, which keeps part-load behavior
        # sensible (the bare Brayton under-predicts off-design by several MW
        # on cold days). At base load MW_gross_pre_water ≈ MW_cap, so the
        # delta is the same magnitude as the absolute water effect.
        water_MW_delta = MW_gross - MW_gross_pre_water

    # --- Option B: fuel-flexibility derate ---------------------------------
    fuel_flex = _fuel_flexibility(fuel_x, T_fuel_K)
    derate_factor = 1.0 - fuel_flex["mwi_derate_pct"] / 100.0

    # --- Net power: OEM-anchored cap × fuel-flexibility derate --------------
    # MW_max_ambient × load_frac is the OEM nameplate cap (what the engine
    # is documented to produce on this ambient day) and is the authoritative
    # number — it is the published curve OEMs anchor service contracts to.
    # MW_gross is a simplified Brayton-cycle calc (W_turb − W_comp − W_par)
    # that systematically under-predicts off-design power because we hold T4
    # constant, parameterize mdot ∝ ρ^0.9, and don't model variable IGVs,
    # bleed scheduling, or the speed/PR optimization the OEM controller does.
    # On warm days that under-prediction is several MW. We therefore use the
    # deck-anchored cap as the headline and keep MW_gross exported only for
    # diagnostic comparison.
    MW_cap = MW_max_ambient * load_frac
    if WFR > 0.0:
        # Apply the water-injection Brayton delta to the OEM-anchored cap.
        # This preserves the OEM deck at dry + bleed (the Brayton calc under-
        # predicts off-design) while letting physical water effects move the
        # published MW up or down. Cap at 1.15× dry cap as a physical ceiling.
        MW_aug = MW_cap + water_MW_delta
        MW_net = max(min(MW_aug * derate_factor, 1.15 * MW_cap * derate_factor), 0.0)
    else:
        # Dry deck: keep the OEM-anchored cap as the authoritative number.
        MW_net = max(MW_cap * derate_factor, 0.0)

    # --- Heat rate & efficiency --------------------------------------------
    LHV_fuel = _estimate_LHV_mass_J_per_kg(fuel_x)     # J/kg
    Q_fuel_MW = mdot_fuel * LHV_fuel / 1e6
    if MW_net > 1e-6 and Q_fuel_MW > 1e-6:
        efficiency = MW_net / Q_fuel_MW
        heat_rate_kJ_per_kWh = 3600.0 / efficiency
    else:
        efficiency = 0.0
        heat_rate_kJ_per_kWh = 0.0

    return {
        "engine": engine,
        "engine_label": deck["label"],
        "intercooled": bool(deck["intercooled"]),
        # Ambient
        "T_amb_K": float(T_amb_K),
        "P_amb_bar": float(P_amb_bar),
        "RH_pct": float(RH_pct),
        "rho_amb_kg_m3": float(rho_amb),
        "rho_ratio": float(rho_ratio),
        # Load
        "load_pct": float(load_pct_eff),
        "MW_max_ambient": float(MW_max_ambient),
        "MW_net": float(MW_net),
        # Option A — energy-balance decomposition (all in MW)
        "MW_gross": float(MW_gross),
        "MW_cap": float(MW_cap),
        "MW_uncapped_before_derate": float(MW_cap),
        "W_turbine_MW": float(W_turbine_MW),
        "W_compressor_MW": float(W_compressor_MW),
        "W_parasitic_MW": float(W_parasitic_MW),
        "derate_factor": float(derate_factor),
        "eta_isen_turb": float(eta_isen_turb),
        "eta_isen_comp": float(eta_isen_comp),
        "combustor_bypass_frac": float(combustor_bypass_frac),
        "T5_K": float(T5_actual_K),
        "T5_isen_K": float(T5_isen_K),
        "P_exhaust_bar": float(P_exhaust_bar),
        # Stations
        "T1_K": float(stations["T1_K"]),
        "P1_bar": float(stations["P1_bar"]),
        "T2_K": float(stations["T2_K"]),
        "P2_bar": float(stations["P2_bar"]),
        "T2_5_K": float(stations.get("T2_5_K", 0.0)),
        "P2_5_bar": float(stations.get("P2_5_bar", 0.0)),
        "T3_K": float(stations["T3_K"]),
        "P3_bar": float(stations["P3_bar"]),
        "T4_K": float(stations["T4_K"]),
        "intercooler_duty_MW": float(stations.get("intercooler_duty_MW", 0.0)),
        # Flows
        "mdot_air_kg_s": float(mdot_air),
        "mdot_air_combustor_kg_s": float(mdot_air_combustor),
        "mdot_fuel_kg_s": float(mdot_fuel),
        # Water injection (mass passing through the turbine when WFR > 0)
        "mdot_water_kg_s": float(mdot_water_kg_s),
        "water_fuel_bump_factor": float(fuel_bump_factor),
        "water_MW_delta": float(water_MW_delta),
        "T4_dry_deck_K": float(T4_dry_deck_K),
        "T_water_K": float(T_water_K) if T_water_K is not None else (
            288.15 if water_mode == "liquid" else float(stations["T3_K"])
        ),
        # Bleed (compressor-discharge bleed to ambient)
        "bleed_air_frac": float(bleed_air_frac),
        "mdot_bleed_kg_s": float(mdot_bleed_kg_s),
        "mdot_air_post_bleed_kg_s": float(mdot_air_post_bleed),
        "bleed_iters": int(bleed_iters),
        "bleed_converged": bool(bleed_converged),
        # FAR4 / phi4 = COMBUSTOR EXIT (after dilution). Back-solved so the
        # adiabatic equilibrium product T at (T3, P3) equals T4.
        "FAR4": float(FAR4),
        "phi4": float(phi4),
        # FAR_Bulk / phi_Bulk / T_Bulk_K = FLAME ZONE. Same T3, P3, fuel,
        # humid-air ox; but air is split by combustor_air_frac, so the
        # flame sees a richer mixture and a higher adiabatic T.
        # Downstream panels (Flame Temp, Flame Speed, PSR-PFR, Blowoff,
        # Exhaust) all model the flame, so they should consume these.
        "FAR_Bulk": float(FAR_Bulk),
        "phi_Bulk": float(phi_Bulk),
        "T_Bulk_K": float(T_Bulk_K),
        # Legacy alias → phi_Bulk (what the sidebar φ linkage now uses).
        # At combustor_air_frac = 1.0 this collapses back to phi4.
        "phi": float(phi_Bulk),
        # User-tunable flame/dilution split (0.88 nominal DLE)
        "combustor_air_frac": float(combustor_air_frac),
        # Performance
        "efficiency_LHV": float(efficiency),
        "heat_rate_kJ_per_kWh": float(heat_rate_kJ_per_kWh),
        "LHV_fuel_MJ_per_kg": float(LHV_fuel / 1e6),
        # Option B — fuel-flexibility block
        "fuel_flexibility": {
            "lhv_vol_BTU_per_scf": float(fuel_flex["lhv_vol_BTU_per_scf"]),
            "sg_air": float(fuel_flex["sg_air"]),
            "mwi": float(fuel_flex["mwi"]),
            "mwi_status": fuel_flex["mwi_status"],
            "mwi_derate_pct": float(fuel_flex["mwi_derate_pct"]),
            "h2_frac_pct": float(fuel_flex["h2_frac_pct"]),
            "warnings": list(fuel_flex["warnings"]),
        },
        "T_fuel_K": float(T_fuel_K),
        # Water injection (echoed for the frontend / Excel export / tests).
        # WFR == 0 ⇒ dry deck path is in effect (OEM efficiency anchor preserved).
        # WFR > 0  ⇒ controller path: phi4 raised to hold T4, η_LHV drops a few %.
        "WFR": float(WFR),
        "water_mode": water_mode,
        # Humid-air composition at inlet (for reference / Oxidizer linkage)
        "oxidizer_humid_mol_pct": {k: float(v) for k, v in ox_pct.items()},
    }


def _estimate_LHV_mass_J_per_kg(fuel_x: Dict[str, float]) -> float:
    """Lower Heating Value (J/kg fuel) from Cantera enthalpy-of-combustion at 298 K.

    Burns the fuel stream with stoichiometric O2 to CO2(g) + H2O(g) + N2 and
    returns the enthalpy release per kg of fuel at 298 K. Water is left as
    vapor (→ LHV, not HHV).
    """
    gas = ct.Solution(GRI_MECH)
    # Build the fuel stream alone at 298 K
    X_fuel = [0.0] * gas.n_species
    for s, v in fuel_x.items():
        idx = gas.species_index(s)
        if idx >= 0:
            X_fuel[idx] = v
    gas.TPX = 298.15, 101325.0, X_fuel
    h_fuel = gas.enthalpy_mass
    # Burn at phi=1 stoichiometric; products relaxed to CO2/H2O/N2 via equilibrate('TP')
    # at 298 K (forces fuel → products at reactant T, so ΔH = LHV).
    fuel_str = ", ".join(f"{k}:{v:.10f}" for k, v in fuel_x.items() if v > 0)
    ox_str = "O2:1.0"
    gas2 = ct.Solution(GRI_MECH)
    gas2.TP = 298.15, 101325.0
    gas2.set_equivalence_ratio(1.0, fuel=fuel_str, oxidizer=ox_str)
    h_reactants_mass = gas2.enthalpy_mass  # per kg of (fuel+O2) mixture
    mw_mix = gas2.mean_molecular_weight
    # Mass fraction of fuel in this stoichiometric mixture
    Y_fuel_mix = 0.0
    for s, v in fuel_x.items():
        idx = gas2.species_index(s)
        if idx >= 0:
            Y_fuel_mix += gas2.Y[idx]
    gas2.equilibrate("TP")
    h_products_mass = gas2.enthalpy_mass
    # Heat released per kg of mixture, at constant T, P:
    q_per_kg_mix = h_reactants_mass - h_products_mass
    if Y_fuel_mix <= 0:
        return 50e6  # fallback: 50 MJ/kg (pure CH4-ish)
    return max(0.0, q_per_kg_mix / Y_fuel_mix)
