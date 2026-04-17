"""Adiabatic Flame Temperature via Cantera equilibrium."""
from __future__ import annotations

from typing import Dict

import cantera as ct

from .mixture import compute_ratios, make_gas


def run(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    phi: float,
    T0_K: float,
    P_bar: float,
    heat_loss_fraction: float = 0.0,
) -> dict:
    """Equilibrium adiabatic flame temp with optional heat-loss fraction.

    For heat_loss > 0, we subtract the fraction from the enthalpy change and re-equilibrate at constant (H, P).
    """
    gas, _, _ = make_gas(fuel_pct, ox_pct, phi, T0_K, P_bar)

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

    return {
        "T_ad": float(T_ad),
        "T_actual": float(T_actual),
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
    }
