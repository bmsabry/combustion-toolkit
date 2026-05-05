"""Admin endpoints — promote a user to admin (free lifetime access) and mint
desktop license keys, both gated by a shared secret.

Usage:
    curl -X POST https://combustion-toolkit-api.onrender.com/admin/promote \
         -H "X-Admin-Secret: <ADMIN_SECRET>" \
         -H "Content-Type: application/json" \
         -d '{"email": "you@example.com"}'

    curl -X POST https://combustion-toolkit-api.onrender.com/admin/issue-license \
         -H "X-Admin-Secret: <ADMIN_SECRET>" \
         -H "Content-Type: application/json" \
         -d '{"email": "you@example.com", "tier": "everything", "days": 365}'

The ADMIN_SECRET env var must be set on the service. If unset, both endpoints
return 503 so the feature is off by default.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import LicenseKey, SubscriptionTier, User
from ..security import generate_license_key, hash_license_key

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


# ── Issue desktop license key (admin-only) ─────────────────────────────────
class IssueLicenseRequest(BaseModel):
    email: EmailStr
    tier: str = Field(default="everything", pattern="^(free|ctk|gts|everything|download|full)$")
    days: int = Field(default=365, ge=1, le=3650)
    max_activations: int = Field(default=2, ge=1, le=10)


class IssueLicenseResponse(BaseModel):
    email: str
    tier: str
    expires_at: datetime
    license_key: str  # PLAINTEXT — shown to admin once, then only the hash is stored
    max_activations: int
    message: str


@router.post("/issue-license", response_model=IssueLicenseResponse)
def issue_license(
    body: IssueLicenseRequest,
    request: Request,
    db: Session = Depends(get_db),
    _: None = Depends(_require_secret),
) -> IssueLicenseResponse:
    """Mint a desktop license key for a user. The plaintext key is returned
    in the response — only the hash is persisted. The admin must give the
    plaintext key to the user (e.g. via email) since it can't be recovered.
    """
    remote_ip = (request.client.host if request.client else "unknown") or "unknown"
    user = db.query(User).filter(User.email == body.email.lower()).first()
    if not user:
        log.warning("admin.issue-license missed email=%s ip=%s", body.email, remote_ip)
        raise HTTPException(status_code=404, detail=f"No user with email '{body.email}'")
    try:
        tier = SubscriptionTier(body.tier)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Unknown tier '{body.tier}'")

    plain_key = generate_license_key()
    now = datetime.now(timezone.utc)
    lk = LicenseKey(
        user_id=user.id,
        key_hash=hash_license_key(plain_key),
        key_prefix=plain_key[:8],
        tier=tier,
        issued_at=now,
        expires_at=now + timedelta(days=body.days),
        max_activations=body.max_activations,
    )
    db.add(lk)
    db.commit()

    log.warning(
        "admin.issue-license email=%s tier=%s days=%d max_activations=%d ip=%s key_prefix=%s",
        user.email, tier.value, body.days, body.max_activations, remote_ip, plain_key[:8],
    )

    return IssueLicenseResponse(
        email=user.email,
        tier=tier.value,
        expires_at=lk.expires_at,
        license_key=plain_key,
        max_activations=body.max_activations,
        message=f"License issued (valid for {body.days} days, {body.max_activations} activations)",
    )
