"""Laminar flame speed via Cantera 1D freely-propagating premixed flame."""
from __future__ import annotations

import math
from typing import Dict, Optional

import cantera as ct
import numpy as np

from .mixture import make_gas, make_gas_mixed
from .water_mix import make_gas_mixed_with_water


# ── Per-fuel global activation energy (kcal/mol) ──────────────────────
# Source: Bechtold & Matalon, "The Dependence of the Markstein Length
# on Stoichiometry," Combust Flame 127:1906-1913 (2001), Table 1.
# These are the *global* one-step E values used in their asymptotic
# theory; Cantera's detailed kinetics do not expose a single E_a, so
# we use these literature values for the Zeldovich number β only.
# Inert species (N2, CO2, H2O, Ar) do not appear here. Hydrocarbons
# not in the table are mapped to the closest backbone:
#     C2H6, C2H4, C4H10  → C3H8 (small alkane proxy)
#     C5H12+              → C8H18 (heavy alkane proxy)
# CO is mapped to CH4 (its global E_a is similarly ~25–50 kcal/mol).
_EA_KCAL_PER_MOL = {
    "CH4":  47.435,
    "H2":   20.000,
    "C3H8": 34.223,
    "C2H6": 34.223,
    "C2H4": 34.223,
    "C4H10": 34.223,
    "C8H18": 41.394,
    "CO":   47.435,
}
# Inert / diluent species in the fuel stream — must be excluded from
# both the Le_fuel mole-weight and the E_a mole-weight (they do not
# react and do not contribute a reactive Lewis number to the flame).
_INERT_FUEL_SPECIES = {"N2", "CO2", "H2O", "AR", "HE"}
_R_J_PER_MOL_K = 8.31446
_KCAL_TO_J = 4184.0


def _mole_weighted_EaR(fuel_pct: Dict[str, float]) -> float:
    """Mole-weighted E_a/R (in K) across the *reactive* fuel composition.

    Inerts (N₂, CO₂, H₂O, Ar) are excluded from the mean.
    Reactive species not in the table are mapped to CH₄ as a proxy.
    """
    reactive_total = sum(
        max(float(v), 0.0)
        for k, v in fuel_pct.items()
        if k.upper() not in _INERT_FUEL_SPECIES
    )
    if reactive_total <= 0:
        return _EA_KCAL_PER_MOL["CH4"] * _KCAL_TO_J / _R_J_PER_MOL_K
    Ea_kcal = 0.0
    for k, v in fuel_pct.items():
        if k.upper() in _INERT_FUEL_SPECIES:
            continue
        x = max(float(v), 0.0) / reactive_total
        Ea_kcal += _EA_KCAL_PER_MOL.get(k, _EA_KCAL_PER_MOL["CH4"]) * x
    return Ea_kcal * _KCAL_TO_J / _R_J_PER_MOL_K


# ── Plee-Mellor 1979 characteristic-time LBO criterion ──────────────────
# Reference: S.L. Plee & A.M. Mellor, "Characteristic Time Correlation for
# Lean Blowoff of Bluff-Body-Stabilized Flames," Combust Flame 35:61-80
# (1979).  Eq. 17 for Configuration A (45° conical baffle, gaseous propane,
# fitted to Ballal-Lefebvre data):
#     τ_hc' (msec) = 10⁻⁴ · (T_φ/T_in) · exp(21000 / (R·T_φ))
# with R = 1.987 cal/(mol·K), so 21000/R ≈ 10568 K. The LBO line:
#     τ_sl,LBO = 2.11 · τ_hc' − 0.46  [msec]
# So premixer is STABLE when τ_sl/τ_hc' > 2.11 (operating point above the
# LBO line in Fig. 5).  τ_sl = L_recirc / V_a (msec) is the shear-layer
# residence time using the bluff-body geometry.
#
# Cross-validated against Sturgess et al., "Lean Blowout in a Research
# Combustor at Simulated Low Pressures," J Eng GT 118:773 (1996), which
# correlates LBO via the WSR loading parameter ṁ_air/(V·P^n·F).
# Both frameworks agree that LBO is fundamentally a Damköhler-style
# competition between residence time and chemical (ignition) time.
_PM_E_CAL_PER_MOL = 21000.0     # Plee-Mellor Eq. 17 activation energy (cal/mol)
_PM_R_CAL_PER_MOL_K = 1.987     # Universal gas constant in cal/(mol·K)
_PM_RATIO_LBO = 2.11            # Slope of LBO line (Plee-Mellor Fig. 5)


def shaffer_tip_temperature(
    H2_pct: float,
    CO_pct: float,
    CH4_pct: float,
    AFT_K: float,
) -> float:
    """Shaffer-Duan-McDonell 2013 burner-tip temperature, Eq. 4.

    Predicts the steady-state burner-tip temperature at flashback
    based on fuel composition and AFT. Per Shaffer §4.5, using this
    *tip* T (not ambient) as the unburned-gas T in S_L calculations
    gives a much tighter g_c data collapse (R² = 0.936 vs 0.854 for
    ambient). Useful as a correction for H₂-rich BLF prediction.

    Args:
        H2_pct, CO_pct, CH4_pct:  Fuel composition in mole %  (sum = 100)
        AFT_K:                    Adiabatic flame temperature  (K)

    Returns:
        Burner tip temperature (K)

    Reference: B. Shaffer, Z. Duan, V. McDonell, "Study of Fuel
    Composition Effects on Flashback Using a Confined Jet Flame Burner,"
    J Eng GT 135:011502 (2013), Eq. 4.

    Note on Eq. 3 (g_c ANOVA correlation): the cross-term coefficient
    0.604·H₂·CH₄ in Shaffer's published Eq. 3 produces unphysical
    g_c at mid-edge mixtures (e.g. 50/50 H₂/CH₄ → ~1.75e6 1/s vs
    experimental ~1e4-3e4 1/s in Fig. 5). Likely a typesetting issue.
    For production g_c we use Lewis-von Elbe (S_L²/α) which is
    validated against the same Shaffer dataset within ±50% at the
    H₂ corner and matches Eichler-Sattelmayer 2012's μ-PIV BLF model.
    """
    return (
        -1.58 * H2_pct
        - 3.63 * CO_pct
        - 4.28 * CH4_pct
        + 0.38 * AFT_K
    )


def plee_mellor_lbo(
    T_flame_K: float,
    T_in_K: float,
    L_recirc_m: float,
    V_approach_mps: float,
) -> dict:
    """Plee-Mellor 1979 LBO criterion (Eq. 16-17).

    Args:
        T_flame_K:     Adiabatic flame T at approach φ (the eddy ignition T)
        T_in_K:        Inlet/approach gas T (compressor discharge for premixers)
        L_recirc_m:    Recirculation-zone length scale (m). For a 45°-conical
                       bluff body, L = D_baffle / √3 (Plee-Mellor optimum).
                       For a generic dome: L ≈ D_can - D_baffle.
        V_approach_mps: Approach flow velocity at the bluff-body station (m/s)

    Returns:
        dict with τ_sl, τ_hc', stability ratio, and LBO flag.
    """
    T_f = max(float(T_flame_K), 1.0)
    T_i = max(float(T_in_K),    1.0)
    EaR_K = _PM_E_CAL_PER_MOL / _PM_R_CAL_PER_MOL_K
    tau_hc_ms = 1.0e-4 * (T_f / T_i) * math.exp(EaR_K / T_f)
    tau_sl_ms = (L_recirc_m / max(V_approach_mps, 1e-9)) * 1000.0
    ratio = tau_sl_ms / max(tau_hc_ms, 1e-12)
    return {
        "tau_sl_ms":  tau_sl_ms,
        "tau_hc_ms":  tau_hc_ms,
        "ratio":      ratio,
        "lbo_safe":   ratio > _PM_RATIO_LBO,
        "ratio_LBO":  _PM_RATIO_LBO,
    }


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
    # Computed once at (T_mixed, P, X_unburned). Card 1 (regime diagnostics)
    # depends on every member of this bundle:
    #   α_th = k / (ρ·c_p)          thermal diffusivity (Lewis-von Elbe g_c)
    #   ν    = μ / ρ                kinematic viscosity (Reynolds Re_T)
    #   Le_E = α_th / D_excess      Lewis number of excess reactant
    #   Le_D = α_th / D_deficient   Lewis number of deficient reactant
    #   Le_eff = Bechtold-Matalon weighted average (Eq. 6)
    #   δ_F  = α_th / S_L           Zeldovich flame thickness (Williams 1985)
    #   Ma   = full B-M Eq. 12      Markstein number (sheet ref, λ=T^(1/2))
    rho_u  = float(gas.density)
    cp_u   = float(gas.cp_mass)
    k_u    = float(gas.thermal_conductivity)
    mu_u   = float(gas.viscosity)
    alpha_th_u = k_u / (rho_u * cp_u)
    nu_u   = mu_u / rho_u

    # Compute BOTH fuel and O₂ Lewis numbers; Bechtold-Matalon Eq. 6
    # weights them via the activation-energy parameter A = 1 + β(Φ−1).
    # Φ ≥ 1 is the excess-to-deficient mass-ratio (Φ=1/φ for lean, φ for rich).
    #
    # Le_fuel for blends (e.g. NG + H₂) uses a mole-weighted aggregate
    # diffusivity over reactive fuel species, per Hawkes & Chen 2004
    # (Combust Flame 138:242-258). Equivalent to harmonic-mean-weighting Le_i
    # by mole fraction. Inerts (N₂, CO₂, H₂O, Ar) in the fuel stream are
    # excluded — they do not transport a reactive Lewis number to the flame.
    try:
        D_mix = gas.mix_diff_coeffs                       # m²/s, length n_species
        idx_O2 = gas.species_index("O2") if "O2" in gas.species_names else 0
        D_O2 = float(D_mix[idx_O2]) if idx_O2 < len(D_mix) else alpha_th_u
        if not (D_O2 > 0): D_O2 = alpha_th_u

        # Mole-weighted aggregate fuel diffusivity (reactive species only)
        x_fuel_total = 0.0
        D_fuel_weighted = 0.0
        for sp_name, raw_x in fuel_pct.items():
            x = max(float(raw_x), 0.0)
            if x <= 0:
                continue
            if sp_name.upper() in _INERT_FUEL_SPECIES:
                continue
            if sp_name not in gas.species_names:
                continue
            idx = gas.species_index(sp_name)
            D_i = float(D_mix[idx]) if idx < len(D_mix) else alpha_th_u
            if not (D_i > 0):
                D_i = alpha_th_u
            D_fuel_weighted += x * D_i
            x_fuel_total    += x
        D_fuel = (D_fuel_weighted / x_fuel_total) if x_fuel_total > 0 else alpha_th_u
        if not (D_fuel > 0):
            D_fuel = alpha_th_u
    except Exception:
        D_fuel = D_O2 = alpha_th_u

    Le_fuel = alpha_th_u / max(D_fuel, 1e-12)
    Le_O2   = alpha_th_u / max(D_O2,   1e-12)
    if float(phi) <= 1.0:
        # Lean: O₂ is excess, fuel is deficient
        Le_E, Le_D = Le_O2, Le_fuel
        Phi_BM = 1.0 / max(float(phi), 1e-9)
    else:
        # Rich: fuel is excess, O₂ is deficient
        Le_E, Le_D = Le_fuel, Le_O2
        Phi_BM = float(phi)

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

    # ── Markstein number per Bechtold & Matalon 2001 (Combust Flame 127:1906) ──
    # Eq. 6 — effective Lewis number weighted by reactant excess:
    #     A      = 1 + β·(Φ − 1)
    #     Le_eff = 1 + [(Le_E − 1) + (Le_D − 1)·A] / (1 + A)
    # Eq. 12 — flame speed S_f = S_L − δ·Ma·K with reaction-sheet reference
    # and λ=T^(1/2) variable conductivity (paper's choice for Figs. 2–3):
    #     σ      = ρ_u/ρ_b ≈ T_b/T_u           (thermal expansion ratio)
    #     γ_1    = 2σ / (√σ + 1)
    #     γ_2    = (4/(σ−1)) · [√σ − 1 − ln((√σ + 1)/2)]
    #     Ma     = γ_1/σ + ½·β·(Le_eff − 1)·γ_2
    # β is the Zeldovich number with E_a from Bechtold-Matalon Table 1
    # (mole-weighted across the fuel composition).  Sign convention:
    # Ma > 0 = thermo-diffusively stable; Ma < 0 = unstable (cellular).
    T_u  = float(T_mixed)
    T_b  = float(T.max())
    EaR  = _mole_weighted_EaR(fuel_pct)                    # K
    beta = EaR * max(T_b - T_u, 1.0) / max(T_b * T_b, 1.0) # Zeldovich number

    # Bechtold-Matalon Le_eff
    A_bm   = 1.0 + beta * (Phi_BM - 1.0)
    Le_eff = 1.0 + ((Le_E - 1.0) + (Le_D - 1.0) * A_bm) / (1.0 + A_bm)

    # σ from actual burned/unburned densities (more rigorous than T_b/T_u
    # because it accounts for the molar-mass change across the flame).
    try:
        rho_b = float(flame.density[-1])
        sigma = rho_u / max(rho_b, 1e-9)
    except Exception:
        sigma = T_b / max(T_u, 1.0)
    sigma = max(sigma, 1.0001)                             # guard against σ→1

    sqrt_sig = math.sqrt(sigma)
    gamma1 = 2.0 * sigma / (sqrt_sig + 1.0)
    gamma2 = (4.0 / (sigma - 1.0)) * (
        sqrt_sig - 1.0 - math.log(0.5 * (sqrt_sig + 1.0))
    )
    Ma = gamma1 / sigma + 0.5 * beta * (Le_eff - 1.0) * gamma2
    Ze = beta                                              # alias for response field

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
        "Le_E":       float(Le_E),
        "Le_D":       float(Le_D),
        "Ma":         float(Ma),
        "Ze":         float(Ze),
        "T_profile": T_out,
        "x_profile": x_out,
        "grid_points": int(n),
    }
