"""Minimal Resend wrapper for transactional emails.

If RESEND_API_KEY is unset (dev), emails are logged at WARN level instead
of sent — the rest of the code path still works.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

log = logging.getLogger("combustion-toolkit-api.email")

RESEND_ENDPOINT = "https://api.resend.com/emails"


def send_email(
    *,
    to: str | list[str],
    subject: str,
    html: str,
    text: Optional[str] = None,
    from_email: Optional[str] = None,
    reply_to: Optional[str] = None,
) -> bool:
    """Send a transactional email via Resend. Returns True on success.

    Safe to call without RESEND_API_KEY set — falls back to a log line
    and returns False so the caller can surface a soft warning.
    """
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    if not api_key:
        log.warning("RESEND_API_KEY not set — email NOT sent. to=%s subject=%s", to, subject)
        return False

    sender = from_email or os.environ.get("RESEND_FROM_EMAIL", "ProReadyEngineer <noreply@proreadyengineer.com>")
    payload = {
        "from": sender,
        "to": to if isinstance(to, list) else [to],
        "subject": subject,
        "html": html,
    }
    if text:
        payload["text"] = text
    if reply_to:
        payload["reply_to"] = reply_to

    try:
        r = httpx.post(
            RESEND_ENDPOINT,
            json=payload,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=10.0,
        )
        if r.status_code >= 400:
            log.error("Resend send failed: %s %s", r.status_code, r.text[:300])
            return False
        log.info("Email sent to %s subject=%r id=%s", to, subject, r.json().get("id", "?"))
        return True
    except Exception as e:  # noqa: BLE001
        log.exception("Resend send raised: %s", e)
        return False
