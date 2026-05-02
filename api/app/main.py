"""FastAPI entry point for combustion-toolkit-api."""
from __future__ import annotations

import logging
import os

import cantera as ct
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from sqlalchemy import text

from .config import get_settings
from .db import Base, engine
from .routers import admin, auth, billing, calc, desktop
from .schemas import HealthResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("combustion-toolkit-api")

settings = get_settings()

# ── Sentry (no-op when SENTRY_DSN unset, e.g. in dev / desktop loopback) ──
# Errors that bubble out of any endpoint are captured with stack + request
# context. Free tier (5K events / month) is plenty for our scale.
_SENTRY_DSN = os.environ.get("SENTRY_DSN", "").strip()
if _SENTRY_DSN:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
        sentry_sdk.init(
            dsn=_SENTRY_DSN,
            environment=settings.env,
            traces_sample_rate=0.05,                 # 5 % perf sampling
            send_default_pii=False,
            integrations=[FastApiIntegration(), StarletteIntegration()],
        )
        log.info("Sentry initialised (env=%s)", settings.env)
    except Exception as e:  # noqa: BLE001
        log.warning("Sentry init failed (continuing): %s", e)
else:
    log.info("Sentry disabled (SENTRY_DSN not set)")


# Fail fast in production if SECRET_KEY is still the development placeholder.
# The same key signs JWTs and (when LICENSE_SIGNING_KEY is unset) desktop
# license tokens — an unchanged default is a critical paywall/auth bypass.
if settings.env == "production" and settings.secret_key == "dev-insecure-change-me":
    raise RuntimeError(
        "SECRET_KEY must be set to a strong random value in production. "
        "Set it in the Render dashboard before starting the service."
    )


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

    # ── Rate limiter ─────────────────────────────────────────────────
    # The per-IP limiter lives inside routers.calc (no extra wiring
    # needed here — each endpoint that wants limiting takes a tiny
    # FastAPI Depends(...) that does the bucket bookkeeping and raises
    # 429 directly. See `_rate_limit` in routers/calc.py.

    # Routers
    app.include_router(auth.router)
    app.include_router(billing.router)
    app.include_router(calc.router)
    app.include_router(desktop.router)
    app.include_router(admin.router)

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


def _migrate_add_is_admin() -> None:
    """Idempotent startup migration — add users.is_admin if missing.

    create_all() only creates tables, it doesn't add new columns to existing ones.
    This runs a portable `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on Postgres
    and falls back to a try/except for SQLite, which lacks IF NOT EXISTS for
    columns.
    """
    dialect = engine.dialect.name  # 'postgresql' or 'sqlite'
    with engine.begin() as conn:
        try:
            if dialect == "postgresql":
                conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE"))
            else:
                # SQLite
                cols = {row[1] for row in conn.execute(text("PRAGMA table_info(users)"))}
                if "is_admin" not in cols:
                    conn.execute(text("ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0"))
            log.info("is_admin column verified on users table")
        except Exception as exc:  # noqa: BLE001
            log.warning("is_admin migration skipped: %s", exc)


try:
    _migrate_add_is_admin()
except Exception as e:  # noqa: BLE001
    log.exception("is_admin migration failed: %s", e)


def _sync_admin_emails() -> None:
    """On boot, force is_admin=True for every user whose email is in ADMIN_EMAILS.

    Re-asserts on every restart (no `is_admin.is_(False)` filter), so if the flag
    somehow gets flipped to False between deploys, the next boot heals it. The
    per-request self-heal in deps._self_heal_admin is the other half of this defense.
    """
    emails = settings.admin_emails_list
    if not emails:
        return
    from sqlalchemy.orm import Session
    from .models import User
    with Session(engine) as session:
        q = session.query(User).filter(User.email.in_(emails))
        updated = 0
        for u in q.all():
            if not u.is_admin:
                u.is_admin = True
                updated += 1
        if updated:
            session.commit()
            log.info("re-asserted is_admin=True for %d user(s) via ADMIN_EMAILS", updated)


try:
    _sync_admin_emails()
except Exception as e:  # noqa: BLE001
    log.exception("admin email sync failed: %s", e)

app = create_app()
log.info(
    "combustion-toolkit-api ready: env=%s, cantera=%s, stripe_configured=%s",
    settings.env,
    ct.__version__,
    settings.stripe_configured,
)
