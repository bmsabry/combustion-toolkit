"""Pydantic schemas for request/response bodies."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field


# ---------- auth ----------
class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    full_name: Optional[str] = Field(default=None, max_length=255)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class RefreshRequest(BaseModel):
    refresh_token: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    email: str
    full_name: Optional[str]
    is_verified: bool
    created_at: datetime


# ---------- subscription ----------
class SubscriptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    tier: str
    status: str
    current_period_end: Optional[datetime]
    cancel_at_period_end: bool
    has_online_access: bool
    has_download_access: bool


class CheckoutRequest(BaseModel):
    tier: str = Field(pattern="^(download|full)$")


class CheckoutResponse(BaseModel):
    checkout_url: str
    session_id: str


class PortalResponse(BaseModel):
    portal_url: str


# ---------- license keys ----------
class LicenseKeyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    key_prefix: str
    tier: str
    issued_at: datetime
    expires_at: datetime
    activation_count: int
    max_activations: int
    revoked: bool


class LicenseKeyWithValue(LicenseKeyOut):
    key: str  # full key shown only on creation


class LicenseActivateRequest(BaseModel):
    key: str
    device_id: str = Field(min_length=4, max_length=255)


class LicenseActivateResponse(BaseModel):
    valid: bool
    tier: str
    expires_at: datetime
    signed_token: str  # offline validation token for desktop app
    message: Optional[str] = None


# ---------- science: shared inputs ----------
class Composition(BaseModel):
    """Mole-percent composition. Keys are species names (e.g. 'CH4', 'O2')."""

    model_config = ConfigDict(extra="allow")


class BaseCalcRequest(BaseModel):
    fuel: Dict[str, float] = Field(description="Fuel mole% (sums to 100)")
    oxidizer: Dict[str, float] = Field(description="Oxidizer mole% (sums to 100)")
    phi: float = Field(gt=0, le=5.0, description="Equivalence ratio")
    T0: float = Field(gt=0, description="Inlet temperature in K")
    P: float = Field(gt=0, description="Pressure in bar")
    # Water injection (0 = disabled). Liquid vs steam sets whether we subtract
    # the latent heat of vaporization from the water-stream enthalpy.
    WFR: float = Field(default=0.0, ge=0.0, le=2.0, description="Water-to-fuel mass ratio")
    water_mode: str = Field(
        default="liquid",
        pattern="^(liquid|steam)$",
        description="Water injection phase: 'liquid' (absorbs h_fg) or 'steam'",
    )


class AFTRequest(BaseCalcRequest):
    mode: str = Field(default="adiabatic", pattern="^(adiabatic|heat_loss)$")
    heat_loss_fraction: float = Field(default=0.0, ge=0.0, le=0.5)
    # Optional separate fuel / air inlet temperatures. If provided, the two
    # streams are mixed adiabatically before equilibrium.
    T_fuel_K: Optional[float] = Field(default=None, gt=0, description="Fuel inlet T in K")
    T_air_K: Optional[float] = Field(default=None, gt=0, description="Air inlet T in K")


class AFTResponse(BaseModel):
    T_ad: float
    T_actual: float
    T_mixed_inlet_K: float = 0.0  # adiabatic mix T of fuel+air before equilibrium
    mole_fractions: Dict[str, float]
    mass_fractions: Dict[str, float]
    species_kmol_per_kg_mix: Dict[str, float]
    h_reactants: float
    h_products: float
    cp_products: float
    mw_products: float
    FAR_stoich: float
    FAR: float
    AFR_stoich: float
    AFR: float


class FlameSpeedRequest(BaseCalcRequest):
    domain_length_m: float = Field(default=0.03, gt=0)
    T_fuel_K: Optional[float] = Field(default=None, gt=0, description="Fuel inlet T in K")
    T_air_K: Optional[float] = Field(default=None, gt=0, description="Air inlet T in K")


class FlameSpeedResponse(BaseModel):
    SL: float  # m/s
    flame_thickness: float  # m
    T_max: float
    T_mixed_inlet_K: float = 0.0  # adiabatic mix T of fuel+air at flame base
    alpha_th_u: float = 0.0  # thermal diffusivity of unburned mixture (m²/s); used for Lewis–von Elbe g_c = S_L² / α_th
    T_profile: List[float]
    x_profile: List[float]
    grid_points: int


class FlameSpeedSweepRequest(BaseCalcRequest):
    """Cantera-backed sweep of S_L across one of {phi, P, T}.

    Slow: each point is a full 1D FreeFlame solve (~5–15 s). Cap points at 15 so
    the run finishes within the 180 s solver-pool timeout. Used only on explicit
    user button-click from the Flame Speed panel (Accurate mode).
    """

    sweep_var: str = Field(pattern="^(phi|P|T)$", description="Which baseline var to sweep")
    sweep_values: List[float] = Field(min_length=2, max_length=15, description="Values of the swept variable")
    domain_length_m: float = Field(default=0.03, gt=0)
    T_fuel_K: Optional[float] = Field(default=None, gt=0)
    T_air_K: Optional[float] = Field(default=None, gt=0)


class FlameSpeedSweepPoint(BaseModel):
    x: float  # value of the swept variable at this point
    SL: float  # m/s (0.0 if not converged)
    T_mixed_inlet_K: float = 0.0
    alpha_th_u: float = 0.0
    converged: bool = True
    error: Optional[str] = None


class FlameSpeedSweepResponse(BaseModel):
    sweep_var: str
    points: List[FlameSpeedSweepPoint]


class AutoignitionRequest(BaseCalcRequest):
    """Constant-pressure autoignition delay for the premixed (fuel+air) mixture.

    Used to assess premixer flashback-by-autoignition safety: the residence
    time of unburnt mixture in the premixer should be shorter than this τ_ign.
    """

    max_time_s: float = Field(default=0.5, gt=0, le=10.0, description="Integration cutoff (s)")
    T_fuel_K: Optional[float] = Field(default=None, gt=0, description="Fuel inlet T in K")
    T_air_K: Optional[float] = Field(default=None, gt=0, description="Air inlet T in K")
    mechanism: str = Field(
        default="gri30",
        pattern="^(gri30|glarborg)$",
        description="Kinetic mechanism selector.",
    )


class AutoignitionResponse(BaseModel):
    tau_ign_s: float  # ignition delay time (s); equals max_time_s if no ignition observed
    ignited: bool
    T_mixed_inlet_K: float = 0.0
    T_peak: float
    t_trace: List[float]
    T_trace: List[float]


class CombustorRequest(BaseCalcRequest):
    tau_psr_s: float = Field(gt=0, description="PSR residence time in seconds")
    L_pfr_m: float = Field(gt=0, description="PFR length in meters")
    V_pfr_m_s: float = Field(gt=0, description="PFR velocity in m/s")
    profile_points: int = Field(default=60, ge=5, le=500)
    # Optional separate fuel / air inlet temperatures. If provided, the two
    # streams are mixed adiabatically before entering the PSR. If omitted,
    # both default to T0 (previous single-inlet behavior).
    T_fuel_K: Optional[float] = Field(default=None, gt=0, description="Fuel inlet T in K")
    T_air_K: Optional[float] = Field(default=None, gt=0, description="Air inlet T in K")
    # PSR reactor options. Defaults reproduce pre-existing behavior exactly.
    psr_seed: str = Field(
        default="cold_ignited",
        pattern="^(unreacted|hot_eq|cold_ignited|autoignition)$",
        description="PSR warm-start strategy",
    )
    eq_constraint: str = Field(
        default="HP",
        pattern="^(HP|UV|TP)$",
        description="Equilibrium constraint for hot_eq / cold_ignited seeds",
    )
    integration: str = Field(
        default="chunked",
        pattern="^(steady_state|chunked|step)$",
        description="PSR time-integration strategy",
    )
    heat_loss_fraction: float = Field(
        default=0.0,
        ge=0.0,
        le=0.5,
        description=(
            "PSR heat loss as fraction of sensible heat release. "
            "T_psr is held at T_ad − f·(T_ad − T_in). Typical DLE values: 0.10–0.25."
        ),
    )
    mechanism: str = Field(
        default="gri30",
        pattern="^(gri30|glarborg)$",
        description=(
            "Kinetic mechanism selector. 'gri30' = GRI-Mech 3.0 (53 species, "
            "CH4–C3H8 + NOx). 'glarborg' = Glarborg 2018 (151 species, 1395 "
            "reactions, comprehensive N-chemistry, C1–C2 hydrocarbons; C3+ lumped to C2)."
        ),
    )


class CombustorProfilePoint(BaseModel):
    x: float  # cm
    T: float  # K
    NO_ppm: float
    CO_ppm: float
    conv: float  # %


class CombustorResponse(BaseModel):
    T_psr: float
    T_exit: float
    T_mixed_inlet_K: float = 0.0  # adiabatic mix T of fuel+air at PSR inlet
    NO_ppm_vd_psr: float
    NO_ppm_vd_exit: float
    CO_ppm_vd_psr: float
    CO_ppm_vd_exit: float
    NO_ppm_15O2: float
    CO_ppm_15O2: float
    O2_pct_dry_psr: float = 0.0
    O2_pct_dry_exit: float = 0.0
    conv_psr: float
    conv_exit: float
    tau_psr_ms: float
    tau_pfr_ms: float
    tau_total_ms: float
    L_psr_cm: float
    L_pfr_cm: float
    L_total_cm: float
    psr_seed: Optional[str] = None
    eq_constraint: Optional[str] = None
    integration: Optional[str] = None
    heat_loss_fraction: Optional[float] = None
    T_target_K: Optional[float] = None
    mechanism: Optional[str] = None
    profile: List[CombustorProfilePoint]


class ExhaustRequest(BaseModel):
    fuel: Dict[str, float]
    oxidizer: Dict[str, float]
    T0: float
    P: float
    measured_O2_pct_dry: Optional[float] = None
    measured_CO2_pct_dry: Optional[float] = None
    combustion_mode: str = Field(default="complete", pattern="^(complete|equilibrium)$")
    T_fuel_K: Optional[float] = Field(default=None, gt=0, description="Fuel inlet T in K")
    T_air_K: Optional[float] = Field(default=None, gt=0, description="Air inlet T in K")
    WFR: float = Field(default=0.0, ge=0.0, le=2.0, description="Water-to-fuel mass ratio")
    water_mode: str = Field(
        default="liquid",
        pattern="^(liquid|steam)$",
        description="Water injection phase: 'liquid' (absorbs h_fg) or 'steam'",
    )


class ExhaustResponse(BaseModel):
    phi: float
    FAR: float
    AFR: float
    T_ad: float
    T_mixed_inlet_K: float = 0.0
    exhaust_composition_wet: Dict[str, float]
    exhaust_composition_dry: Dict[str, float]
    O2_pct_dry: float
    CO2_pct_dry: float
    H2O_pct_wet: float
    method: str  # "O2" or "CO2"


class PropsRequest(BaseModel):
    mixture: Dict[str, float]  # mole fractions or percent
    T: float = Field(gt=0)
    P: float = Field(gt=0)


class PropsResponse(BaseModel):
    T: float
    P: float
    mw: float
    density: float
    cp: float
    cv: float
    gamma: float
    viscosity: float
    thermal_conductivity: float
    prandtl: float
    sound_speed: float
    enthalpy: float
    entropy: float
    gibbs: float


class HealthResponse(BaseModel):
    status: str
    cantera_version: str
    env: str
    stripe_configured: bool


# ---------- cycle (gas turbine) ----------
class CycleRequest(BaseModel):
    """Gas turbine thermodynamic-cycle request.

    Ambient conditions + load drive an anchored performance correlation (LM6000PF
    or LMS100PB+). The T4/P3/T3 stations and FAR fall out; the linkage toggles in
    the frontend let the user pipe T3/P3/FAR straight into the other panels.
    """

    engine: str = Field(pattern="^(LM6000PF|LMS100PB\\+)$", description="Engine deck selector")
    P_amb_bar: float = Field(gt=0, description="Ambient pressure, bar")
    T_amb_K: float = Field(gt=0, description="Ambient dry-bulb, K")
    RH_pct: float = Field(ge=0.0, le=100.0, description="Relative humidity, %")
    load_pct: float = Field(ge=20.0, le=100.0, description="Commanded load as % of max-on-this-ambient-day")
    T_cool_in_K: Optional[float] = Field(
        default=None,
        gt=0,
        description="(LMS100 only) intercooler cooling-water supply T in K; defaults to 288 K",
    )
    fuel_pct: Optional[Dict[str, float]] = Field(
        default=None,
        description="Fuel composition in mol % (defaults to US pipeline natural gas)",
    )
    combustor_air_frac: Optional[float] = Field(
        default=None,
        ge=0.30,
        le=1.00,
        description=(
            "Flame-zone fraction of combustor airflow (m_flame / m_comb_air). "
            "The rest is dilution. Does NOT affect efficiency — only sets the "
            "flame-zone state (FAR_Bulk = FAR4/frac, phi_Bulk = phi4/frac, T_Bulk). "
            "Default 0.88 (typical DLE primary-zone fraction)."
        ),
    )
    T_fuel_K: Optional[float] = Field(
        default=None,
        gt=0,
        description=(
            "Fuel delivery temperature in K. Used as denominator in the Modified "
            "Wobbe Index MWI = LHV_vol/√(SG·T_fuel_absolute). Default 288.706 K (60°F)."
        ),
    )


class FuelFlexibility(BaseModel):
    """Modified Wobbe Index analysis and operator warnings (Option B)."""

    lhv_vol_BTU_per_scf: float = 0.0
    sg_air: float = 0.0
    mwi: float = 0.0
    # Classification band: 'in_spec' | 'marginal' | 'out_of_spec'
    mwi_status: str = "in_spec"
    # Performance derate (%): 0 / 5 / 20 for in-spec / marginal / out-of-spec
    mwi_derate_pct: float = 0.0
    h2_frac_pct: float = 0.0
    warnings: List[str] = Field(default_factory=list)


class CycleResponse(BaseModel):
    engine: str
    engine_label: str
    intercooled: bool
    # Ambient
    T_amb_K: float
    P_amb_bar: float
    RH_pct: float
    rho_amb_kg_m3: float
    rho_ratio: float
    # Load
    load_pct: float
    MW_max_ambient: float
    MW_net: float
    # Option A — energy-balance decomposition (all in MW)
    MW_gross: float = 0.0          # W_turb − W_comp − W_parasitic (physics)
    MW_cap: float = 0.0            # MW_design × (ρ/ρ_des)^β × load (nameplate)
    MW_uncapped_before_derate: float = 0.0  # min(MW_gross, MW_cap), before fuel-flex derate
    W_turbine_MW: float = 0.0
    W_compressor_MW: float = 0.0
    W_parasitic_MW: float = 0.0
    derate_factor: float = 1.0     # (1 − mwi_derate_pct/100)
    eta_isen_turb: float = 0.0
    eta_isen_comp: float = 0.0
    combustor_bypass_frac: float = 1.0
    T5_K: float = 0.0              # actual turbine exit T
    T5_isen_K: float = 0.0         # isentropic (ideal) turbine exit T
    P_exhaust_bar: float = 1.05
    T_fuel_K: float = 288.706
    # Stations
    T1_K: float
    P1_bar: float
    T2_K: float
    P2_bar: float
    T2_5_K: float = 0.0
    P2_5_bar: float = 0.0
    T3_K: float
    P3_bar: float
    T4_K: float
    intercooler_duty_MW: float = 0.0
    # Flows
    mdot_air_kg_s: float
    mdot_air_combustor_kg_s: float = 0.0
    mdot_fuel_kg_s: float
    # Combustor-EXIT values (after dilution): back-solved so equilibrium
    # product T at (T3, P3) matches the commanded T4.
    FAR4: float = 0.0
    phi4: float = 0.0
    # Flame-zone (BULK) values: same T3/P3/fuel/ox, air split by
    # combustor_air_frac. FAR_Bulk = FAR4 / frac, phi_Bulk = phi4 / frac,
    # T_Bulk = HP-equilibrium product at (T3, P3, phi_Bulk). These drive
    # Flame Temp / Flame Speed / PSR-PFR / Blowoff / Exhaust (the flame).
    FAR_Bulk: float = 0.0
    phi_Bulk: float = 0.0
    T_Bulk_K: float = 0.0
    phi: float             # legacy alias for phi_Bulk (sidebar-linked)
    combustor_air_frac: float = 0.88
    # Performance
    efficiency_LHV: float
    heat_rate_kJ_per_kWh: float
    LHV_fuel_MJ_per_kg: float
    # Option B — fuel-flexibility analysis
    fuel_flexibility: FuelFlexibility = Field(default_factory=FuelFlexibility)
    # Humid-air composition (reference)
    oxidizer_humid_mol_pct: Dict[str, float]
