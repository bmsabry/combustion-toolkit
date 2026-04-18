"""Admin endpoints — promote a user to admin (free lifetime access) via shared secret.

Usage:
    curl -X POST https://combustion-toolkit-api.onrender.com/admin/promote \
         -H "X-Admin-Secret: <ADMIN_SECRET>" \
         -H "Content-Type: application/json" \
         -d '{"email": "you@example.com"}'

The ADMIN_SECRET env var must be set on the service. If unset, this endpoint
returns 503 so the feature is off by default.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import User

log = logging.getLogger("combustion-toolkit-api.admin")

router = APIRouter(prefix="/admin", tags=["admin"])
settings = get_settings()


class PromoteRequest(BaseModel):
    email: EmailStr
    admin: bool = True  # set False to revoke


class PromoteResponse(BaseModel):
    email: str
    is_admin: bool
    message: str


def _require_secret(x_admin_secret: str | None = Header(default=None)) -> None:
    if not settings.admin_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Admin promotion is disabled (ADMIN_SECRET env var not set).",
        )
    if not x_admin_secret or x_admin_secret != settings.admin_secret:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Admin-Secret header.",
        )


@router.post("/promote", response_model=PromoteResponse)
def promote_user(
    body: PromoteRequest,
    request: Request,
    db: Session = Depends(get_db),
    _: None = Depends(_require_secret),
) -> PromoteResponse:
    remote_ip = (request.client.host if request.client else "unknown") or "unknown"
    user = db.query(User).filter(User.email == body.email.lower()).first()
    if not user:
        log.warning("admin.promote missed email=%s ip=%s", body.email, remote_ip)
        raise HTTPException(status_code=404, detail=f"No user with email '{body.email}'")
    before = bool(user.is_admin)
    after = bool(body.admin)
    user.is_admin = after
    db.commit()
    # Structured audit line — lets Render/grep spot ADMIN_SECRET leaks after the fact.
    log.warning(
        "admin.promote email=%s before=%s after=%s ip=%s action=%s",
        user.email, before, after, remote_ip,
        "promoted" if after else "revoked",
    )
    return PromoteResponse(
        email=user.email,
        is_admin=user.is_admin,
        message="promoted" if user.is_admin else "revoked",
    )
