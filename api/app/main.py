"""FastAPI entry point for combustion-toolkit-api."""
from __future__ import annotations

import logging

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
    """On boot, flip is_admin=True for every pre-existing user whose email is in ADMIN_EMAILS.

    This means setting ADMIN_EMAILS in the Render dashboard + restarting is all
    that's needed to promote an already-registered account.
    """
    emails = settings.admin_emails_list
    if not emails:
        return
    from sqlalchemy.orm import Session
    from .models import User
    with Session(engine) as session:
        q = session.query(User).filter(User.email.in_(emails), User.is_admin.is_(False))
        updated = 0
        for u in q.all():
            u.is_admin = True
            updated += 1
        if updated:
            session.commit()
            log.info("promoted %d existing user(s) via ADMIN_EMAILS", updated)


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
