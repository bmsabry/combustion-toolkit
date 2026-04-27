"""Complete-combustion flame temperature and product composition.

Models the classic Kuo/Turns "no dissociation" assumption: all fuel burns
to CO2 + H2O with no radicals, no NO, no dissociation. For rich mixtures,
water-gas-shift-style product shift: H2O is preferred over CO2, so the
first O deficit bleeds CO2 → CO (+½ O2 recovered), then H2O → H2 if the
deficit still stands.

Used as the canonical "complete combustion" reference alongside the
Cantera full-Gibbs equilibrium in aft.run / exhaust.run. For gas-turbine
stack and diluted combustor-exit measurements (where T has dropped far
enough that equilibrium dissociation products have recombined), complete
combustion is the more physically accurate product-composition assumption.
"""
from __future__ import annotations

from typing import Dict, Optional, Tuple

import cantera as ct
import numpy as np

from .mixture import make_gas_mixed, compute_ratios, mech_yaml
from .water_mix import make_gas_mixed_with_water


# Species carried in the complete-combustion product set. The N-only set is
# intentionally narrow: NO is NOT a complete-combustion product (it's a thermal
# equilibrium species). Soot is not modeled here; extreme-rich deficits are
# reported but no solid carbon species are emitted.
_PRODUCT_SPECIES = ("CO2", "H2O", "O2", "N2", "AR", "CO", "H2")


def _elemental_moles_per_kg(gas: ct.Solution) -> Dict[str, float]:
    """Return mol-of-element / kg-of-mixture for C, H, O, N, Ar."""
    atomic_mass = {"C": 12.011, "H": 1.008, "O": 15.999, "N": 14.007, "Ar": 39.948}
    out: Dict[str, float] = {}
    for el in ("C", "H", "O", "N", "Ar"):
        try:
            mass_frac = float(gas.elemental_mass_fraction(el))
        except Exception:
            mass_frac = 0.0
        out[el] = mass_frac * 1000.0 / atomic_mass[el]
    return out


def _build_complete_products(
    z: Dict[str, float],
) -> Tuple[Dict[str, float], float, bool]:
    """Given elemental mol/kg, return product mole distribution per kg + O2 leftover flag + soot flag.

    Lean: all C→CO2, all H→H2O, remaining O as O2.
    Rich: shift CO2 → CO and (if still short) H2O → H2 to balance O atoms.
    Returns (n_per_kg dict over _PRODUCT_SPECIES, O2_leftover_mol_per_kg, soot_flag).
    """
    n = {k: 0.0 for k in _PRODUCT_SPECIES}
    n["CO2"] = z["C"]
    n["H2O"] = z["H"] / 2.0
    n["N2"] = z["N"] / 2.0
    n["AR"] = z["Ar"]

    # O atom balance: z_O_total = 2·CO2 + H2O + 2·O2_left (+ CO for rich +)
    # Solve for O2 leftover assuming lean distribution first.
    n_O2_left = (z["O"] - 2.0 * n["CO2"] - n["H2O"]) / 2.0

    soot = False
    if n_O2_left >= -1e-12:
        # Lean or stoichiometric — O2 leftover ≥ 0.
        n["O2"] = max(0.0, n_O2_left)
    else:
        # Rich: O2 deficit. Shift products to consume less O.
        deficit_O2 = -n_O2_left   # mol O2 equivalent short
        # Step 1: CO2 → CO + ½ O2. Each CO shifted frees ½ mol O2.
        # Need deficit_O2 mol O2 back → shift up to 2·deficit_O2 mol CO2.
        shift_CO2 = min(2.0 * deficit_O2, n["CO2"])
        n["CO2"] -= shift_CO2
        n["CO"] += shift_CO2
        deficit_O2 -= shift_CO2 / 2.0

        if deficit_O2 > 1e-12:
            # Step 2: H2O → H2 + ½ O2. Shift up to 2·deficit_O2 mol H2O.
            shift_H2O = min(2.0 * deficit_O2, n["H2O"])
            n["H2O"] -= shift_H2O
            n["H2"] += shift_H2O
            deficit_O2 -= shift_H2O / 2.0

        if deficit_O2 > 1e-10:
            # Truly extreme rich (soot regime); unmodeled.
            soot = True

        n["O2"] = 0.0
        n_O2_left = 0.0

    return n, n_O2_left, soot


def run(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    phi: float,
    T_fuel_K: float,
    T_air_K: float,
    P_bar: float,
    WFR: float = 0.0,
    water_mode: str = "liquid",
    T_water_K: Optional[float] = None,
    mechanism: str = "gri30",
) -> dict:
    """Complete-combustion adiabatic flame temperature.

    Builds the 3-stream inlet (fuel + air + optional water) via the same
    enthalpy-balance helpers as the rest of the stack, then solves for T
    such that the product-mixture enthalpy (with the complete-combustion
    product set) equals the reactant enthalpy.

    Returns a dict compatible with AFTResponse.
    """
    if WFR and WFR > 0:
        gas_in, _, _, T_mixed, _Y_w = make_gas_mixed_with_water(
            fuel_pct, ox_pct, phi, T_fuel_K, T_air_K, P_bar, WFR, water_mode,
            T_water_K=T_water_K, mechanism=mechanism,
        )
    else:
        gas_in, _, _, T_mixed = make_gas_mixed(
            fuel_pct, ox_pct, phi, T_fuel_K, T_air_K, P_bar, mechanism=mechanism,
        )
    h_in = float(gas_in.enthalpy_mass)
    P_Pa = float(gas_in.P)

    # Per kg of mixture, mol of each element.
    z = _elemental_moles_per_kg(gas_in)
    n_prod, n_O2_left, soot_flag = _build_complete_products(z)

    # Build the products Cantera Solution and Newton-solve for T at (h, P).
    # Pooled — slot is disjoint from anything mixture.make_gas_mixed uses,
    # so `gas_in` (mgm_main) and this `g_prod` (cc_prod) coexist safely.
    from ._solution_pool import get_solution
    g_prod = get_solution(mechanism, "cc_prod")
    X = np.zeros(g_prod.n_species)
    for sp, n in n_prod.items():
        if n <= 0:
            continue
        try:
            idx = g_prod.species_index(sp)
        except Exception:
            idx = -1
        if idx >= 0:
            X[idx] = n
    X_sum = X.sum()
    if X_sum <= 0:
        raise ValueError("Complete-combustion products vector is empty.")
    X = X / X_sum

    # Initial guess: reasonable hydrocarbon flame T at this P.
    T_guess = max(1200.0, min(2800.0, 1800.0 + 0.8 * (T_mixed - 300.0)))
    g_prod.TPX = T_guess, P_Pa, X
    for _ in range(80):
        h_prod = g_prod.enthalpy_mass
        cp = max(g_prod.cp_mass, 100.0)
        err = h_in - h_prod
        dT = err / cp * 0.85
        # Clamp step to avoid runaway
        dT = max(-200.0, min(200.0, dT))
        T_guess += dT
        T_guess = max(250.0, min(4000.0, T_guess))
        g_prod.TP = T_guess, P_Pa
        if abs(dT) < 0.05:
            break
    T_ad = float(g_prod.T)

    mole_fracs = {s: float(v) for s, v in zip(g_prod.species_names, g_prod.X) if v > 1e-10}
    mass_fracs = {s: float(v) for s, v in zip(g_prod.species_names, g_prod.Y) if v > 1e-10}

    # Dry basis (remove H2O, renormalize)
    X_dry = np.array(g_prod.X, dtype=float)
    h2o_idx = g_prod.species_index("H2O")
    h2o_x_wet = float(X_dry[h2o_idx]) if h2o_idx >= 0 else 0.0
    if h2o_idx >= 0:
        X_dry[h2o_idx] = 0.0
    s = X_dry.sum()
    if s > 0:
        X_dry = X_dry / s
    dry_fracs = {sp: float(x) for sp, x in zip(g_prod.species_names, X_dry) if x > 1e-10}

    O2_pct_dry = float(dry_fracs.get("O2", 0.0) * 100.0)
    CO2_pct_dry = float(dry_fracs.get("CO2", 0.0) * 100.0)
    CO_pct_dry = float(dry_fracs.get("CO", 0.0) * 100.0)

    FAR, FAR_stoich, AFR, AFR_stoich = compute_ratios(fuel_pct, ox_pct, phi)

    return {
        "T_ad": T_ad,
        "T_mixed_inlet_K": float(T_mixed),
        "mole_fractions": mole_fracs,
        "mass_fractions": mass_fracs,
        "mole_fractions_dry": dry_fracs,
        "O2_pct_dry": O2_pct_dry,
        "CO2_pct_dry": CO2_pct_dry,
        "CO_pct_dry": CO_pct_dry,
        "H2O_pct_wet": h2o_x_wet * 100.0,
        "h_reactants": h_in,
        "h_products": float(g_prod.enthalpy_mass),
        "mw_products": float(g_prod.mean_molecular_weight),
        "FAR": FAR,
        "FAR_stoich": FAR_stoich,
        "AFR": AFR,
        "AFR_stoich": AFR_stoich,
        "soot_flag": bool(soot_flag),
    }
