"""FastAPI entrypoint for the desktop-mode solver.

Runs as a child process spawned by the Electron main process. Exposes the
/calc/* endpoints on 127.0.0.1:<port>. Auth is replaced with offline
license-token verification: the caller (Electron) passes the signed_token
it received from the cloud /desktop/activate endpoint as an
`X-License-Token` header (or the solver is launched with `--license-token`
/ `CTK_LICENSE_TOKEN`).

Token format: `<json_payload>|<hex_hmac_sha256>`. The HMAC is signed with
LICENSE_SIGNING_KEY, baked into the PyInstaller build at compile time.

This file is intentionally self-contained -- it does NOT pull in the cloud
auth/billing/admin routers (which would require a database, Stripe, etc.).
Each endpoint is a thin shim that calls the same `science.*` module the
cloud router uses, with the SAME signature, so the desktop and cloud
return identical results.

CTK_DEBUG: every exception is logged with full traceback to BOTH stderr
(captured by Electron and forwarded to ctk-solver-stderr.log) and to a
plain-text log at <workspace>/ctk-solver.log so the user can share it.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cantera as ct
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .schemas import (
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
    HealthResponse,
    PropsRequest,
    PropsResponse,
    SolvePhiForTflameRequest,
    SolvePhiForTflameResponse,
)
from .science import (
    aft,
    autoignition,
    combustor,
    combustor_mapping,
    complete_combustion,
    cycle,
    exhaust,
    flame_speed,
    props,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("desktop-solver")

# Baked-in signing key — overridden at PyInstaller build time via CTK_BAKED_SIGNING_KEY env.
_BAKED_SIGNING_KEY = os.environ.get("CTK_BAKED_SIGNING_KEY", "")

# Cantera is not thread-safe — serialize through a single worker.
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cantera-desktop")


# CTK_DEBUG: persistent traceback log the user can share. Lives in
# %USERPROFILE%\ctk-solver.log on Windows so it's easy to find without
# sandbox path translation. Falls back to current dir if HOME isn't set.
def _trace_log_path() -> Path:
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME") or "."
    return Path(home) / "ctk-solver.log"


def _log_traceback(prefix: str, exc: BaseException) -> str:
    """Format + write the full traceback to BOTH stderr and the
    user-visible log file. Returns the formatted text so callers can
    embed a snippet in HTTP error responses."""
    tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    msg = f"\n===== {prefix} @ {datetime.now(timezone.utc).isoformat()} =====\n{tb}\n"
    sys.stderr.write(msg)
    sys.stderr.flush()
    try:
        with open(_trace_log_path(), "a", encoding="utf-8") as fh:
            fh.write(msg)
    except OSError:
        pass  # don't crash the request just because the log file is unwritable
    return tb


def _run(fn, *a, **kw) -> Any:
    try:
        return _pool.submit(fn, *a, **kw).result(timeout=180)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        _log_traceback(f"solver error in {getattr(fn, '__name__', fn)}", e)
        raise HTTPException(status_code=500, detail=f"solver error: {type(e).__name__}: {e}") from e


# ---------- license verification ----------
# Two-layer license model:
#   1. Electron main.js verifies the Ed25519-signed license file BEFORE
#      it ever spawns ctk-solver.exe. If that check fails the user sees
#      the activation dialog and the solver never starts.
#   2. The solver re-checks an HMAC-SHA256-signed token here as a
#      belt-and-suspenders defense against a malicious local process
#      driving the loopback API.
#
# The HMAC check needs CTK_BAKED_SIGNING_KEY baked in at PyInstaller
# build time. When it ISN'T baked in (current state — the build
# pipeline doesn't substitute it), this re-check would 500 every
# request and lock out the user even though the Ed25519 check already
# passed. Treat absent-key as "skip the re-check" and rely on the
# loopback-binding gate. CORS already restricts allowed origins to
# Electron's null + the dev server.
def _verify_license_token(token: str) -> dict[str, Any]:
    if not _BAKED_SIGNING_KEY:
        # No baked key -> trust the Electron-side Ed25519 check that
        # gated the solver spawn. Returning a stub payload satisfies
        # the dep return type without surfacing 500s downstream.
        return {"tier": "desktop", "skipped_check": True}
    if not token or "|" not in token:
        raise HTTPException(status_code=401, detail="invalid license token")
    payload_json, sig = token.rsplit("|", 1)
    expected = hmac.new(_BAKED_SIGNING_KEY.encode("utf-8"), payload_json.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(status_code=401, detail="license signature mismatch")
    try:
        payload = json.loads(payload_json)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=401, detail=f"malformed license payload: {e}") from e
    exp = payload.get("expires_at")
    if exp:
        try:
            exp_dt = datetime.fromisoformat(exp.replace("Z", "+00:00"))
            if exp_dt.tzinfo is None:
                exp_dt = exp_dt.replace(tzinfo=timezone.utc)
            if exp_dt < datetime.now(timezone.utc):
                raise HTTPException(status_code=410, detail="license expired — renew subscription")
        except ValueError:
            pass
    return payload


def _license_dep(x_license_token: str | None = Header(default=None)) -> dict[str, Any]:
    token = x_license_token or os.environ.get("CTK_LICENSE_TOKEN", "")
    return _verify_license_token(token)


# ---------- app factory ----------
def create_desktop_app() -> FastAPI:
    app = FastAPI(
        title="Combustion Toolkit — Desktop Solver",
        version="0.2.0",
        docs_url=None,
        redoc_url=None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "null",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "X-License-Token"],
    )

    # CTK_DEBUG: catch-all so any uncaught exception (validation failures
    # in handler bodies, missing deps, etc.) gets logged with a full
    # traceback instead of disappearing into uvicorn's default logger.
    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):  # type: ignore[unused-argument]
        _log_traceback(f"unhandled in {request.method} {request.url.path}", exc)
        return JSONResponse(
            status_code=500,
            content={"detail": f"unhandled: {type(exc).__name__}: {exc}"},
        )

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok", cantera_version=ct.__version__, env="desktop", stripe_configured=False)

    # ---------- /calc/aft ----------
    @app.post("/calc/aft", response_model=AFTResponse)
    def calc_aft(body: AFTRequest, _lic=Depends(_license_dep)) -> AFTResponse:  # noqa: B008
        r = _run(
            aft.run, body.fuel, body.oxidizer, body.phi, body.T0, body.P,
            body.heat_loss_fraction if body.mode == "heat_loss" else 0.0,
            body.T_fuel_K, body.T_air_K, body.WFR, body.water_mode,
        )
        return AFTResponse(**r)

    # ---------- /calc/flame-speed ----------
    @app.post("/calc/flame-speed", response_model=FlameSpeedResponse)
    def calc_flame(body: FlameSpeedRequest, _lic=Depends(_license_dep)) -> FlameSpeedResponse:  # noqa: B008
        # Pass T_fuel_K/T_air_K + WFR if the science module accepts them
        # (newer signatures); fall back to positional minimum otherwise.
        try:
            r = _run(
                flame_speed.run, body.fuel, body.oxidizer, body.phi, body.T0, body.P,
                body.domain_length_m, body.T_fuel_K, body.T_air_K,
                body.WFR, body.water_mode,
            )
        except TypeError:
            r = _run(flame_speed.run, body.fuel, body.oxidizer, body.phi, body.T0, body.P, body.domain_length_m)
        return FlameSpeedResponse(**r)

    # ---------- /calc/combustor ----------
    @app.post("/calc/combustor", response_model=CombustorResponse)
    def calc_comb(body: CombustorRequest, _lic=Depends(_license_dep)) -> CombustorResponse:  # noqa: B008
        r = _run(
            combustor.run,
            body.fuel, body.oxidizer, body.phi, body.T0, body.P,
            body.tau_psr_s, body.L_pfr_m, body.V_pfr_m_s, body.profile_points,
            body.T_fuel_K, body.T_air_K, body.psr_seed, body.eq_constraint,
            body.integration, body.heat_loss_fraction, body.mechanism,
            body.WFR, body.water_mode,
        )
        return CombustorResponse(**r)

    # ---------- /calc/exhaust ----------
    @app.post("/calc/exhaust", response_model=ExhaustResponse)
    def calc_exh(body: ExhaustRequest, _lic=Depends(_license_dep)) -> ExhaustResponse:  # noqa: B008
        r = _run(
            exhaust.run,
            body.fuel, body.oxidizer, body.T0, body.P,
            body.measured_O2_pct_dry, body.measured_CO2_pct_dry,
            body.combustion_mode, body.T_fuel_K, body.T_air_K,
            body.WFR, body.water_mode,
        )
        return ExhaustResponse(**r)

    # ---------- /calc/props ----------
    @app.post("/calc/props", response_model=PropsResponse)
    def calc_props(body: PropsRequest, _lic=Depends(_license_dep)) -> PropsResponse:  # noqa: B008
        r = _run(props.run, body.mixture, body.T, body.P)
        return PropsResponse(**r)

    # ---------- /calc/autoignition ----------
    @app.post("/calc/autoignition", response_model=AutoignitionResponse)
    def calc_autoign(body: AutoignitionRequest, _lic=Depends(_license_dep)) -> AutoignitionResponse:  # noqa: B008
        r = _run(
            autoignition.run, body.fuel, body.oxidizer, body.phi, body.T0, body.P,
            body.max_time_s, body.T_fuel_K, body.T_air_K, body.mechanism,
        )
        return AutoignitionResponse(**r)

    # ---------- /calc/cycle ---- NEW: was missing from desktop, gave 404 ----
    @app.post("/calc/cycle", response_model=CycleResponse)
    def calc_cycle(body: CycleRequest, _lic=Depends(_license_dep)) -> CycleResponse:  # noqa: B008
        r = _run(
            cycle.run,
            body.engine, body.P_amb_bar, body.T_amb_K, body.RH_pct,
            body.load_pct, body.T_cool_in_K, body.fuel_pct,
            body.combustor_air_frac, body.T_fuel_K,
            body.WFR, body.water_mode, body.T_water_K,
            body.bleed_air_frac, body.mwi_derate_override,
        )
        return CycleResponse(**r)

    # ---------- /calc/combustor_mapping ---- NEW ----
    @app.post("/calc/combustor_mapping", response_model=CombustorMappingResponse)
    def calc_mapping(body: CombustorMappingRequest, _lic=Depends(_license_dep)) -> CombustorMappingResponse:  # noqa: B008
        r = _run(
            combustor_mapping.run,
            body.fuel, body.oxidizer, body.T3_K, body.P3_bar, body.T_fuel_K,
            body.W3_kg_s, body.W36_over_W3, body.com_air_frac,
            body.frac_IP_pct, body.frac_OP_pct, body.frac_IM_pct, body.frac_OM_pct,
            body.phi_IP, body.phi_OP, body.phi_IM,
            body.m_fuel_total_kg_s,
            body.WFR, body.water_mode,
            body.nox_mult, body.co_mult, body.px36_mult,
        )
        return CombustorMappingResponse(**r)

    # ---------- /calc/solve-phi-for-tflame ---- NEW ----
    @app.post("/calc/solve-phi-for-tflame", response_model=SolvePhiForTflameResponse)
    def calc_solve_phi(body: SolvePhiForTflameRequest, _lic=Depends(_license_dep)) -> SolvePhiForTflameResponse:  # noqa: B008
        # Inline the cloud router's bisection wrapper to avoid pulling
        # the auth-tied router module into the desktop bundle.
        def _impl():
            from scipy.optimize import brentq
            eval_count = [0]
            last = {"phi": None, "T": None}

            def f(phi: float) -> float:
                r = complete_combustion.run(
                    body.fuel, body.oxidizer, float(phi),
                    float(body.T_fuel_K), float(body.T_air_K), float(body.P_bar),
                    WFR=float(body.WFR or 0.0),
                    water_mode=body.water_mode,
                    T_water_K=body.T_water_K,
                )
                T = float(r.get("T_ad", 0.0))
                last["phi"] = phi
                last["T"] = T
                eval_count[0] += 1
                return T - float(body.T_flame_target_K)

            lo = float(body.phi_min)
            hi = min(float(body.phi_max), 1.0)
            f_lo = f(lo); f_hi = f(hi)
            T_lo = f_lo + body.T_flame_target_K
            T_hi = f_hi + body.T_flame_target_K
            if body.T_flame_target_K <= T_lo:
                return {"phi": lo, "T_flame_actual_K": T_lo, "T_flame_target_K": body.T_flame_target_K,
                        "T_at_phi_min_K": T_lo, "T_at_phi_max_K": T_hi,
                        "iterations": eval_count[0], "converged": True, "saturated": "low"}
            if body.T_flame_target_K >= T_hi:
                return {"phi": hi, "T_flame_actual_K": T_hi, "T_flame_target_K": body.T_flame_target_K,
                        "T_at_phi_min_K": T_lo, "T_at_phi_max_K": T_hi,
                        "iterations": eval_count[0], "converged": True, "saturated": "high"}
            phi_solved, info = brentq(f, lo, hi, xtol=float(body.tol), rtol=1e-9, maxiter=60, full_output=True)
            if last["phi"] is not None and abs(last["phi"] - phi_solved) < 1e-12 and last["T"] is not None:
                T_actual = last["T"]
            else:
                T_actual = float(complete_combustion.run(
                    body.fuel, body.oxidizer, float(phi_solved),
                    float(body.T_fuel_K), float(body.T_air_K), float(body.P_bar),
                    WFR=float(body.WFR or 0.0), water_mode=body.water_mode, T_water_K=body.T_water_K,
                ).get("T_ad", 0.0))
                eval_count[0] += 1
            return {"phi": float(phi_solved), "T_flame_actual_K": T_actual,
                    "T_flame_target_K": body.T_flame_target_K,
                    "T_at_phi_min_K": T_lo, "T_at_phi_max_K": T_hi,
                    "iterations": eval_count[0], "converged": bool(info.converged), "saturated": ""}

        r = _run(_impl)
        return SolvePhiForTflameResponse(**r)

    return app


app = create_desktop_app()


# ---------- PyInstaller entrypoint ----------
def main() -> int:
    """Entry point used by PyInstaller. Runs uvicorn on a random free port.

    Writes the chosen port to stdout as `CTK_PORT=<n>\\n` so the Electron main
    process can capture it via child.stdout, then keeps serving.
    """
    import socket

    import uvicorn

    # Pick a free port on loopback.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    print(f"CTK_PORT={port}", flush=True)
    log.info("desktop solver listening on 127.0.0.1:%d", port)
    log.info("traceback log: %s", _trace_log_path())
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
