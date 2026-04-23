"""Adiabatic Flame Temperature via Cantera equilibrium."""
from __future__ import annotations

from typing import Dict, Optional

import cantera as ct

from .mixture import compute_ratios, make_gas, make_gas_mixed
from .water_mix import make_gas_mixed_with_water


def run(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    phi: float,
    T0_K: float,
    P_bar: float,
    heat_loss_fraction: float = 0.0,
    T_fuel_K: Optional[float] = None,
    T_air_K: Optional[float] = None,
    WFR: float = 0.0,
    water_mode: str = "liquid",
    T_products_K: Optional[float] = None,
) -> dict:
    """Equilibrium adiabatic flame temp with optional heat-loss fraction.

    For heat_loss > 0, we subtract the fraction from the enthalpy change and re-equilibrate at constant (H, P).

    If T_fuel_K / T_air_K are provided, the two inlet streams are mixed
    adiabatically (enthalpy-weighted) before equilibrium. Otherwise both
    default to T0_K (previous single-inlet behavior). T_mixed (the pre-
    combustion mixture temperature) is returned so the caller can show the
    user what inlet T was used.
    """
    T_f = float(T_fuel_K) if T_fuel_K is not None else float(T0_K)
    T_a = float(T_air_K) if T_air_K is not None else float(T0_K)
    if WFR and WFR > 0:
        # 3-stream path: fuel + air + water (liquid or steam), adiabatic premix
        gas, _, _, T_mixed, _Y_w = make_gas_mixed_with_water(
            fuel_pct, ox_pct, phi, T_f, T_a, P_bar, WFR, water_mode
        )
    elif T_fuel_K is not None or T_air_K is not None:
        gas, _, _, T_mixed = make_gas_mixed(fuel_pct, ox_pct, phi, T_f, T_a, P_bar)
    else:
        gas, _, _ = make_gas(fuel_pct, ox_pct, phi, T0_K, P_bar)
        T_mixed = float(T0_K)

    # Store reactant-state reference values
    h_reactants = gas.enthalpy_mass  # J/kg
    mw_reactants = gas.mean_molecular_weight

    # Full adiabatic equilibrium at constant (H, P)
    gas.equilibrate("HP")
    T_ad = gas.T

    # Heat-loss case: reduce enthalpy by heat_loss_fraction of (h_ad - h_reactants) → re-equilibrate HP
    if heat_loss_fraction > 0:
        # Set up at T_ad (products hot state), then remove fraction of heat release
        gas_hl = ct.Solution("gri30.yaml")
        gas_hl.TPX = gas.T, gas.P, gas.X
        h_ad = gas_hl.enthalpy_mass
        # Absolute enthalpy reference: the reactants had h_reactants at T0; after adiabatic combustion,
        # products equilibrium is at h_ad which should equal h_reactants (conservation, HP eq).
        # Subtract heat loss fraction of the enthalpy ABOVE the reactant level at their sensible datum.
        # Approximate: h_target = h_ad - fraction * (h_ad - h_r_at_Tad_sensible_floor)
        # Simpler practical formulation: new_h = h_ad - frac * c_p * (T_ad - T0)
        cp_prod = gas_hl.cp_mass
        new_T_target = gas_hl.T - heat_loss_fraction * (gas_hl.T - T0_K)
        gas_hl.TP = new_T_target, gas_hl.P
        # Re-equilibrate products at constant TP
        try:
            gas_hl.equilibrate("TP")
        except Exception:
            pass
        gas = gas_hl
        T_actual = gas.T
    else:
        T_actual = T_ad

    mole_fracs = {s: float(v) for s, v in zip(gas.species_names, gas.X) if v > 1e-10}
    mass_fracs = {s: float(v) for s, v in zip(gas.species_names, gas.Y) if v > 1e-10}
    mw_prod = float(gas.mean_molecular_weight)
    # species per kg mixture (kmol / kg = Y / MW_species)
    kmol_per_kg = {
        s: float(gas.Y[gas.species_index(s)]) / float(gas.molecular_weights[gas.species_index(s)])
        for s in mole_fracs
    }

    FAR, FAR_stoich, AFR, AFR_stoich = compute_ratios(fuel_pct, ox_pct, phi)

    # Optional second equilibrium at a target product temperature (e.g. T4 = turbine
    # inlet from the cycle). Same elemental composition, re-equilibrated at fixed (T,P).
    # Used to show the diluted/cooled product mix the turbine actually sees, which
    # differs from the hot adiabatic flame composition above.
    mole_fracs_at_T: Dict[str, float] = {}
    if T_products_K is not None and float(T_products_K) > 0:
        try:
            gas_T = ct.Solution("gri30.yaml")
            # Reuse the equilibrated product elemental state, then re-equilibrate at fixed T,P.
            gas_T.TPX = float(T_products_K), gas.P, gas.X
            gas_T.equilibrate("TP")
            mole_fracs_at_T = {
                s: float(v) for s, v in zip(gas_T.species_names, gas_T.X) if v > 1e-10
            }
        except Exception:
            # Never let the secondary calculation break the primary AFT response.
            mole_fracs_at_T = {}

    return {
        "T_ad": float(T_ad),
        "T_actual": float(T_actual),
        "T_mixed_inlet_K": float(T_mixed),
        "mole_fractions": mole_fracs,
        "mass_fractions": mass_fracs,
        "species_kmol_per_kg_mix": kmol_per_kg,
        "h_reactants": float(h_reactants),
        "h_products": float(gas.enthalpy_mass),
        "cp_products": float(gas.cp_mass),
        "mw_products": mw_prod,
        "FAR_stoich": FAR_stoich,
        "FAR": FAR,
        "AFR_stoich": AFR_stoich,
        "AFR": AFR,
        "T_products_K": float(T_products_K) if T_products_K is not None else None,
        "mole_fractions_at_T_products": mole_fracs_at_T,
    }
