"""Password hashing and JWT token utilities."""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import bcrypt
from jose import JWTError, jwt

from .config import get_settings

settings = get_settings()

_ALGO = "HS256"


# ---------- passwords ----------
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except Exception:
        return False


# ---------- JWT ----------
def _encode(payload: dict[str, Any]) -> str:
    return jwt.encode(payload, settings.secret_key, algorithm=_ALGO)


def create_access_token(sub: str, extra: Optional[dict[str, Any]] = None) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": sub,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.access_token_expire_minutes)).timestamp()),
        "type": "access",
    }
    if extra:
        payload.update(extra)
    return _encode(payload)


def create_refresh_token(sub: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": sub,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=settings.refresh_token_expire_days)).timestamp()),
        "type": "refresh",
    }
    return _encode(payload)


def decode_token(token: str) -> Optional[dict[str, Any]]:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[_ALGO])
    except JWTError:
        return None


# ---------- license keys ----------
def generate_license_key() -> str:
    """Generates a 24-char license key like XXXX-XXXX-XXXX-XXXX-XXXX-XXXX."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no ambiguous chars
    raw = "".join(secrets.choice(alphabet) for _ in range(24))
    return "-".join(raw[i : i + 4] for i in range(0, 24, 4))


def hash_license_key(key: str) -> str:
    """Deterministic hash for DB lookup. Uses HMAC-SHA256 with settings.secret_key."""
    return hmac.new(
        settings.secret_key.encode("utf-8"),
        key.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def sign_license_payload(payload: str) -> str:
    """Sign a payload with the license signing key (for offline validation in desktop app)."""
    signing_key = settings.license_signing_key or settings.secret_key
    return hmac.new(signing_key.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
