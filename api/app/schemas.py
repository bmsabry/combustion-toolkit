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
    T_profile: List[float]
    x_profile: List[float]
    grid_points: int


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
        pattern="^(gri30)$",
        description="Kinetic mechanism selector (currently only GRI-Mech 3.0).",
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
