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
    # Optional secondary equilibration at a target product temperature (e.g. T4
    # from the cycle). When provided, the response also includes
    # `mole_fractions_at_T_products` re-equilibrated at fixed (T,P).
    T_products_K: Optional[float] = Field(
        default=None, gt=0, description="Target product T (K) for secondary equilibrium (e.g. T4)"
    )


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
    T_products_K: Optional[float] = None
    mole_fractions_at_T_products: Dict[str, float] = Field(default_factory=dict)
    # Complete-combustion companion — same inlet, no dissociation (all C→CO2,
    # all H→H2O; rich cases shift to CO/H2). Shown alongside the equilibrium
    # T_ad because complete combustion is the correct assumption for diluted
    # combustor-exit and stack measurements where the gas has cooled below
    # the dissociation regime.
    T_ad_complete: float = 0.0
    mole_fractions_complete: Dict[str, float] = Field(default_factory=dict)
    mole_fractions_complete_dry: Dict[str, float] = Field(default_factory=dict)


class FlameSpeedRequest(BaseCalcRequest):
    domain_length_m: float = Field(default=0.03, gt=0)
    T_fuel_K: Optional[float] = Field(default=None, gt=0, description="Fuel inlet T in K")
    T_air_K: Optional[float] = Field(default=None, gt=0, description="Air inlet T in K")
    # When True, response omits the T_profile and x_profile arrays — they're
    # ~30 KB each and the automation runner never reads them. Cuts wire
    # payload ~80% for a single flame call.
    lean: bool = Field(default=False, description="Skip profile arrays in response")


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
    # When True, response replaces the per-point profile array with [].
    # The automation runner doesn't read it; saves ~30 KB per call.
    lean: bool = Field(default=False, description="Skip profile array in response")


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
    # Reference adiabatic flame temperatures for the same inlet (shown on the
    # Combustor panel alongside T_psr to bound the kinetic answer). Equilibrium
    # uses full-Gibbs Cantera; Complete Combustion assumes no dissociation.
    T_ad_equilibrium: float = 0.0
    T_ad_complete: float = 0.0
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


class ExhaustCompleteCombustion(BaseModel):
    """Parallel inversion under the complete-combustion assumption."""
    phi: float = 0.0
    FAR: float = 0.0
    AFR: float = 0.0
    T_ad: float = 0.0
    T_mixed_inlet_K: float = 0.0
    exhaust_composition_wet: Dict[str, float] = Field(default_factory=dict)
    exhaust_composition_dry: Dict[str, float] = Field(default_factory=dict)
    O2_pct_dry: float = 0.0
    CO2_pct_dry: float = 0.0
    CO_pct_dry: float = 0.0
    H2O_pct_wet: float = 0.0


class ExhaustResponse(BaseModel):
    # Equilibrium (Cantera HP) inversion — the primary block
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
    # Parallel complete-combustion inversion — the physically correct
    # assumption for stack or diluted combustor-exit measurements.
    complete_combustion: ExhaustCompleteCombustion = Field(default_factory=ExhaustCompleteCombustion)


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
    # Water injection (mirrors AFT/Flame-Speed/Exhaust). When > 0 the cycle
    # switches to the controller path: phi4 rises to hold T4 at the firing-temp
    # setpoint despite water cooling, and T_Bulk uses the 3-stream enthalpy mix.
    # Default 0 ⇒ dry deck path is preserved exactly (OEM efficiency anchor).
    WFR: float = Field(default=0.0, ge=0.0, le=2.0, description="Water-to-fuel mass ratio")
    water_mode: str = Field(
        default="liquid",
        pattern="^(liquid|steam)$",
        description="Water injection phase: 'liquid' (absorbs h_fg) or 'steam'",
    )
    T_water_K: Optional[float] = Field(
        default=None,
        gt=250.0,
        lt=900.0,
        description=(
            "Water inlet temperature (K). Defaults to 288.15 K for liquid "
            "and T_air for steam. User-overridable for superheated steam or "
            "chilled water injection cases."
        ),
    )
    bleed_air_frac: float = Field(
        default=0.0,
        ge=0.0,
        le=0.50,
        description=(
            "Compressor-discharge bleed fraction dumped to ambient "
            "(= bleed_open × bleed_valve_size). Reduces air to combustor + "
            "turbine; T4 elevates iteratively to hold gross power."
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
    # Water injection (mass passing through the turbine when WFR > 0)
    mdot_water_kg_s: float = 0.0
    water_fuel_bump_factor: float = 1.0
    water_MW_delta: float = 0.0
    T4_dry_deck_K: float = 0.0
    T_water_K: float = 288.15
    # Bleed (compressor-discharge bleed dumped to ambient)
    bleed_air_frac: float = 0.0
    mdot_bleed_kg_s: float = 0.0
    mdot_air_post_bleed_kg_s: float = 0.0
    bleed_iters: int = 0
    bleed_converged: bool = True
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
    # Water injection echo (0 ⇒ dry deck path preserved)
    WFR: float = 0.0
    water_mode: str = "liquid"
    # Humid-air composition (reference)
    oxidizer_humid_mol_pct: Dict[str, float]


# ---------- batch endpoint (multi-job per HTTP call) ---------
class BatchJobRequest(BaseModel):
    """One job in a batch. `kind` selects the solver; `args` is the payload
    that would normally go to /calc/<kind>. Per-job errors are caught and
    surfaced in BatchJobResult.error without failing the whole batch."""

    kind: str = Field(
        pattern="^(aft|flame_speed|combustor|combustor_mapping|exhaust|cycle|autoignition|props|solve_phi_tflame)$",
        description="Solver kind — same names used by the dedicated routes.",
    )
    args: Dict[str, Any] = Field(description="Request body for that solver")


class BatchRequest(BaseModel):
    """Run a list of solver jobs in one HTTP request. Saves ~200 ms × N
    of round-trip overhead for a matrix run that would otherwise fire N
    separate /calc/<kind> calls."""

    jobs: List[BatchJobRequest] = Field(min_length=1, max_length=200, description="Up to 200 jobs per request")


class BatchJobResult(BaseModel):
    ok: bool
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class BatchResponse(BaseModel):
    results: List[BatchJobResult]


# ---------- solve-phi-for-tflame (Cantera bisection back-solver) ---------
class SolvePhiForTflameRequest(BaseModel):
    """Find the lean φ that produces a target T_flame under complete
    combustion (no dissociation), at the 3-stream adiabatically mixed
    inlet T. Bisection runs server-side via Cantera so the answer
    matches everything else the user sees in Accurate Mode (sidebar
    T_flame, Combustor PSR-PFR panel "T_AD — Complete Combustion",
    Operations Summary, etc.).

    Lean side only: T_flame_complete(φ) is non-monotonic — peaks near
    φ ≈ 1, drops on rich side. This solver always returns the unique
    LEAN solution. If the target is above the achievable peak it
    saturates at φ_max; below the lean floor it saturates at φ_min.
    """

    fuel: Dict[str, float] = Field(description="Fuel mole %")
    oxidizer: Dict[str, float] = Field(description="Oxidizer mole %")
    T_flame_target_K: float = Field(gt=0, description="Target adiabatic flame T (K), complete combustion")
    T_fuel_K: float = Field(gt=0, description="Fuel inlet T (K)")
    T_air_K: float = Field(gt=0, description="Air inlet T (K)")
    P_bar: float = Field(gt=0, description="Combustor pressure (bar)")
    WFR: float = Field(default=0.0, ge=0.0, le=2.0)
    water_mode: str = Field(default="liquid", pattern="^(liquid|steam)$")
    T_water_K: Optional[float] = Field(default=None, gt=0)
    phi_min: float = Field(default=0.05, gt=0, le=1.0, description="Lower bound for bisection")
    phi_max: float = Field(default=1.0, gt=0, le=2.0, description="Upper bound (>1 will not be searched — lean only)")
    tol: float = Field(default=1e-4, gt=0, description="Absolute φ convergence tolerance")


class SolvePhiForTflameResponse(BaseModel):
    """Result of the back-solve. `phi` is the canonical answer; the rest
    are diagnostics so the UI can warn the user when the target was
    outside the achievable range."""

    phi: float
    T_flame_actual_K: float = Field(description="T_flame computed at the returned φ (should match target unless saturated)")
    T_flame_target_K: float
    T_at_phi_min_K: float = Field(description="T_flame at φ_min — minimum achievable")
    T_at_phi_max_K: float = Field(description="T_flame at φ_max — peak (lean side maximum)")
    iterations: int = Field(description="Bisection iterations taken")
    converged: bool = True
    saturated: str = Field(default="", description='"low" if target ≤ floor, "high" if target ≥ peak, "" otherwise')


# ---------- combustor mapping (LMS100 DLE 4-circuit correlation model) ------
class CombustorMappingRequest(BaseModel):
    """Request for the 4-circuit correlation-based combustor mapping.

    Computes per-circuit T_AFT via complete combustion, DT_Main, and
    emissions + dynamics (NOx15, CO15, PX36_SEL, PX36_SEL_HI) from an
    anchored linear model with a Phi_OP multiplier (HI only) and a P3
    power-law scaling for part load. No reactor-network kinetics.
    """
    fuel: Dict[str, float] = Field(description="Fuel mole%")
    oxidizer: Dict[str, float] = Field(description="Humid-air mole% (from cycle)")
    T3_K: float = Field(gt=0, description="Compressor exit T (combustor inlet)")
    P3_bar: float = Field(gt=0, description="Combustor pressure")
    T_fuel_K: float = Field(gt=0, description="Fuel inlet T")
    W3_kg_s: float = Field(gt=0, description="Compressor-discharge (post-bleed) flow")
    W36_over_W3: float = Field(gt=0, le=1.0, description="Fraction of W3 entering combustor dome")
    com_air_frac: float = Field(
        gt=0, le=1.0,
        description="Fraction of W36 in flame zone. Balance is effusion cooling that rejoins at mix.",
    )
    # Circuit air fractions (% of flame air) — IP/OP/IM/OM should sum to 100.
    frac_IP_pct: float = Field(ge=0, le=100)
    frac_OP_pct: float = Field(ge=0, le=100)
    frac_IM_pct: float = Field(ge=0, le=100)
    frac_OM_pct: float = Field(ge=0, le=100)
    # User-set phi for IP/OP/IM. OM is back-solved from total-fuel mass balance.
    # Upper bound loose enough to accommodate the BRNDMD=2 table's
    # deliberately-rich φ_IP (5.3) and any future rich-pilot configurations.
    phi_IP: float = Field(ge=0, le=20.0)
    phi_OP: float = Field(ge=0, le=20.0)
    phi_IM: float = Field(ge=0, le=20.0)
    m_fuel_total_kg_s: float = Field(gt=0, description="Total combustor fuel (from cycle)")
    # Water injection (distributed ∝ fuel; currently only affects T_AFT solve)
    WFR: float = Field(default=0.0, ge=0.0, le=2.0)
    water_mode: str = Field(default="liquid", pattern="^(liquid|steam)$")
    # Emissions Transfer Function — BRNDMD-dependent post-multipliers on
    # the final NOx15 / CO15 / PX36_SEL correlation result. Default 1.0 (no scaling).
    nox_mult: float  = Field(default=1.0, gt=0.0, le=10.0)
    co_mult: float   = Field(default=1.0, gt=0.0, le=10.0)
    px36_mult: float = Field(default=1.0, gt=0.0, le=10.0)


class CombustorMapCircuit(BaseModel):
    phi: float
    m_air_kg_s: float
    m_fuel_kg_s: float
    T_AFT_complete_K: float


class CombustorMapAirAccounting(BaseModel):
    W3_kg_s: float
    W36_kg_s: float
    flame_air_kg_s: float
    cooling_air_kg_s: float


class CombustorMapDerived(BaseModel):
    DT_Main_F: float
    Tflame_K: float
    Tflame_F: float
    T3_F: float
    P3_psia: float
    C3_effective_pct: float
    N2_pct: float
    phi_OP_mult: float       # 1.0 for ≥0.55, 0.8 for ≤0.45, lerp between
    pressure_ratio: float    # P3 / 638 psia


class CombustorMapCorrelations(BaseModel):
    NOx15: float
    CO15: float
    PX36_SEL: float
    PX36_SEL_HI: float


class CombustorMapReference(BaseModel):
    values: Dict[str, float]
    conditions: Dict[str, float]


class CombustorMappingResponse(BaseModel):
    circuits: Dict[str, CombustorMapCircuit]
    air_accounting: CombustorMapAirAccounting
    phi_OM: float
    FAR_stoich: float
    fuel_residual_kg_s: float
    derived: CombustorMapDerived
    # Final predictions at the user's operating point (after all 3 correction steps)
    correlations: CombustorMapCorrelations
    # After linear corrections + Phi_OP mult (HI only), BEFORE P3 scaling
    correlations_100pct_load: CombustorMapCorrelations
    # After linear corrections only, BEFORE any multipliers or scaling
    correlations_linear: CombustorMapCorrelations
    reference: CombustorMapReference
