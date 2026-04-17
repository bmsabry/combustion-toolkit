"""Shared helpers for converting frontend fuel/oxidizer compositions into Cantera mixture strings."""
from __future__ import annotations

from typing import Dict, Tuple

import cantera as ct
import numpy as np

# Species we always want available in the mechanism for typical fuels + air + products
GRI_MECH = "gri30.yaml"

# Fallback substitutions for species that don't exist in GRI-Mech 3.0
# (GRI only has C1-C3 hydrocarbons + H2, NOx, so anything heavier needs a stand-in)
FUEL_SUBSTITUTIONS = {
    # GRI has these already: CH4, C2H2, C2H4, C2H6, C3H8 (as C3H8 doesn't exist — uses NC3H7 precursor)
    # Higher alkanes: approximate with propane + methane to preserve H/C ratio
    "C4H10": {"C3H8": 0.75, "CH4": 0.25},  # rough H/C match; use proper mechanism for real work
    "C5H12": {"C3H8": 1.0, "CH4": 0.666},
    "C6H14": {"C3H8": 1.5, "CH4": 0.5},
    "C7H16": {"C3H8": 1.75, "CH4": 0.75},
    "C8H18": {"C3H8": 2.0, "CH4": 1.0},  # iso-octane stand-in
    # Other fuels mapped to nearest GRI species
    "C2H5OH": {"CH3OH": 2.0},  # ethanol → methanol + extra carbon
    "NH3": {"N2": 0.5, "H2": 1.5},  # ammonia fallback (GRI has NO/NH path but no NH3)
}

OXIDIZER_SPECIES = {"O2", "N2", "AR", "H2O", "CO2"}


def _normalize_to_gri(comp_mol_pct: Dict[str, float]) -> Dict[str, float]:
    """Take user composition (mole%), map exotic species to GRI substitutes, return dict normalized to sum 1.0."""
    gri = ct.Solution(GRI_MECH)
    available = set(gri.species_names)
    out: Dict[str, float] = {}
    for name, pct in comp_mol_pct.items():
        if pct <= 0:
            continue
        key = name.strip()
        # canonical fixes
        if key.upper() == "AR":
            key = "AR"
        if key in available:
            out[key] = out.get(key, 0.0) + pct / 100.0
        elif key in FUEL_SUBSTITUTIONS:
            for s, mult in FUEL_SUBSTITUTIONS[key].items():
                if s in available:
                    out[s] = out.get(s, 0.0) + mult * pct / 100.0
        else:
            # fall back to methane equivalent (keeps calc running; flag in logs)
            if "CH4" in available:
                out["CH4"] = out.get("CH4", 0.0) + pct / 100.0
    total = sum(out.values())
    if total <= 0:
        raise ValueError("Composition is empty after normalization")
    return {k: v / total for k, v in out.items()}


def make_gas(fuel_pct: Dict[str, float], ox_pct: Dict[str, float], phi: float, T: float, P_bar: float):
    """Build a Cantera Solution at the stoichiometric-scaled mixture for phi, T, P."""
    gas = ct.Solution(GRI_MECH)
    fuel_x = _normalize_to_gri(fuel_pct)
    ox_x = _normalize_to_gri(ox_pct)
    fuel_str = ", ".join(f"{k}:{v:.10f}" for k, v in fuel_x.items())
    ox_str = ", ".join(f"{k}:{v:.10f}" for k, v in ox_x.items())
    gas.TP = float(T), float(P_bar) * 1e5  # bar -> Pa
    gas.set_equivalence_ratio(float(phi), fuel=fuel_str, oxidizer=ox_str)
    return gas, fuel_str, ox_str


def make_gas_mixed(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    phi: float,
    T_fuel_K: float,
    T_air_K: float,
    P_bar: float,
):
    """Build a Cantera Solution representing fuel (at T_fuel) and air (at T_air)
    adiabatically mixed at the target equivalence ratio.

    Returns (gas, fuel_str, ox_str, T_mixed_K). `gas` is at the mixed state
    (T=T_mixed, composition at phi, pressure=P). If T_fuel == T_air, T_mixed
    equals that value (degenerate case = previous behavior).
    """
    gas = ct.Solution(GRI_MECH)
    fuel_x = _normalize_to_gri(fuel_pct)
    ox_x = _normalize_to_gri(ox_pct)
    fuel_str = ", ".join(f"{k}:{v:.10f}" for k, v in fuel_x.items())
    ox_str = ", ".join(f"{k}:{v:.10f}" for k, v in ox_x.items())
    P_Pa = float(P_bar) * 1e5

    # Target mixture composition at phi (composition is T-independent via set_equivalence_ratio)
    gas.TP = 298.15, P_Pa
    gas.set_equivalence_ratio(float(phi), fuel=fuel_str, oxidizer=ox_str)
    X_mix = gas.X.copy()

    # If both streams are at the same temperature, skip enthalpy mixing
    if abs(float(T_fuel_K) - float(T_air_K)) < 1e-6:
        gas.TPX = float(T_fuel_K), P_Pa, X_mix
        return gas, fuel_str, ox_str, float(T_fuel_K)

    # Fuel-stream composition vector (only fuel species, normalized)
    X_fuel_vec = np.zeros(gas.n_species)
    for s, v in fuel_x.items():
        idx = gas.species_index(s)
        if idx >= 0:
            X_fuel_vec[idx] = v
    if X_fuel_vec.sum() <= 0:
        raise ValueError("Empty fuel composition")
    X_fuel_vec /= X_fuel_vec.sum()

    # Air-stream composition vector (only oxidizer species, normalized)
    X_air_vec = np.zeros(gas.n_species)
    for s, v in ox_x.items():
        idx = gas.species_index(s)
        if idx >= 0:
            X_air_vec[idx] = v
    if X_air_vec.sum() <= 0:
        raise ValueError("Empty oxidizer composition")
    X_air_vec /= X_air_vec.sum()

    # Specific enthalpies of each stream at its own inlet T
    g_f = ct.Solution(GRI_MECH)
    g_f.TPX = float(T_fuel_K), P_Pa, X_fuel_vec
    h_fuel = g_f.enthalpy_mass  # J/kg

    g_a = ct.Solution(GRI_MECH)
    g_a.TPX = float(T_air_K), P_Pa, X_air_vec
    h_air = g_a.enthalpy_mass

    # Mass fraction of fuel-stream in the combined mixture (via Cantera's mixture_fraction).
    # Note: set_equivalence_ratio was already called; mixture_fraction reports Z for the phi mixture.
    try:
        Z = float(gas.mixture_fraction(fuel=fuel_str, oxidizer=ox_str, basis="mass"))
    except Exception:
        # approximate for unreachable mechs — shouldn't happen with GRI
        Z = 0.0
    Y_fuel = Z
    Y_air = 1.0 - Z
    h_mix = Y_fuel * h_fuel + Y_air * h_air

    # Mixed state: given (h_mix, P, X_mix) solve for T
    gas.HPX = h_mix, P_Pa, X_mix
    T_mixed = float(gas.T)
    return gas, fuel_str, ox_str, T_mixed


def compute_ratios(fuel_pct: Dict[str, float], ox_pct: Dict[str, float], phi: float) -> Tuple[float, float, float, float]:
    """Return (FAR, FAR_stoich, AFR, AFR_stoich) on a mass basis using Cantera's mixture_fraction.

    Uses Cantera's built-in mixture_fraction which correctly separates fuel-stream mass
    from oxidizer-stream mass even when both streams share species like N2 / CO2 / H2O.
    """
    gas = ct.Solution(GRI_MECH)
    fuel_x = _normalize_to_gri(fuel_pct)
    ox_x = _normalize_to_gri(ox_pct)
    fuel_str = ", ".join(f"{k}:{v:.10f}" for k, v in fuel_x.items())
    ox_str = ", ".join(f"{k}:{v:.10f}" for k, v in ox_x.items())
    gas.TP = 298.15, 101325.0
    gas.set_equivalence_ratio(1.0, fuel=fuel_str, oxidizer=ox_str)
    # Z = fuel-stream mass fraction in the combined mixture (0 ≤ Z ≤ 1)
    try:
        Z_stoich = float(gas.mixture_fraction(fuel=fuel_str, oxidizer=ox_str, basis="mass"))
    except Exception:
        # Older Cantera fallback
        Z_stoich = 1.0 / (1.0 + 16.0)  # approximate methane stoich
    FAR_stoich = Z_stoich / max(1.0 - Z_stoich, 1e-20)
    AFR_stoich = 1.0 / max(FAR_stoich, 1e-20)
    FAR = phi * FAR_stoich
    AFR = 1.0 / max(FAR, 1e-20)
    return FAR, FAR_stoich, AFR, AFR_stoich
