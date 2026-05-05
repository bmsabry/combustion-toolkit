"""Password hashing and JWT token utilities."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import bcrypt
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric import ed25519
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
    """LEGACY HMAC signer — kept so existing license files still verify until
    they expire. Returns hex-encoded HMAC-SHA256. New tokens should use
    sign_license_payload_ed25519() below.
    """
    signing_key = settings.license_signing_key or settings.secret_key
    return hmac.new(signing_key.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


# ── Ed25519 license signing (current — anti-piracy) ────────────────────────
# Private key signs on the server; public key verifies on the desktop. Only
# the public key is baked into the binary, so extracting it from the
# installed app gives an attacker no ability to forge tokens. Token format:
#     {payload_json}|{base64_signature}
# Same on-the-wire shape as the HMAC tokens, so we can keep the parser in
# desktop/main.js identical.

def _ed25519_private_key() -> Optional[ed25519.Ed25519PrivateKey]:
    raw = settings.ed25519_private_key_b64.strip()
    if not raw:
        return None
    try:
        return ed25519.Ed25519PrivateKey.from_private_bytes(base64.b64decode(raw))
    except Exception:
        return None


def _ed25519_public_key() -> Optional[ed25519.Ed25519PublicKey]:
    raw = settings.ed25519_public_key_b64.strip()
    if not raw:
        return None
    try:
        return ed25519.Ed25519PublicKey.from_public_bytes(base64.b64decode(raw))
    except Exception:
        return None


def sign_license_payload_ed25519(payload: str) -> str:
    """Sign a payload with the Ed25519 private key. Returns base64 signature.
    Raises if the private key isn't configured (server misconfig).
    """
    pk = _ed25519_private_key()
    if pk is None:
        raise RuntimeError(
            "Ed25519 private key not configured. Set CTK_ED25519_PRIVATE_KEY_B64 "
            "env var on the backend."
        )
    sig = pk.sign(payload.encode("utf-8"))
    return base64.b64encode(sig).decode("ascii")


def verify_license_payload_ed25519(payload: str, signature_b64: str) -> bool:
    """Verify an Ed25519 signature against the public key. Used by the
    desktop solver process when it boots so the local FastAPI confirms
    the license token wasn't tampered with."""
    pub = _ed25519_public_key()
    if pub is None:
        return False
    try:
        pub.verify(base64.b64decode(signature_b64), payload.encode("utf-8"))
        return True
    except (InvalidSignature, Exception):
        return False
