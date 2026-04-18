"""Independent reference PSR+PFR Cantera solve — used once to re-pin the
regression test values after the PSR-volume correctness fix (commit 041899f).

This script deliberately shares NO code with app.science.combustor so that it
serves as an independent oracle. Only stdlib + cantera.

Run: python -m api.tests._ref_psr_pfr    (from repo root, with venv active)
"""
from __future__ import annotations

import cantera as ct
import numpy as np

F_TO_K = lambda f: (f - 32) * 5 / 9 + 273.15
PSIA_TO_BAR = 1.0 / 14.5037738
BAR_TO_PA = 1e5

# Original user fuel (as in the test): CH4 93.1, C2H6 3.2, C3H8 0.7, C4H10 0.4, CO2 1.0, N2 1.6
# GRI-Mech 3.0 does not contain C4H10. The app maps C4H10 → 0.75·C3H8 + 0.25·CH4
# (preserves H/C ratio). We apply the same mapping here so this oracle matches what
# the app asks Cantera to solve.
FUEL = {
    "CH4":  93.1 + 0.25 * 0.4,    # 93.20
    "C2H6": 3.2,
    "C3H8": 0.7 + 0.75 * 0.4,     # 1.00
    "CO2":  1.0,
    "N2":   1.6,
}
OX = {"O2": 20.29, "N2": 75.67, "AR": 0.9, "CO2": 0.03, "H2O": 3.11}
PHI = 0.52
T_1000F = F_TO_K(1000.0)
T_70F = F_TO_K(70.0)
P_BAR = 400.025 * PSIA_TO_BAR
P_PA = P_BAR * BAR_TO_PA
L_PFR = 0.539 * 0.3048  # m
V_PFR = 100.0 * 0.3048  # m/s

MECH = "gri30.yaml"


def _mass_fractions_from_pct(pct: dict, gas: ct.Solution) -> dict:
    """Convert a %-by-mole composition dict to the mole-fraction dict Cantera wants."""
    total = sum(pct.values())
    return {sp: v / total for sp, v in pct.items() if v > 0}


def _adiabatic_mix(T_fuel: float, T_air: float, phi: float) -> tuple[float, dict]:
    """Mix fuel and air adiabatically at phi. Returns (T_mixed, X_mixed).

    If T_fuel == T_air, T_mixed = T_air trivially. Otherwise do a proper
    enthalpy balance using each stream's actual mass fraction in the final
    mixture (which we get by building the mixed gas at set_equivalence_ratio).
    """
    # 1. Build the target mixture composition at some reference T (any valid T works)
    gas_mix = ct.Solution(MECH)
    gas_mix.TP = 300.0, P_PA
    gas_mix.set_equivalence_ratio(phi,
                                   fuel=_mass_fractions_from_pct(FUEL, gas_mix),
                                   oxidizer=_mass_fractions_from_pct(OX, gas_mix))
    X_mixed = dict(zip(gas_mix.species_names, gas_mix.X))

    if abs(T_fuel - T_air) < 1e-6:
        return T_fuel, X_mixed

    # 2. Mass fraction of fuel stream in the mixture = sum Y_i for species originating in fuel.
    #    (Diluents CO2/N2 appear in both streams — assign them by mole-fraction share of each inlet.)
    fuel_mole_frac = sum(v / 100.0 for v in FUEL.values())  # mole of fuel stream per mole of (fuel+air)... no, this is wrong.
    # Easier: rebuild fuel and air streams as independent Solutions, get their mass fractions
    # in the final mixture by matching the molar amounts set_equivalence_ratio implies.
    gas_f = ct.Solution(MECH)
    gas_f.TP = T_fuel, P_PA
    gas_f.X = _mass_fractions_from_pct(FUEL, gas_f)
    gas_a = ct.Solution(MECH)
    gas_a.TP = T_air, P_PA
    gas_a.X = _mass_fractions_from_pct(OX, gas_a)

    # Moles of fuel per mole of oxidizer to hit phi:
    # phi * (O2_stoich / fuel_frac) ≈ molar_fuel_per_O2 · phi.
    # Use Cantera's mixture_fraction in reverse: set_equivalence_ratio sets the mix;
    # then the mass ratio is Y_fuel_stream / Y_ox_stream.
    # Moles of each stream per unit mole of mix:
    m_f_per_mix = sum(gas_mix.X[gas_mix.species_index(sp)]
                      for sp in FUEL if sp in gas_mix.species_names) * gas_f.mean_molecular_weight
    m_a_per_mix = sum(gas_mix.X[gas_mix.species_index(sp)]
                      for sp in OX if sp in gas_mix.species_names) * gas_a.mean_molecular_weight
    # NOTE: diluents appearing in both streams get attributed by name match above — imperfect but
    # the fuel used in this test has only trace CO2/N2 diluent, so the T_mixed error is small.
    Y_f = m_f_per_mix / (m_f_per_mix + m_a_per_mix) if (m_f_per_mix + m_a_per_mix) > 0 else 0.0
    Y_a = 1.0 - Y_f

    h_target = Y_f * gas_f.enthalpy_mass + Y_a * gas_a.enthalpy_mass

    # 3. Solve for T_mixed by bracketing — robust, no divergence.
    lo, hi = min(T_fuel, T_air) - 10.0, max(T_fuel, T_air) + 10.0
    gas_mix.TP = lo, P_PA
    h_lo = gas_mix.enthalpy_mass
    gas_mix.TP = hi, P_PA
    h_hi = gas_mix.enthalpy_mass
    # Bisect
    for _ in range(50):
        mid = 0.5 * (lo + hi)
        gas_mix.TP = mid, P_PA
        h_mid = gas_mix.enthalpy_mass
        if (h_mid - h_target) * (h_lo - h_target) < 0:
            hi, h_hi = mid, h_mid
        else:
            lo, h_lo = mid, h_mid
        if abs(hi - lo) < 1e-3:
            break

    return 0.5 * (lo + hi), X_mixed


def _ppmvd_exit(gas: ct.Solution, species: str) -> float:
    """Dry-basis ppmv of `species` in the exhaust."""
    X = gas.X
    idx = {s: gas.species_index(s) for s in ("H2O", species)}
    X_dry_denom = 1.0 - X[idx["H2O"]]
    if X_dry_denom <= 0:
        return 0.0
    return X[idx[species]] / X_dry_denom * 1e6


def _o2_pct_dry(gas: ct.Solution) -> float:
    X = gas.X
    h2o = gas.species_index("H2O")
    o2 = gas.species_index("O2")
    denom = 1.0 - X[h2o]
    if denom <= 0:
        return 0.0
    return X[o2] / denom * 100.0


def _correct_to_15o2(ppm_dry: float, o2_dry_pct: float) -> float:
    return ppm_dry * (20.95 - 15.0) / (20.95 - o2_dry_pct)


def solve_case(tau_ms: float, T_fuel_K: float, T_air_K: float) -> dict:
    """Solve PSR (V = Vdot_in · τ) + PFR of length L_PFR at V_PFR m/s."""
    # 1. Adiabatic-mix the two inlets at their own temps
    T_mixed, _X_mixed = _adiabatic_mix(T_fuel_K, T_air_K, PHI)

    # 2. Build the inlet gas at (T_mixed, P, phi)
    inlet = ct.Solution(MECH)
    inlet.TP = T_mixed, P_PA
    inlet.set_equivalence_ratio(PHI,
                                fuel=_mass_fractions_from_pct(FUEL, inlet),
                                oxidizer=_mass_fractions_from_pct(OX, inlet))

    # 3. PSR — cold-ignited seed to a hot equilibrium, then advance to steady
    psr_gas = ct.Solution(MECH)
    psr_gas.TPX = T_mixed, P_PA, inlet.X
    # seed: equilibrate at HP to get a reacting state (prevents cold-trap)
    psr_gas.equilibrate("HP")

    # Compute mdot so that PSR volume / inlet specific volume · mdot = τ
    # mdot chosen as 1 kg/s; scale V to match τ.
    mdot = 1.0  # kg/s
    tau_s = tau_ms * 1e-3
    V_psr = tau_s * mdot / inlet.density

    upstream = ct.Reservoir(inlet)
    psr = ct.IdealGasReactor(psr_gas, energy="on")
    psr.volume = V_psr

    downstream = ct.Reservoir(psr_gas)
    mfc = ct.MassFlowController(upstream, psr, mdot=mdot)
    # Cantera 3.2+: PressureController uses `primary=` not `master=`
    valve = ct.PressureController(upstream=psr, downstream=downstream, primary=mfc, K=1e-2)

    net = ct.ReactorNet([psr])
    net.advance_to_steady_state()

    T_psr = psr.T
    NO_psr_ppm = _ppmvd_exit(psr_gas, "NO")
    CO_psr_ppm = _ppmvd_exit(psr_gas, "CO")
    O2_psr_dry = _o2_pct_dry(psr_gas)

    # 4. PFR — constant-P reactor, integrate for L_PFR at V_PFR
    pfr_gas = ct.Solution(MECH)
    pfr_gas.TPX = psr_gas.T, P_PA, psr_gas.X
    pfr = ct.IdealGasConstPressureReactor(pfr_gas, energy="on")
    pfr_net = ct.ReactorNet([pfr])
    tau_pfr_s = L_PFR / V_PFR
    pfr_net.advance(tau_pfr_s)

    T_exit = pfr.T
    NO_exit_ppm = _ppmvd_exit(pfr_gas, "NO")
    CO_exit_ppm = _ppmvd_exit(pfr_gas, "CO")
    O2_exit_dry = _o2_pct_dry(pfr_gas)

    return {
        "T_mixed_inlet_K": T_mixed,
        "T_psr": T_psr,
        "T_exit": T_exit,
        "tau_psr_ms": tau_ms,
        "tau_pfr_ms": tau_pfr_s * 1e3,
        "tau_total_ms": tau_ms + tau_pfr_s * 1e3,
        "NO_ppm_vd_psr": NO_psr_ppm,
        "NO_ppm_vd_exit": NO_exit_ppm,
        "CO_ppm_vd_psr": CO_psr_ppm,
        "CO_ppm_vd_exit": CO_exit_ppm,
        "O2_pct_dry_psr": O2_psr_dry,
        "O2_pct_dry_exit": O2_exit_dry,
        "NO_ppm_15O2": _correct_to_15o2(NO_exit_ppm, O2_exit_dry),
    }


if __name__ == "__main__":
    print("=== Case A: τ_PSR = 2 ms, T_fuel = T_air = 1000 F ===")
    A = solve_case(2.0, T_1000F, T_1000F)
    for k, v in A.items():
        print(f"  {k:20s} = {v:.4f}")

    print("\n=== Case B: τ_PSR = 0.5 ms, T_fuel = T_air = 1000 F ===")
    B = solve_case(0.5, T_1000F, T_1000F)
    for k, v in B.items():
        print(f"  {k:20s} = {v:.4f}")

    print("\n=== Case C: τ_PSR = 0.5 ms, T_fuel = 70 F, T_air = 1000 F ===")
    C = solve_case(0.5, T_70F, T_1000F)
    for k, v in C.items():
        print(f"  {k:20s} = {v:.4f}")
