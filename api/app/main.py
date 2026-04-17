"""FastAPI entry point for combustion-toolkit-api."""
from __future__ import annotations

import logging

import cantera as ct
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import Base, engine
from .routers import auth, billing, calc, desktop
from .schemas import HealthResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("combustion-toolkit-api")

settings = get_settings()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Combustion Toolkit API",
        version="0.1.0",
        description="Accurate Cantera-backed combustion calculations for paid subscribers. "
        "Free-tier users run approximate models client-side.",
        docs_url="/docs" if settings.env != "production" else None,
        redoc_url="/redoc" if settings.env != "production" else None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Routers
    app.include_router(auth.router)
    app.include_router(billing.router)
    app.include_router(calc.router)
    app.include_router(desktop.router)

    @app.get("/", response_model=HealthResponse)
    def root() -> HealthResponse:
        return HealthResponse(
            status="ok",
            cantera_version=ct.__version__,
            env=settings.env,
            stripe_configured=settings.stripe_configured,
        )

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            cantera_version=ct.__version__,
            env=settings.env,
            stripe_configured=settings.stripe_configured,
        )

    return app


# Ensure tables exist on module import (runs on Render boot and in tests).
# In production, Alembic migrations are preferred but this is a safe no-op if schema already exists.
try:
    Base.metadata.create_all(bind=engine)
    log.info("DB schema ensured")
except Exception as e:
    log.exception("DB schema init failed: %s", e)

app = create_app()
log.info(
    "combustion-toolkit-api ready: env=%s, cantera=%s, stripe_configured=%s",
    settings.env,
    ct.__version__,
    settings.stripe_configured,
)
