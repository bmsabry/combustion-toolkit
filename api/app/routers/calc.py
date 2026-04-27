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
    CombustorMappingRequest,
    CombustorMappingResponse,
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
    SolvePhiForTflameRequest,
    SolvePhiForTflameResponse,
)
from ..science import (
    aft,
    autoignition,
    combustor,
    combustor_mapping,
    complete_combustion,
    cycle,
    exhaust,
    flame_speed,
    flame_speed_sweep,
    props,
)

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
        body.T_products_K,
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


@router.post("/combustor_mapping", response_model=CombustorMappingResponse)
def calc_combustor_mapping(
    body: CombustorMappingRequest, _: User = Depends(require_full_subscription)
) -> CombustorMappingResponse:
    """LMS100 DLE 4-circuit correlation model: T_AFT per circuit +
    anchored-linear emissions/dynamics prediction with Phi_OP multiplier
    (HI only) + P3 power-law scaling for part load. No kinetic solver."""
    result = _run_in_pool(
        combustor_mapping.run,
        body.fuel,
        body.oxidizer,
        body.T3_K,
        body.P3_bar,
        body.T_fuel_K,
        body.W3_kg_s,
        body.W36_over_W3,
        body.com_air_frac,
        body.frac_IP_pct,
        body.frac_OP_pct,
        body.frac_IM_pct,
        body.frac_OM_pct,
        body.phi_IP,
        body.phi_OP,
        body.phi_IM,
        body.m_fuel_total_kg_s,
        body.WFR,
        body.water_mode,
        body.nox_mult,
        body.co_mult,
        body.px36_mult,
    )
    return CombustorMappingResponse(**result)


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
        body.WFR,
        body.water_mode,
        body.T_water_K,
        body.bleed_air_frac,
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


# ───────────────────────────────────────────────────────────────────────
#  /calc/solve-phi-for-tflame
#  Bisect on phi (lean side only) to find the equivalence ratio that
#  produces a target adiabatic flame temperature under complete
#  combustion. Each inner evaluation calls the same complete_combustion
#  solver the AFT/Combustor panels use, so the answer is consistent
#  with everything else the user sees in Accurate Mode. Bisection runs
#  inside the single-thread Cantera pool.
# ───────────────────────────────────────────────────────────────────────
def _solve_phi_for_tflame_impl(
    fuel,
    oxidizer,
    T_target,
    T_fuel,
    T_air,
    P_bar,
    WFR,
    water_mode,
    T_water_K,
    phi_min,
    phi_max,
    tol,
):
    def tflame_at(phi: float) -> float:
        r = complete_combustion.run(
            fuel, oxidizer, float(phi), float(T_fuel), float(T_air), float(P_bar),
            WFR=float(WFR), water_mode=water_mode, T_water_K=T_water_K,
        )
        # complete_combustion.run returns a dict whose primary T field is
        # `T_ad` (matches AFTResponse.T_ad_complete shape).
        return float(r.get("T_ad", 0.0))

    # Lean-only search: phi(peak) is near 1.0, so cap hi at min(phi_max, 1.0).
    lo = float(phi_min)
    hi = min(float(phi_max), 1.0)
    T_lo = tflame_at(lo)
    T_hi = tflame_at(hi)

    # Saturation: target outside the achievable lean range.
    if T_target <= T_lo:
        return {
            "phi": lo, "T_flame_actual_K": T_lo,
            "T_flame_target_K": T_target,
            "T_at_phi_min_K": T_lo, "T_at_phi_max_K": T_hi,
            "iterations": 1, "converged": True, "saturated": "low",
        }
    if T_target >= T_hi:
        return {
            "phi": hi, "T_flame_actual_K": T_hi,
            "T_flame_target_K": T_target,
            "T_at_phi_min_K": T_lo, "T_at_phi_max_K": T_hi,
            "iterations": 1, "converged": True, "saturated": "high",
        }

    # Bisect — T_flame is monotonic-increasing on the lean side.
    iters = 0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        T_mid = tflame_at(mid)
        iters += 1
        if T_mid < T_target:
            lo = mid
        else:
            hi = mid
        if hi - lo < tol:
            break
    phi_solved = 0.5 * (lo + hi)
    T_actual = tflame_at(phi_solved)
    return {
        "phi": phi_solved, "T_flame_actual_K": T_actual,
        "T_flame_target_K": T_target,
        "T_at_phi_min_K": T_lo, "T_at_phi_max_K": T_hi,
        "iterations": iters, "converged": True, "saturated": "",
    }


@router.post("/solve-phi-for-tflame", response_model=SolvePhiForTflameResponse)
def calc_solve_phi_for_tflame(
    body: SolvePhiForTflameRequest, _: User = Depends(require_full_subscription),
) -> SolvePhiForTflameResponse:
    result = _run_in_pool(
        _solve_phi_for_tflame_impl,
        body.fuel,
        body.oxidizer,
        body.T_flame_target_K,
        body.T_fuel_K,
        body.T_air_K,
        body.P_bar,
        body.WFR,
        body.water_mode,
        body.T_water_K,
        body.phi_min,
        body.phi_max,
        body.tol,
    )
    return SolvePhiForTflameResponse(**result)
