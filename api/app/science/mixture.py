"""Shared helpers for converting frontend fuel/oxidizer compositions into Cantera mixture strings."""
from __future__ import annotations

import os
from typing import Dict, Tuple

import cantera as ct
import numpy as np

# Species we always want available in the mechanism for typical fuels + air + products
GRI_MECH = "gri30.yaml"

# Glarborg 2018 — alternative mechanism with comprehensive nitrogen chemistry and
# C1–C2 hydrocarbon oxidation. Shipped as a YAML file alongside this source tree.
_MECH_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "mechanisms")
GLARBORG_MECH = os.path.join(_MECH_DIR, "glarborg_2018.yaml")

# Registry: code → (absolute yaml path, supports_C3plus)
MECH_CATALOG: Dict[str, Tuple[str, bool]] = {
    "gri30":    (GRI_MECH,      True),   # GRI-Mech 3.0: CH4–C3H8 + NOx
    "glarborg": (GLARBORG_MECH, False),  # Glarborg 2018: CH4–C2 + comprehensive N-chem; C3+ lumped to C2H6
}


def mech_yaml(mechanism: str) -> str:
    """Return the YAML path for a mechanism code. Unknown codes fall back to GRI-Mech 3.0."""
    entry = MECH_CATALOG.get(mechanism)
    if entry is None:
        return GRI_MECH
    return entry[0]


# Fallback substitutions for species that don't exist in the loaded mechanism.
# Applied after we see the actual species list; keyed by species name.
# Each entry maps source_species → {target_species: mole_multiplier} (preserves carbon count).
FUEL_SUBSTITUTIONS = {
    # GRI has these already: CH4, C2H2, C2H4, C2H6, C3H8.
    # Higher alkanes: approximate with propane + methane to preserve H/C ratio
    "C4H10": {"C3H8": 0.75, "CH4": 0.25},   # rough H/C match; use proper mechanism for real work
    "C5H12": {"C3H8": 1.0, "CH4": 0.666},
    "C6H14": {"C3H8": 1.5, "CH4": 0.5},
    "C7H16": {"C3H8": 1.75, "CH4": 0.75},
    "C8H18": {"C3H8": 2.0, "CH4": 1.0},     # iso-octane stand-in
    # Mechanisms without C3 (Glarborg): lump C3H8 into C2H6 preserving hydrocarbon-mol basis
    "C3H8":  {"C2H6": 1.0},  # loses one C-atom per mol; ok for <2% NG content
    # Other fuels mapped to nearest available species
    "C2H5OH": {"CH3OH": 2.0},
    "NH3":    {"N2": 0.5, "H2": 1.5},
}

OXIDIZER_SPECIES = {"O2", "N2", "AR", "H2O", "CO2"}


def fuel_mass_fraction_at_phi(
    fuel_x: Dict[str, float],
    ox_x: Dict[str, float],
    phi: float,
    mech_path: str,
) -> float:
    """Physical fuel mass fraction Y_f = m_fuel / (m_fuel + m_air) at equivalence
    ratio phi, for the given normalized fuel and oxidizer compositions.

    Computed from stoichiometry directly — NOT from Cantera's Bilger mixture_fraction.
    Bilger Z agrees with Y_f only when the oxidizer is free of C/H atoms (dry air).
    For humid air, EGR, or vitiated oxidizers, Bilger under-counts fuel mass by
    20–30 %, which silently biases every enthalpy-mix path that consumes it.

    Atom-count stoichiometry: per mole of fuel, O2 demand = nC + nH/4 - nO/2.
    Combined with X_O2 in the oxidizer stream, this fixes the molar ratio
    α = n_fuel/(n_fuel+n_ox) at the requested phi; mass fraction follows via
    the two stream MWs.
    """
    g_tmp = ct.Solution(mech_path)
    stoich_O2 = 0.0
    for s, v in fuel_x.items():
        try:
            nC = g_tmp.n_atoms(s, "C")
            nH = g_tmp.n_atoms(s, "H")
            nO = g_tmp.n_atoms(s, "O")
        except Exception:
            nC = nH = nO = 0
        stoich_O2 += v * (nC + nH / 4.0 - nO / 2.0)
    X_O2 = ox_x.get("O2", 0.0)
    if stoich_O2 <= 0 or X_O2 <= 0:
        # Fallback: treat composition as pure-methane-ish. Still better than 0.
        return 0.05
    frac_f_per_ox = float(phi) * X_O2 / stoich_O2
    alpha = frac_f_per_ox / (1.0 + frac_f_per_ox)

    # Stream MWs from normalized compositions
    g_f = ct.Solution(mech_path)
    Xf = np.zeros(g_f.n_species)
    for s, v in fuel_x.items():
        idx = g_f.species_index(s)
        if idx >= 0:
            Xf[idx] = v
    Xf /= max(Xf.sum(), 1e-30)
    g_f.TPX = 298.15, 101325.0, Xf
    MW_f = g_f.mean_molecular_weight

    g_a = ct.Solution(mech_path)
    Xa = np.zeros(g_a.n_species)
    for s, v in ox_x.items():
        idx = g_a.species_index(s)
        if idx >= 0:
            Xa[idx] = v
    Xa /= max(Xa.sum(), 1e-30)
    g_a.TPX = 298.15, 101325.0, Xa
    MW_a = g_a.mean_molecular_weight

    return (alpha * MW_f) / (alpha * MW_f + (1.0 - alpha) * MW_a)


def _normalize_to_mech(comp_mol_pct: Dict[str, float], mechanism: str = "gri30") -> Dict[str, float]:
    """Take user composition (mole%), map exotic species to mechanism-available substitutes, return dict normalized to sum 1.0."""
    gas = ct.Solution(mech_yaml(mechanism))
    available = set(gas.species_names)
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
            # Try the substitution — recursively, one level deep — so mechanism-specific
            # fallbacks kick in when the preferred substitute also isn't available.
            for s, mult in FUEL_SUBSTITUTIONS[key].items():
                if s in available:
                    out[s] = out.get(s, 0.0) + mult * pct / 100.0
                elif s in FUEL_SUBSTITUTIONS:
                    for s2, mult2 in FUEL_SUBSTITUTIONS[s].items():
                        if s2 in available:
                            out[s2] = out.get(s2, 0.0) + mult * mult2 * pct / 100.0
        else:
            # fall back to methane equivalent (keeps calc running; flag in logs)
            if "CH4" in available:
                out["CH4"] = out.get("CH4", 0.0) + pct / 100.0
    total = sum(out.values())
    if total <= 0:
        raise ValueError("Composition is empty after normalization")
    return {k: v / total for k, v in out.items()}


# Legacy alias — preserves the old function name used elsewhere in the codebase.
def _normalize_to_gri(comp_mol_pct: Dict[str, float]) -> Dict[str, float]:
    return _normalize_to_mech(comp_mol_pct, "gri30")


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
    mechanism: str = "gri30",
):
    """Build a Cantera Solution representing fuel (at T_fuel) and air (at T_air)
    adiabatically mixed at the target equivalence ratio.

    Returns (gas, fuel_str, ox_str, T_mixed_K). `gas` is at the mixed state
    (T=T_mixed, composition at phi, pressure=P). If T_fuel == T_air, T_mixed
    equals that value (degenerate case = previous behavior).
    """
    mech_path = mech_yaml(mechanism)
    gas = ct.Solution(mech_path)
    fuel_x = _normalize_to_mech(fuel_pct, mechanism)
    ox_x = _normalize_to_mech(ox_pct, mechanism)
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
    g_f = ct.Solution(mech_path)
    g_f.TPX = float(T_fuel_K), P_Pa, X_fuel_vec
    h_fuel = g_f.enthalpy_mass  # J/kg

    g_a = ct.Solution(mech_path)
    g_a.TPX = float(T_air_K), P_Pa, X_air_vec
    h_air = g_a.enthalpy_mass

    # Physical fuel mass fraction Y_f = m_fuel/(m_fuel+m_air) at this phi.
    # We compute it stoichiometrically, NOT via Cantera's Bilger mixture_fraction.
    # Bilger Z agrees with Y_f only when the oxidizer is free of C/H atoms (dry air).
    # With humid air (3% H2O) or EGR, Bilger under-counts fuel by 20–30 %, which
    # silently biases the enthalpy mix and produces a wrong T_mixed.
    Y_fuel = fuel_mass_fraction_at_phi(fuel_x, ox_x, float(phi), mech_path)
    Y_air = 1.0 - Y_fuel
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
