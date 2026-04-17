"""FastAPI entrypoint for the desktop-mode solver.

Runs as a child process spawned by the Electron main process. Exposes only the
/calc/* endpoints on 127.0.0.1:<port>. Auth is replaced with offline license-token
verification: the caller (Electron) passes the signed_token it received from the
cloud /desktop/activate endpoint as an `X-License-Token` header (or the solver is
launched with `--license-token` / `CTK_LICENSE_TOKEN`).

Token format: `<json_payload>|<hex_hmac_sha256>`. The HMAC is signed with
LICENSE_SIGNING_KEY, which is baked into the PyInstaller build at compile time.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

import cantera as ct
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .schemas import (
    AFTRequest,
    AFTResponse,
    CombustorRequest,
    CombustorResponse,
    ExhaustRequest,
    ExhaustResponse,
    FlameSpeedRequest,
    FlameSpeedResponse,
    HealthResponse,
    PropsRequest,
    PropsResponse,
)
from .science import aft, combustor, exhaust, flame_speed, props

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("desktop-solver")

# Baked-in signing key — overridden at PyInstaller build time via CTK_BAKED_SIGNING_KEY env.
# In dev runs (plain `python -m app.desktop_main`) we read it from env so the same binary
# works against the dev Render instance.
_BAKED_SIGNING_KEY = os.environ.get("CTK_BAKED_SIGNING_KEY", "")

# Cantera is not thread-safe — serialize through a single worker.
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cantera-desktop")


def _run(fn, *a, **kw) -> Any:
    try:
        return _pool.submit(fn, *a, **kw).result(timeout=180)
    except Exception as e:  # noqa: BLE001
        log.exception("solver error: %s", e)
        raise HTTPException(status_code=500, detail=f"solver error: {e}") from e


# ---------- license verification ----------
def _verify_license_token(token: str) -> dict[str, Any]:
    """Parse a `<json>|<hex_hmac>` token, verify HMAC, check expiry. Raise HTTPException on failure."""
    if not _BAKED_SIGNING_KEY:
        raise HTTPException(status_code=500, detail="desktop build missing signing key")
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
    # Allow token via env for local dev; required via header otherwise.
    token = x_license_token or os.environ.get("CTK_LICENSE_TOKEN", "")
    return _verify_license_token(token)


# ---------- app factory ----------
def create_desktop_app() -> FastAPI:
    app = FastAPI(
        title="Combustion Toolkit — Desktop Solver",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
    )
    # Electron renders from file:// or http://localhost:<vite>; permissive CORS is fine on a loopback server.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok", cantera_version=ct.__version__, env="desktop", stripe_configured=False)

    @app.post("/calc/aft", response_model=AFTResponse)
    def calc_aft(body: AFTRequest, _lic=Depends(_license_dep)) -> AFTResponse:  # noqa: B008
        r = _run(
            aft.run, body.fuel, body.oxidizer, body.phi, body.T0, body.P,
            body.heat_loss_fraction if body.mode == "heat_loss" else 0.0,
        )
        return AFTResponse(**r)

    @app.post("/calc/flame-speed", response_model=FlameSpeedResponse)
    def calc_flame(body: FlameSpeedRequest, _lic=Depends(_license_dep)) -> FlameSpeedResponse:  # noqa: B008
        r = _run(flame_speed.run, body.fuel, body.oxidizer, body.phi, body.T0, body.P, body.domain_length_m)
        return FlameSpeedResponse(**r)

    @app.post("/calc/combustor", response_model=CombustorResponse)
    def calc_comb(body: CombustorRequest, _lic=Depends(_license_dep)) -> CombustorResponse:  # noqa: B008
        r = _run(
            combustor.run, body.fuel, body.oxidizer, body.phi, body.T0, body.P,
            body.tau_psr_s, body.L_pfr_m, body.V_pfr_m_s, body.profile_points,
        )
        return CombustorResponse(**r)

    @app.post("/calc/exhaust", response_model=ExhaustResponse)
    def calc_exh(body: ExhaustRequest, _lic=Depends(_license_dep)) -> ExhaustResponse:  # noqa: B008
        r = _run(
            exhaust.run, body.fuel, body.oxidizer, body.T0, body.P,
            body.measured_O2_pct_dry, body.measured_CO2_pct_dry, body.combustion_mode,
        )
        return ExhaustResponse(**r)

    @app.post("/calc/props", response_model=PropsResponse)
    def calc_props(body: PropsRequest, _lic=Depends(_license_dep)) -> PropsResponse:  # noqa: B008
        r = _run(props.run, body.mixture, body.T, body.P)
        return PropsResponse(**r)

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
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
