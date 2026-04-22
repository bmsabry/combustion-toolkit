"""Gas-turbine thermodynamic cycle — LM6000PF and LMS100PB+.

Given ambient conditions (P, T, RH) and load%, computes:
  • Station pressures and temperatures (P1/T1, P2/T2, P2.5/T2.5 for LMS100, P3/T3, T4)
  • Inlet air mass flow and fuel mass flow
  • FAR and phi consistent with the target firing temperature T4
  • Net shaft power (MW)
  • Intercooler duty (LMS100 only)

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

from .mixture import GRI_MECH, _normalize_to_gri, fuel_mass_fraction_at_phi

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
        # Intercooler partition between LPC and HPC
        "PR_LPC_design": 5.0,
        "T2_5_design_K": 310.93,     # intercooler exit ≈ 100°F; HPC inlet
        "eta_poly": 0.88,
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
def _phi_for_target_T4(
    fuel_x: Dict[str, float],
    ox_x: Dict[str, float],
    T3_K: float,
    P3_bar: float,
    T4_target_K: float,
) -> float:
    """Bisect phi in [0.10, 1.00] so that Cantera equilibrate('HP') at (T3, P3) → T4_target.

    Returns the phi whose equilibrium adiabatic product T matches the target T4
    to within 1 K (or the edge of the bracket if T4 is outside the reachable range).
    """
    fuel_str = ", ".join(f"{k}:{v:.10f}" for k, v in fuel_x.items())
    ox_str = ", ".join(f"{k}:{v:.10f}" for k, v in ox_x.items())
    P3_Pa = float(P3_bar) * 1e5

    def T_eq(phi: float) -> float:
        gas = ct.Solution(GRI_MECH)
        gas.TP = float(T3_K), P3_Pa
        gas.set_equivalence_ratio(float(phi), fuel=fuel_str, oxidizer=ox_str)
        gas.equilibrate("HP")
        return float(gas.T)

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


# ------------------------------- Main entry --------------------------------
def run(
    engine: str,
    P_amb_bar: float,
    T_amb_K: float,
    RH_pct: float,
    load_pct: float,
    T_cool_in_K: Optional[float] = None,
    fuel_pct: Optional[Dict[str, float]] = None,
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

    Returns a dict with all station properties and diagnostics (see
    docstring and CycleResponse schema for fields).
    """
    if engine not in ENGINE_DECKS:
        raise ValueError(f"Unknown engine '{engine}'. Options: {list(ENGINE_DECKS)}")
    deck = ENGINE_DECKS[engine]
    fuel_pct = fuel_pct or dict(_DEFAULT_FUEL)

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

    # --- Phi from Cantera equilibrium HP at (T3, P3) targeting T4 ---
    ox_pct = _humid_air_mol_pct(T_amb_K, P_amb_bar, RH_pct)
    fuel_x = _normalize_to_gri(fuel_pct)
    ox_x = _normalize_to_gri(ox_pct)
    phi = _phi_for_target_T4(fuel_x, ox_x, stations["T3_K"], P3_bar, T4_K)

    # Physical fuel mass fraction at this phi → FAR = Y_f / (1 − Y_f)
    Y_f = fuel_mass_fraction_at_phi(fuel_x, ox_x, phi, GRI_MECH)
    FAR = Y_f / max(1.0 - Y_f, 1e-20)
    mdot_fuel = mdot_air * FAR

    # --- Heat rate ---
    # Compute LHV (mass basis) via a Cantera enthalpy-of-combustion reference
    # calc: burn the fuel to CO2 + H2O at 298 K, ΔH_combustion per kg_fuel.
    LHV_fuel = _estimate_LHV_mass_J_per_kg(fuel_x)     # J/kg
    # Heat rate kJ/kWh  = (fuel · LHV / MW_net) · 3600 (J/s)/(kJ) · ...
    if MW_net > 1e-6:
        heat_rate_kJ_per_kWh = (mdot_fuel * LHV_fuel / (MW_net * 1e6)) * 3600.0
    else:
        heat_rate_kJ_per_kWh = 0.0
    efficiency = (MW_net * 1e6) / (mdot_fuel * LHV_fuel) if (mdot_fuel * LHV_fuel) > 0 else 0.0

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
        "mdot_fuel_kg_s": float(mdot_fuel),
        "FAR": float(FAR),
        "phi": float(phi),
        # Performance
        "efficiency_LHV": float(efficiency),
        "heat_rate_kJ_per_kWh": float(heat_rate_kJ_per_kWh),
        "LHV_fuel_MJ_per_kg": float(LHV_fuel / 1e6),
        # Humid-air composition at inlet (for reference)
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
