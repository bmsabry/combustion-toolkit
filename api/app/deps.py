"""FastAPI dependencies for auth + subscription gating."""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import SubscriptionTier, User
from .security import decode_token

log = logging.getLogger("deps")


def _bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None


def _self_heal_admin(user: User, db: Session) -> None:
    """If the user's email is in ADMIN_EMAILS, ensure is_admin=True on every request.

    Belt-and-suspenders against the recurring bug where bmsabry@gmail.com loses the
    Accurate Mode toggle because is_admin somehow gets flipped to False between deploys.
    The boot-time _sync_admin_emails only runs once and only handles False→True for
    pre-existing rows; this catches drift on every authenticated call.
    """
    try:
        admin_emails = get_settings().admin_emails_list
        if not admin_emails:
            return
        if user.email and user.email.lower() in admin_emails and not user.is_admin:
            user.is_admin = True
            db.commit()
            log.warning("self-healed is_admin=True for %s on authenticated request", user.email)
    except Exception as exc:  # noqa: BLE001
        # Never let a self-heal failure break authentication.
        log.exception("admin self-heal failed for %s: %s", getattr(user, "email", "?"), exc)


def get_current_user(
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    token = _bearer(authorization)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token")
    user = db.get(User, payload.get("sub"))
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="user not found or inactive")
    _self_heal_admin(user, db)
    return user


def get_current_user_optional(
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> Optional[User]:
    token = _bearer(authorization)
    if not token:
        return None
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        return None
    user = db.get(User, payload.get("sub"))
    if user:
        _self_heal_admin(user, db)
    return user


def require_full_subscription(user: User = Depends(get_current_user)) -> User:
    if user.is_admin:
        return user
    sub = user.subscription
    if not sub or not sub.has_online_access:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="This endpoint requires the 'Download + Online' subscription tier ($150/yr).",
        )
    return user


def require_any_paid(user: User = Depends(get_current_user)) -> User:
    if user.is_admin:
        return user
    sub = user.subscription
    if not sub or not sub.is_active:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="An active subscription is required.",
        )
    return user



def get_admin_user(user: User = Depends(get_current_user)) -> User:
    """Gate an endpoint to admins only (is_admin=True). Used by the learning
    instructor panel and any other admin-facing routes."""
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return user
