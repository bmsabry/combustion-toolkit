"""Desktop license activation endpoint.

The desktop app calls POST /desktop/activate with the license key + machine ID.
Returns a signed offline token the app stores locally and validates on launch.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import LicenseKey
from ..schemas import LicenseActivateRequest, LicenseActivateResponse
from ..security import hash_license_key, sign_license_payload

router = APIRouter(prefix="/desktop", tags=["desktop"])


@router.post("/activate", response_model=LicenseActivateResponse)
def activate(body: LicenseActivateRequest, db: Session = Depends(get_db)) -> LicenseActivateResponse:
    kh = hash_license_key(body.key.strip())
    lk = db.query(LicenseKey).filter(LicenseKey.key_hash == kh).first()
    if not lk or lk.revoked:
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

    # Build signed offline token
    payload = {
        "license_id": lk.id,
        "tier": lk.tier.value,
        "expires_at": lk.expires_at.isoformat(),
        "device_id": body.device_id,
        "activated_at": now.isoformat(),
    }
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    signature = sign_license_payload(payload_json)
    signed_token = f"{payload_json}|{signature}"

    return LicenseActivateResponse(
        valid=True,
        tier=lk.tier.value,
        expires_at=lk.expires_at,
        signed_token=signed_token,
        message="Activated successfully",
    )
