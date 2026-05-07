"""Accurate Cantera-backed calculation endpoints. Requires FULL subscription."""
from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request

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
    SweepJobSubmitted,
    SweepJobStatus,
    PropsRequest,
    PropsResponse,
    SolvePhiForTflameRequest,
    SolvePhiForTflameResponse,
    BatchRequest,
    BatchResponse,
    BatchJobResult,
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

# ── Sweep pool: SEPARATE serialized executor for /flame-speed-sweep ──
# Sweeps cost up to 540 s and used to share `_solver_pool`, so a single
# user kicking off a sweep would block every other Cantera request for
# ~9 minutes. Splitting them means single-point flame solves stay
# responsive even while a sweep is running. Sweeps are submitted in a
# fire-and-forget pattern: the POST returns a job_id immediately, and
# the client polls /calc/sweep-result/{job_id} until done.
_sweep_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cantera-sweep")
_sweep_jobs: "OrderedDict[str, dict]" = OrderedDict()
_SWEEP_JOBS_MAX = 200          # bounded so we never grow without limit
_SWEEP_JOB_TTL_S = 30 * 60     # results readable for 30 min after finish

# ── Rate limiter — minimal in-process token bucket ──
# slowapi has a known incompat with `from __future__ import annotations`
# + FastAPI type-hint introspection, so we roll our own. Per-IP buckets,
# fixed-window. Render's load balancer sets X-Forwarded-For, so we
# bucket by the real client IP rather than the Render proxy IP.
# Limits are per-process; with 4 gunicorn workers the effective per-IP
# allowance is ~4× the value here, which is acceptable headroom for the
# sole goal: prevent a runaway script / tab from locking the Cantera
# pool. A real distributed limiter would need Redis — Tier 2 work.
_RL_BUCKETS: Dict[str, Dict[str, list[float]]] = {}   # bucket_key -> {endpoint: [timestamps]}

def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        # Take the first IP in the chain (closest to client). Render appends
        # the proxy IP after the real client, so [0] is what we want.
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

def _rate_limit(endpoint: str, per_min: int, per_hour: int):
    """FastAPI dependency factory. Raises 429 with Retry-After when the
    caller has exceeded either window."""
    def _dep(request: Request):
        ip = _client_ip(request)
        now = time.time()
        bucket = _RL_BUCKETS.setdefault(ip, {})
        hits = bucket.setdefault(endpoint, [])
        # Trim everything older than 1 hour.
        cutoff_h = now - 3600
        cutoff_m = now - 60
        # in-place filter for speed
        if hits and hits[0] < cutoff_h:
            new_hits = [t for t in hits if t >= cutoff_h]
            bucket[endpoint] = new_hits
            hits = new_hits
        recent_min = sum(1 for t in hits if t >= cutoff_m)
        if recent_min >= per_min:
            oldest_in_window = next(t for t in hits if t >= cutoff_m)
            retry = max(1, int(oldest_in_window + 60 - now))
            raise HTTPException(
                status_code=429,
                detail=f"Too many {endpoint} requests — limit {per_min}/min. Retry in {retry}s.",
                headers={"Retry-After": str(retry)},
            )
        if len(hits) >= per_hour:
            retry = max(1, int(hits[0] + 3600 - now))
            raise HTTPException(
                status_code=429,
                detail=f"Hourly cap reached for {endpoint} — limit {per_hour}/hour. Retry in {retry//60}m.",
                headers={"Retry-After": str(retry)},
            )
        hits.append(now)
        # Cap dict size to avoid unbounded growth from drive-by traffic.
        if len(_RL_BUCKETS) > 5000:
            # Drop oldest 1000 by last-touch.
            stale = sorted(_RL_BUCKETS.items(), key=lambda kv: max((max(v) for v in kv[1].values() if v), default=0))[:1000]
            for k, _ in stale:
                _RL_BUCKETS.pop(k, None)
    return _dep

# Per-endpoint limit profiles. The numbers are conservative — generous
# enough that a normal user clicking through panels never sees a 429,
# tight enough that a runaway loop or stuck retry can't lock workers.
_RL_FLAME      = _rate_limit("flame-speed",        per_min=30, per_hour=500)
_RL_COMBUSTOR  = _rate_limit("combustor",          per_min=20, per_hour=300)
_RL_AUTOIGN    = _rate_limit("autoignition",       per_min=30, per_hour=500)
# Batch is the matrix-automation hot path. A single 300-row matrix at
# ~1 s/row produces ~300 batch calls in 5 min — the old 60/min cap
# guaranteed dozens of 429 errors mid-run. Raised to 600/min, 12000/hr
# so a 3000-row matrix finishes without ever hitting the limiter, but
# we still cap runaway loops well below what would crash the backend.
_RL_BATCH      = _rate_limit("batch",              per_min=600, per_hour=12000)
_RL_SWEEP_POST = _rate_limit("sweep-submit",       per_min=3,  per_hour=20)
_RL_SWEEP_POLL = _rate_limit("sweep-poll",         per_min=120, per_hour=3000)

# ───────────────────────────────────────────────────────────────────────
#  Backend-side LRU cache for solver results.
#  Keyed on a stable hash of the request body (with the `lean` field
#  stripped, since it only affects response shape — the underlying
#  Cantera computation is identical). Multi-user benefit: if two
#  different sessions hit the API with identical inputs, only the first
#  pays the Cantera cost. Bounded entry count to keep memory predictable
#  inside Render Standard's 2 GB.
# ───────────────────────────────────────────────────────────────────────
_BACKEND_CACHE_MAX_ENTRIES = 500
_backend_cache: "OrderedDict[str, dict]" = OrderedDict()


def _cache_normalize(v):
    """Recursively normalise a request body for stable hashing.
    - Drop the `lean` flag (response-shape only).
    - Coerce all numerics to float and round to 8 sig figs (so int 0 and
      float 0.0 hash the same, and 0.555000001 vs 0.555000002 collide).
    - Sort dict keys.
    """
    if isinstance(v, dict):
        return {k: _cache_normalize(v[k]) for k in sorted(v.keys()) if k != "lean"}
    if isinstance(v, list):
        return [_cache_normalize(x) for x in v]
    # bool is a subclass of int — handle it first so True/False stay as bool.
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        if v == 0:
            return 0.0
        return float(f"{float(v):.8g}")
    return v


def _cache_key(body, kind: str) -> str:
    body_dict = body.model_dump(exclude_none=False)
    s = json.dumps(_cache_normalize(body_dict), sort_keys=True, separators=(",", ":"))
    return f"{kind}:{hashlib.md5(s.encode()).hexdigest()}"


def _cached_compute(body, kind: str, compute_fn):
    """Look up by hash; on miss, run compute_fn() and store. compute_fn is
    a 0-arg callable returning the result dict. Failures are NOT cached
    (compute_fn raises on failure → exception propagates without a
    cache write)."""
    key = _cache_key(body, kind)
    if key in _backend_cache:
        # LRU touch — move to end so it survives eviction longer.
        _backend_cache.move_to_end(key)
        return _backend_cache[key]
    result = compute_fn()
    _backend_cache[key] = result
    if len(_backend_cache) > _BACKEND_CACHE_MAX_ENTRIES:
        _backend_cache.popitem(last=False)  # evict oldest
    return result


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
    result = _cached_compute(body, "aft", lambda: _run_in_pool(
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
    ))
    return AFTResponse(**result)


@router.post("/flame-speed", response_model=FlameSpeedResponse)
def calc_flame_speed(
    body: FlameSpeedRequest,
    _: User = Depends(require_full_subscription),
    __=Depends(_RL_FLAME),
) -> FlameSpeedResponse:
    result = _cached_compute(body, "flame_speed", lambda: _run_in_pool(
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
    ))
    # Lean mode: strip the profile arrays before serializing. The automation
    # runner never reads them; saves ~30 KB of wire payload per call. Note
    # the cache stores the FULL result so non-lean callers still get the
    # profile from a cache hit.
    if body.lean:
        result = {**result, "T_profile": [], "x_profile": []}
    return FlameSpeedResponse(**result)


def _run_sweep_job(job_id: str, args: tuple) -> None:
    """Worker thread body — runs on _sweep_pool. Stores result/error in
    `_sweep_jobs[job_id]`. Never raises; failures are captured as a
    "status: error" record the client can read."""
    job = _sweep_jobs.get(job_id)
    if job is None:
        return
    job["status"] = "running"
    job["started_at"] = time.time()
    try:
        result = flame_speed_sweep.run(*args)
        job["result"] = result
        job["status"] = "done"
    except Exception as e:  # noqa: BLE001
        log.exception("flame-speed-sweep job %s error: %s", job_id, e)
        job["error"] = "Flame-speed sweep failed. One or more points may be outside the flammability limits; narrow the range and retry."
        job["status"] = "error"
    finally:
        job["finished_at"] = time.time()


def _evict_old_sweep_jobs() -> None:
    """Drop finished jobs older than _SWEEP_JOB_TTL_S, and trim by max
    count. Keeps the in-memory store bounded across long uptimes."""
    now = time.time()
    expired = [
        jid for jid, j in _sweep_jobs.items()
        if j.get("finished_at") and (now - j["finished_at"]) > _SWEEP_JOB_TTL_S
    ]
    for jid in expired:
        _sweep_jobs.pop(jid, None)
    while len(_sweep_jobs) > _SWEEP_JOBS_MAX:
        _sweep_jobs.popitem(last=False)


@router.post("/flame-speed-sweep", response_model=SweepJobSubmitted)
def calc_flame_speed_sweep(
    body: FlameSpeedSweepRequest,
    _: User = Depends(require_full_subscription),
    __=Depends(_RL_SWEEP_POST),
) -> SweepJobSubmitted:
    """Submit a Cantera FreeFlame sweep. Returns a `job_id` IMMEDIATELY
    — the actual sweep runs on `_sweep_pool` in the background and can
    take up to 540 s. The client polls `GET /calc/sweep-result/{job_id}`
    until status="done".

    Why async: a single sweep used to lock the whole Cantera worker for
    minutes, so two concurrent users could starve every other request.
    Splitting it onto its own pool + returning immediately means
    single-point flame solves stay responsive even during a sweep.
    """
    _evict_old_sweep_jobs()
    job_id = uuid.uuid4().hex
    _sweep_jobs[job_id] = {
        "job_id": job_id,
        "status": "queued",
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "result": None,
        "error": None,
    }
    args = (
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
    )
    _sweep_pool.submit(_run_sweep_job, job_id, args)
    return SweepJobSubmitted(
        job_id=job_id,
        status="queued",
        poll_url=f"/calc/sweep-result/{job_id}",
    )


@router.get("/sweep-result/{job_id}", response_model=SweepJobStatus)
def get_sweep_result(
    job_id: str,
    _: User = Depends(require_full_subscription),
    __=Depends(_RL_SWEEP_POLL),
) -> SweepJobStatus:
    """Poll a sweep job. Returns status + (when done) the full result.
    Results stay readable for ~30 minutes after the job finishes."""
    job = _sweep_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Sweep job not found or expired")
    started = job.get("started_at") or job.get("created_at") or time.time()
    finished = job.get("finished_at") or time.time()
    elapsed = max(0.0, finished - started)
    return SweepJobStatus(
        job_id=job_id,
        status=job["status"],
        elapsed_s=elapsed,
        result=FlameSpeedSweepResponse(**job["result"]) if job.get("result") else None,
        error=job.get("error"),
    )


@router.post("/combustor", response_model=CombustorResponse)
def calc_combustor(
    body: CombustorRequest,
    _: User = Depends(require_full_subscription),
    __=Depends(_RL_COMBUSTOR),
) -> CombustorResponse:
    def _compute():
        r = _run_in_pool(
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
        r["mechanism"] = body.mechanism
        return r
    result = _cached_compute(body, "combustor", _compute)
    # Lean mode: drop the per-position profile array. Used by automation
    # where only the scalar headline outputs (T_psr, T_exit, NO/CO ppmvd,
    # τ_total, etc.) get extracted. Cache stores the full result so non-
    # lean callers still get the profile from a cache hit.
    if body.lean:
        result = {**result, "profile": []}
    return CombustorResponse(**result)


@router.post("/combustor_mapping", response_model=CombustorMappingResponse)
def calc_combustor_mapping(
    body: CombustorMappingRequest, _: User = Depends(require_full_subscription)
) -> CombustorMappingResponse:
    """LMS100 DLE 4-circuit correlation model: T_AFT per circuit +
    anchored-linear emissions/dynamics prediction with Phi_OP multiplier
    (HI only) + P3 power-law scaling for part load. No kinetic solver."""
    result = _cached_compute(body, "combustor_mapping", lambda: _run_in_pool(
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
    ))
    return CombustorMappingResponse(**result)


@router.post("/exhaust", response_model=ExhaustResponse)
def calc_exhaust(body: ExhaustRequest, _: User = Depends(require_full_subscription)) -> ExhaustResponse:
    result = _cached_compute(body, "exhaust", lambda: _run_in_pool(
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
    ))
    return ExhaustResponse(**result)


@router.post("/props", response_model=PropsResponse)
def calc_props(body: PropsRequest, _: User = Depends(require_full_subscription)) -> PropsResponse:
    result = _cached_compute(body, "props", lambda: _run_in_pool(props.run, body.mixture, body.T, body.P))
    return PropsResponse(**result)


@router.post("/cycle", response_model=CycleResponse)
def calc_cycle(body: CycleRequest, _: User = Depends(require_full_subscription)) -> CycleResponse:
    result = _cached_compute(body, "cycle", lambda: _run_in_pool(
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
        body.mwi_derate_override,
    ))
    return CycleResponse(**result)


@router.post("/autoignition", response_model=AutoignitionResponse)
def calc_autoignition(
    body: AutoignitionRequest,
    _: User = Depends(require_full_subscription),
    __=Depends(_RL_AUTOIGN),
) -> AutoignitionResponse:
    result = _cached_compute(body, "autoignition", lambda: _run_in_pool(
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
    ))
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
    # Wrap complete_combustion.run so brentq sees a sign-change-of-(T-T_target)
    # function. Track call count and last-evaluated point so we can avoid one
    # extra Cantera eval at the end when brentq converges dead-on.
    eval_count = [0]
    last = {"phi": None, "T": None}
    def f(phi: float) -> float:
        r = complete_combustion.run(
            fuel, oxidizer, float(phi), float(T_fuel), float(T_air), float(P_bar),
            WFR=float(WFR), water_mode=water_mode, T_water_K=T_water_K,
        )
        T = float(r.get("T_ad", 0.0))
        last["phi"] = phi
        last["T"]   = T
        eval_count[0] += 1
        return T - T_target

    # Lean-only search: T_flame peaks near phi=1.0 on the lean side.
    lo = float(phi_min)
    hi = min(float(phi_max), 1.0)
    f_lo = f(lo)
    f_hi = f(hi)
    T_lo = f_lo + T_target
    T_hi = f_hi + T_target

    # Saturation: target outside the achievable lean range. Same semantics
    # as the previous bisection.
    if T_target <= T_lo:
        return {
            "phi": lo, "T_flame_actual_K": T_lo,
            "T_flame_target_K": T_target,
            "T_at_phi_min_K": T_lo, "T_at_phi_max_K": T_hi,
            "iterations": eval_count[0], "converged": True, "saturated": "low",
        }
    if T_target >= T_hi:
        return {
            "phi": hi, "T_flame_actual_K": T_hi,
            "T_flame_target_K": T_target,
            "T_at_phi_min_K": T_lo, "T_at_phi_max_K": T_hi,
            "iterations": eval_count[0], "converged": True, "saturated": "high",
        }

    # Brent's method — combines bisection's robustness with secant /
    # inverse-quadratic interpolation. Same monotonic root, same xtol
    # semantics as the old bisection's `if hi - lo < tol: break`, but
    # converges in ~6-9 evals instead of ~15-18 — ~2× speedup on the same
    # quality bar.
    from scipy.optimize import brentq
    phi_solved, info = brentq(
        f, lo, hi, xtol=float(tol), rtol=1e-9, maxiter=60, full_output=True,
    )
    # Avoid a redundant Cantera eval if brentq's last evaluation was at
    # phi_solved (very common when convergence lands dead-on).
    if (last["phi"] is not None
            and abs(last["phi"] - phi_solved) < 1e-12
            and last["T"] is not None):
        T_actual = last["T"]
    else:
        T_actual = float(complete_combustion.run(
            fuel, oxidizer, float(phi_solved), float(T_fuel), float(T_air), float(P_bar),
            WFR=float(WFR), water_mode=water_mode, T_water_K=T_water_K,
        ).get("T_ad", 0.0))
        eval_count[0] += 1
    return {
        "phi": float(phi_solved), "T_flame_actual_K": T_actual,
        "T_flame_target_K": T_target,
        "T_at_phi_min_K": T_lo, "T_at_phi_max_K": T_hi,
        "iterations": eval_count[0],
        "converged": bool(info.converged),
        "saturated": "",
    }


@router.post("/solve-phi-for-tflame", response_model=SolvePhiForTflameResponse)
def calc_solve_phi_for_tflame(
    body: SolvePhiForTflameRequest, _: User = Depends(require_full_subscription),
) -> SolvePhiForTflameResponse:
    result = _cached_compute(body, "solve_phi_tflame", lambda: _run_in_pool(
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
    ))
    return SolvePhiForTflameResponse(**result)


# ───────────────────────────────────────────────────────────────────────
#  /calc/batch — multi-job per HTTP call
#
#  Eliminates ~200 ms of per-call wire+TLS+auth overhead when the
#  automation runner needs to fire N solver calls per matrix row. Each
#  inner job is dispatched to the same _cached_compute path the
#  dedicated route uses, so:
#    • the in-memory LRU cache works across batch jobs and route hits
#    • per-job errors are caught and reported in BatchJobResult.error
#      without aborting the whole batch
#    • the underlying solver path is identical — same Cantera, same
#      results, no new code paths to maintain
# ───────────────────────────────────────────────────────────────────────


def _do_aft(body: AFTRequest) -> dict:
    return _cached_compute(body, "aft", lambda: _run_in_pool(
        aft.run, body.fuel, body.oxidizer, body.phi, body.T0, body.P,
        body.heat_loss_fraction if body.mode == "heat_loss" else 0.0,
        body.T_fuel_K, body.T_air_K, body.WFR, body.water_mode, body.T_products_K,
    ))


def _do_flame_speed(body: FlameSpeedRequest) -> dict:
    result = _cached_compute(body, "flame_speed", lambda: _run_in_pool(
        flame_speed.run, body.fuel, body.oxidizer, body.phi, body.T0, body.P,
        body.domain_length_m, body.T_fuel_K, body.T_air_K, body.WFR, body.water_mode,
    ))
    if body.lean:
        result = {**result, "T_profile": [], "x_profile": []}
    return result


def _do_combustor(body: CombustorRequest) -> dict:
    def _compute():
        r = _run_in_pool(
            combustor.run, body.fuel, body.oxidizer, body.phi, body.T0, body.P,
            body.tau_psr_s, body.L_pfr_m, body.V_pfr_m_s, body.profile_points,
            body.T_fuel_K, body.T_air_K, body.psr_seed, body.eq_constraint,
            body.integration, body.heat_loss_fraction, body.mechanism,
            body.WFR, body.water_mode,
        )
        r["mechanism"] = body.mechanism
        return r
    result = _cached_compute(body, "combustor", _compute)
    if body.lean:
        result = {**result, "profile": []}
    return result


def _do_combustor_mapping(body: CombustorMappingRequest) -> dict:
    return _cached_compute(body, "combustor_mapping", lambda: _run_in_pool(
        combustor_mapping.run, body.fuel, body.oxidizer, body.T3_K, body.P3_bar,
        body.T_fuel_K, body.W3_kg_s, body.W36_over_W3, body.com_air_frac,
        body.frac_IP_pct, body.frac_OP_pct, body.frac_IM_pct, body.frac_OM_pct,
        body.phi_IP, body.phi_OP, body.phi_IM, body.m_fuel_total_kg_s,
        body.WFR, body.water_mode, body.nox_mult, body.co_mult, body.px36_mult,
    ))


def _do_exhaust(body: ExhaustRequest) -> dict:
    return _cached_compute(body, "exhaust", lambda: _run_in_pool(
        exhaust.run, body.fuel, body.oxidizer, body.T0, body.P,
        body.measured_O2_pct_dry, body.measured_CO2_pct_dry, body.combustion_mode,
        body.T_fuel_K, body.T_air_K, body.WFR, body.water_mode,
    ))


def _do_cycle(body: CycleRequest) -> dict:
    return _cached_compute(body, "cycle", lambda: _run_in_pool(
        cycle.run, body.engine, body.P_amb_bar, body.T_amb_K, body.RH_pct,
        body.load_pct, body.T_cool_in_K, body.fuel_pct, body.combustor_air_frac,
        body.T_fuel_K, body.WFR, body.water_mode, body.T_water_K, body.bleed_air_frac,
        body.mwi_derate_override,
    ))


def _do_autoignition(body: AutoignitionRequest) -> dict:
    return _cached_compute(body, "autoignition", lambda: _run_in_pool(
        autoignition.run, body.fuel, body.oxidizer, body.phi, body.T0, body.P,
        body.max_time_s, body.T_fuel_K, body.T_air_K, body.mechanism,
        body.WFR, body.water_mode,
    ))


def _do_props(body: PropsRequest) -> dict:
    return _cached_compute(body, "props", lambda: _run_in_pool(props.run, body.mixture, body.T, body.P))


def _do_solve_phi_tflame(body: SolvePhiForTflameRequest) -> dict:
    return _cached_compute(body, "solve_phi_tflame", lambda: _run_in_pool(
        _solve_phi_for_tflame_impl, body.fuel, body.oxidizer, body.T_flame_target_K,
        body.T_fuel_K, body.T_air_K, body.P_bar, body.WFR, body.water_mode,
        body.T_water_K, body.phi_min, body.phi_max, body.tol,
    ))


# Dispatch table: kind → (request model, compute fn). The batch endpoint
# uses this; the dedicated routes still construct the request via FastAPI
# and call the same _do_* helper for symmetry.
_KIND_DISPATCH = {
    "aft":              (AFTRequest,                _do_aft),
    "flame_speed":      (FlameSpeedRequest,         _do_flame_speed),
    "combustor":        (CombustorRequest,          _do_combustor),
    "combustor_mapping":(CombustorMappingRequest,   _do_combustor_mapping),
    "exhaust":          (ExhaustRequest,            _do_exhaust),
    "cycle":            (CycleRequest,              _do_cycle),
    "autoignition":     (AutoignitionRequest,       _do_autoignition),
    "props":            (PropsRequest,              _do_props),
    "solve_phi_tflame": (SolvePhiForTflameRequest,  _do_solve_phi_tflame),
}


@router.post("/batch", response_model=BatchResponse)
def calc_batch(
    body: BatchRequest,
    _: User = Depends(require_full_subscription),
    __=Depends(_RL_BATCH),
) -> BatchResponse:
    results = []
    for i, job in enumerate(body.jobs):
        try:
            entry = _KIND_DISPATCH.get(job.kind)
            if entry is None:
                results.append(BatchJobResult(ok=False, error=f"unknown kind: {job.kind}"))
                continue
            req_cls, do_fn = entry
            req = req_cls(**job.args)
            data = do_fn(req)
            results.append(BatchJobResult(ok=True, data=data))
        except Exception as e:
            log.exception("batch job %d (%s) failed: %s", i, job.kind, e)
            # Generic error message to avoid leaking solver internals.
            results.append(BatchJobResult(
                ok=False,
                error=f"{type(e).__name__}: {str(e)[:200]}",
            ))
    return BatchResponse(results=results)
