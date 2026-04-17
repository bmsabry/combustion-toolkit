"""Accurate Cantera-backed calculation endpoints. Requires FULL subscription."""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..deps import require_full_subscription
from ..models import User
from ..schemas import (
    AFTRequest,
    AFTResponse,
    CombustorRequest,
    CombustorResponse,
    ExhaustRequest,
    ExhaustResponse,
    FlameSpeedRequest,
    FlameSpeedResponse,
    PropsRequest,
    PropsResponse,
)
from ..science import aft, combustor, exhaust, flame_speed, props

log = logging.getLogger("calc")
router = APIRouter(prefix="/calc", tags=["calc (accurate Cantera)"])

# Cantera isn't thread-safe; serialize via a single-thread executor.
_solver_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cantera")


def _run_in_pool(fn, *args, **kwargs) -> Any:
    try:
        return _solver_pool.submit(fn, *args, **kwargs).result(timeout=180)
    except Exception as e:
        log.exception("solver error: %s", e)
        raise HTTPException(status_code=500, detail=f"solver error: {e}") from e


@router.post("/aft", response_model=AFTResponse)
def calc_aft(body: AFTRequest, _: User = Depends(require_full_subscription)) -> AFTResponse:
    result = _run_in_pool(
        aft.run,
        body.fuel,
        body.oxidizer,
        body.phi,
        body.T0,
        body.P,
        body.heat_loss_fraction if body.mode == "heat_loss" else 0.0,
    )
    return AFTResponse(**result)


@router.post("/flame-speed", response_model=FlameSpeedResponse)
def calc_flame_speed(
    body: FlameSpeedRequest, _: User = Depends(require_full_subscription)
) -> FlameSpeedResponse:
    result = _run_in_pool(
        flame_speed.run,
        body.fuel,
        body.oxidizer,
        body.phi,
        body.T0,
        body.P,
        body.domain_length_m,
    )
    return FlameSpeedResponse(**result)


@router.post("/combustor", response_model=CombustorResponse)
def calc_combustor(
    body: CombustorRequest, _: User = Depends(require_full_subscription)
) -> CombustorResponse:
    result = _run_in_pool(
        combustor.run,
        body.fuel,
        body.oxidizer,
        body.phi,
        body.T0,
        body.P,
        body.tau_psr_s,
        body.L_pfr_m,
        body.V_pfr_m_s,
        body.profile_points,
        body.T_fuel_K,
        body.T_air_K,
    )
    return CombustorResponse(**result)


@router.post("/exhaust", response_model=ExhaustResponse)
def calc_exhaust(body: ExhaustRequest, _: User = Depends(require_full_subscription)) -> ExhaustResponse:
    result = _run_in_pool(
        exhaust.run,
        body.fuel,
        body.oxidizer,
        body.T0,
        body.P,
        body.measured_O2_pct_dry,
        body.measured_CO2_pct_dry,
        body.combustion_mode,
    )
    return ExhaustResponse(**result)


@router.post("/props", response_model=PropsResponse)
def calc_props(body: PropsRequest, _: User = Depends(require_full_subscription)) -> PropsResponse:
    result = _run_in_pool(props.run, body.mixture, body.T, body.P)
    return PropsResponse(**result)
