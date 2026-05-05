"""Desktop license activation endpoint.

The desktop app calls POST /desktop/activate with the license key + machine ID.
Returns a signed offline token the app stores locally and validates on launch.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import LicenseKey, normalize_tier, tier_features
from ..schemas import LicenseActivateRequest, LicenseActivateResponse
from ..security import hash_license_key, sign_license_payload_ed25519

log = logging.getLogger("combustion-toolkit-api.desktop")

router = APIRouter(prefix="/desktop", tags=["desktop"])

# In-process per-IP rate limit for /desktop/activate. The desktop activation
# flow is offline-brute-forceable in principle (someone could test keys against
# the public endpoint until one hits). Cap at RATE_MAX attempts per
# RATE_WINDOW_S per remote IP; after that, respond 429 for the rest of the
# window. Bucket: deque of recent attempt timestamps.
_RATE_MAX = 10
_RATE_WINDOW_S = 60 * 60  # 1 hour
_rate_lock = threading.Lock()
_rate_buckets: dict[str, deque[float]] = defaultdict(deque)


def _rate_limit_check(remote_ip: str) -> None:
    now = time.monotonic()
    with _rate_lock:
        bucket = _rate_buckets[remote_ip]
        while bucket and (now - bucket[0]) > _RATE_WINDOW_S:
            bucket.popleft()
        if len(bucket) >= _RATE_MAX:
            retry_s = int(_RATE_WINDOW_S - (now - bucket[0]))
            log.warning(
                "desktop.activate rate-limit hit ip=%s attempts_in_window=%d retry_after=%ds",
                remote_ip, len(bucket), retry_s,
            )
            raise HTTPException(
                status_code=429,
                detail=f"Too many activation attempts. Try again in {max(60, retry_s)} seconds.",
            )
        bucket.append(now)


@router.post("/activate", response_model=LicenseActivateResponse)
def activate(
    body: LicenseActivateRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> LicenseActivateResponse:
    remote_ip = (request.client.host if request.client else "unknown") or "unknown"
    _rate_limit_check(remote_ip)

    kh = hash_license_key(body.key.strip())
    lk = db.query(LicenseKey).filter(LicenseKey.key_hash == kh).first()
    if not lk or lk.revoked:
        log.info("desktop.activate miss ip=%s reason=%s", remote_ip, "revoked" if lk else "not_found")
        raise HTTPException(status_code=404, detail="Invalid or revoked license key")
    now = datetime.now(timezone.utc)
    if lk.expires_at.replace(tzinfo=timezone.utc) if lk.expires_at.tzinfo is None else lk.expires_at < now:
        raise HTTPException(status_code=410, detail="License key expired")
    if lk.activation_count >= lk.max_activations:
        raise HTTPException(
            status_code=403,
            detail=f"License reached max activations ({lk.max_activations}). Revoke from account page.",
        )
    lk.activation_count += 1
    lk.last_activation_at = now
    lk.last_activation_device = body.device_id
    db.commit()
    log.info(
        "desktop.activate success license_id=%s tier=%s device=%s ip=%s count=%d/%d",
        lk.id, lk.tier.value, body.device_id, remote_ip, lk.activation_count, lk.max_activations,
    )

    # Build signed offline token. Tier is normalized so legacy DOWNLOAD/FULL
    # rows still produce a current-model JWT (CTK / EVERYTHING). The
    # `features` claim is the source of truth for which panels the desktop
    # binary unlocks — changing tier composition becomes a server-side
    # change with no rebuild needed.
    eff_tier = normalize_tier(lk.tier)
    payload = {
        "license_id": lk.id,
        "tier": eff_tier.value,
        "features": tier_features(eff_tier),
        "expires_at": lk.expires_at.isoformat(),
        "device_id": body.device_id,
        "activated_at": now.isoformat(),
        "max_activations": lk.max_activations,
        "activation_count": lk.activation_count,
        "sig_alg": "ed25519",
    }
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    signature = sign_license_payload_ed25519(payload_json)
    signed_token = f"{payload_json}|{signature}"

    return LicenseActivateResponse(
        valid=True,
        tier=eff_tier.value,
        expires_at=lk.expires_at,
        signed_token=signed_token,
        message="Activated successfully",
    )
