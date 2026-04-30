"""Laminar flame speed via Cantera 1D freely-propagating premixed flame."""
from __future__ import annotations

from typing import Dict, Optional

import cantera as ct
import numpy as np

from .mixture import make_gas, make_gas_mixed
from .water_mix import make_gas_mixed_with_water


def run(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    phi: float,
    T0_K: float,
    P_bar: float,
    domain_length_m: float = 0.03,
    T_fuel_K: Optional[float] = None,
    T_air_K: Optional[float] = None,
    WFR: float = 0.0,
    water_mode: str = "liquid",
) -> dict:
    """Solve a 1D freely-propagating premixed flame and return burning velocity + T(x).

    If T_fuel_K / T_air_K are provided, the unburnt-mixture temperature is the
    adiabatic enthalpy-balance mix of the two streams. Otherwise both default
    to T0_K. WFR>0 enables 3-stream water injection (liquid or steam).
    """
    T_f = float(T_fuel_K) if T_fuel_K is not None else float(T0_K)
    T_a = float(T_air_K) if T_air_K is not None else float(T0_K)
    if WFR and WFR > 0:
        gas, _, _, T_mixed, _Y_w = make_gas_mixed_with_water(
            fuel_pct, ox_pct, phi, T_f, T_a, P_bar, WFR, water_mode
        )
    elif T_fuel_K is not None or T_air_K is not None:
        gas, _, _, T_mixed = make_gas_mixed(fuel_pct, ox_pct, phi, T_f, T_a, P_bar)
    else:
        gas, _, _ = make_gas(fuel_pct, ox_pct, phi, T0_K, P_bar)
        T_mixed = float(T0_K)

    # ── Unburned-mixture transport bundle ────────────────────────────────
    # Computed once at (T_mixed, P, X_unburned). The frontend Card 1
    # (regime diagnostics) depends on every member of this bundle:
    #   α_th = k / (ρ·c_p)              thermal diffusivity (Lewis-von Elbe g_c)
    #   ν    = μ / ρ                    kinematic viscosity (Reynolds Re_T)
    #   D_def= mix-avg diffusivity of   deficient-reactant species used for Le
    #          the deficient reactant
    #   Le   = α_th / D_def             effective Lewis number (deficient basis)
    #   δ_F  = α_th / S_L               flame thickness (Zeldovich, Williams 1985)
    #   Ma   = (Ze/2)·(Le − 1)          Markstein number (Bechtold-Matalon
    #                                   simplified — full expansion deferred
    #                                   to Phase 4 validation)
    # Ze (Zeldovich number) is approximated as Ze ≈ E_a·(T_b−T_u)/(R·T_b²).
    # We use the empirical E_a/R = 15000 K placeholder (typical for hydrocarbon
    # premixed flames) — replaced with a per-fuel fit in Phase 4.
    rho_u  = float(gas.density)
    cp_u   = float(gas.cp_mass)
    k_u    = float(gas.thermal_conductivity)
    mu_u   = float(gas.viscosity)
    alpha_th_u = k_u / (rho_u * cp_u)
    nu_u   = mu_u / rho_u

    # Deficient-reactant mixture-averaged diffusivity for Le.
    # For lean (φ ≤ 1): fuel is deficient → take fuel's mix-avg D.
    # For rich (φ > 1): O₂ is deficient → take O₂'s mix-avg D.
    # Pick the dominant fuel species by mole fraction (CH4 / H2 / etc.).
    try:
        D_mix = gas.mix_diff_coeffs                       # m²/s, length n_species
        if float(phi) <= 1.0:
            # Find the species whose mole fraction in fuel_pct is largest.
            fuel_keys = [k for k, v in fuel_pct.items() if v > 0]
            if fuel_keys:
                dominant = max(fuel_keys, key=lambda k: float(fuel_pct.get(k, 0)))
                idx = gas.species_index(dominant) if dominant in gas.species_names else gas.species_index("CH4")
            else:
                idx = gas.species_index("CH4")
        else:
            idx = gas.species_index("O2") if "O2" in gas.species_names else 0
        D_def = float(D_mix[idx]) if idx < len(D_mix) else alpha_th_u
        if not (D_def > 0):
            D_def = alpha_th_u
    except Exception:
        # Fallback: assume Le = 1 (α_th == D_def).
        D_def = alpha_th_u
    Le_eff = alpha_th_u / max(D_def, 1e-12)

    flame = ct.FreeFlame(gas, width=domain_length_m)
    flame.set_refine_criteria(ratio=3.0, slope=0.08, curve=0.15)
    flame.transport_model = "mixture-averaged"
    # Initial solve without energy equation for stable start
    flame.energy_enabled = False
    try:
        flame.solve(loglevel=0, refine_grid=False, auto=True)
    except Exception:
        pass
    flame.energy_enabled = True
    flame.solve(loglevel=0, refine_grid=True, auto=True)

    SL = float(flame.velocity[0])
    T = flame.T
    x = flame.grid
    # flame thickness δ = (T_b - T_u) / max(|dT/dx|) — geometric definition
    dTdx = np.gradient(T, x)
    thickness = float((T.max() - T.min()) / max(abs(dTdx).max(), 1e-9))

    # Zeldovich flame thickness δ_F = α_th / S_L. Used in dimensionless
    # ratios on the regime diagnostics card (l_T/δ_F, Ka). Numerically
    # different from the geometric `thickness` above (typically smaller),
    # but it is the conventional δ_F that appears in Borghi-Peters
    # diagrams and Karlovitz definitions.
    delta_F = alpha_th_u / max(SL, 1e-9)

    # Markstein number, Bechtold-Matalon simplified form:
    #   Ze = E_a / R · (T_b − T_u) / T_b²    (Zeldovich number)
    #   Ma ≈ (Ze / 2) · (Le_eff − 1)
    # Sign convention: Ma > 0 = thermo-diffusively stable; Ma < 0 = unstable.
    T_u = float(T_mixed)
    T_b = float(T.max())
    EaR = 15000.0  # K — generic hydrocarbon E_a/R placeholder; per-fuel fit deferred to Phase 4
    Ze  = EaR * max(T_b - T_u, 1.0) / max(T_b * T_b, 1.0)
    Ma  = 0.5 * Ze * (Le_eff - 1.0)

    # Downsample profile to <=200 points for the frontend
    n = len(x)
    step = max(1, n // 200)
    x_out = x[::step].tolist()
    T_out = T[::step].tolist()

    return {
        "SL": SL,
        "flame_thickness": thickness,
        "T_max": float(T.max()),
        "T_mixed_inlet_K": float(T_mixed),
        # Unburned-mixture transport bundle (used by regime diagnostics)
        "alpha_th_u": float(alpha_th_u),
        "nu_u":       float(nu_u),
        "delta_F":    float(delta_F),
        "Le_eff":     float(Le_eff),
        "Ma":         float(Ma),
        "Ze":         float(Ze),
        "T_profile": T_out,
        "x_profile": x_out,
        "grid_points": int(n),
    }
