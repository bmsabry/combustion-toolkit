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
    AutoignitionRequest,
    AutoignitionResponse,
    CombustorRequest,
    CombustorResponse,
    CycleRequest,
    CycleResponse,
    ExhaustRequest,
    ExhaustResponse,
    FlameSpeedRequest,
    FlameSpeedResponse,
    FlameSpeedSweepRequest,
    FlameSpeedSweepResponse,
    PropsRequest,
    PropsResponse,
)
from ..science import aft, autoignition, combustor, cycle, exhaust, flame_speed, flame_speed_sweep, props

log = logging.getLogger("calc")
router = APIRouter(prefix="/calc", tags=["calc (accurate Cantera)"])

# Cantera isn't thread-safe; serialize via a single-thread executor.
_solver_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cantera")


def _run_in_pool(fn, *args, **kwargs) -> Any:
    try:
        return _solver_pool.submit(fn, *args, **kwargs).result(timeout=180)
    except Exception as e:
        # Log the full exception server-side but return a generic message to clients
        # to avoid leaking mechanism/species internals or stack traces.
        log.exception("solver error in %s: %s", fn.__name__, e)
        raise HTTPException(
            status_code=500,
            detail="Solver failed to converge on the submitted inputs. Check fuel composition, phi, and T/P, then retry.",
        ) from e


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
        body.T_fuel_K,
        body.T_air_K,
        body.WFR,
        body.water_mode,
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
        body.T_fuel_K,
        body.T_air_K,
        body.WFR,
        body.water_mode,
    )
    return FlameSpeedResponse(**result)


@router.post("/flame-speed-sweep", response_model=FlameSpeedSweepResponse)
def calc_flame_speed_sweep(
    body: FlameSpeedSweepRequest, _: User = Depends(require_full_subscription)
) -> FlameSpeedSweepResponse:
    """Run a Cantera FreeFlame at each point in sweep_values.

    Per-point FreeFlame cost in production is ~15–30 s depending on how close
    the point sits to a flammability limit. A 10-point sweep can breach 300 s
    when extremes fight convergence, so we widen the pool timeout to 540 s —
    below Render's 600 s HTTP ceiling on Standard, leaving headroom. The
    single-point endpoints keep the tighter 180 s ceiling.
    """
    try:
        result = _solver_pool.submit(
            flame_speed_sweep.run,
            body.sweep_var,
            list(body.sweep_values),
            body.fuel,
            body.oxidizer,
            body.phi,
            body.T0,
            body.P,
            body.T_fuel_K,
            body.T_air_K,
            body.domain_length_m,
            body.WFR,
            body.water_mode,
        ).result(timeout=540)
    except Exception as e:
        log.exception("flame-speed-sweep error: %s", e)
        raise HTTPException(
            status_code=500,
            detail="Flame-speed sweep failed. One or more points may be outside the flammability limits; narrow the range and retry.",
        ) from e
    return FlameSpeedSweepResponse(**result)


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
        body.psr_seed,
        body.eq_constraint,
        body.integration,
        body.heat_loss_fraction,
        body.mechanism,
        body.WFR,
        body.water_mode,
    )
    result["mechanism"] = body.mechanism
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
        body.T_fuel_K,
        body.T_air_K,
        body.WFR,
        body.water_mode,
    )
    return ExhaustResponse(**result)


@router.post("/props", response_model=PropsResponse)
def calc_props(body: PropsRequest, _: User = Depends(require_full_subscription)) -> PropsResponse:
    result = _run_in_pool(props.run, body.mixture, body.T, body.P)
    return PropsResponse(**result)


@router.post("/cycle", response_model=CycleResponse)
def calc_cycle(body: CycleRequest, _: User = Depends(require_full_subscription)) -> CycleResponse:
    result = _run_in_pool(
        cycle.run,
        body.engine,
        body.P_amb_bar,
        body.T_amb_K,
        body.RH_pct,
        body.load_pct,
        body.T_cool_in_K,
        body.fuel_pct,
        body.combustor_air_frac,
        body.T_fuel_K,
    )
    return CycleResponse(**result)


@router.post("/autoignition", response_model=AutoignitionResponse)
def calc_autoignition(
    body: AutoignitionRequest, _: User = Depends(require_full_subscription)
) -> AutoignitionResponse:
    result = _run_in_pool(
        autoignition.run,
        body.fuel,
        body.oxidizer,
        body.phi,
        body.T0,
        body.P,
        body.max_time_s,
        body.T_fuel_K,
        body.T_air_K,
        body.mechanism,
        body.WFR,
        body.water_mode,
    )
    return AutoignitionResponse(**result)
