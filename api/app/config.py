"""Application configuration from environment variables."""
from __future__ import annotations

from functools import lru_cache
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All settings loaded from env vars. See Render dashboard for production values."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    # App
    env: str = Field(default="development")
    debug: bool = Field(default=False)
    log_level: str = Field(default="INFO")

    # Security
    secret_key: str = Field(default="dev-insecure-change-me")
    access_token_expire_minutes: int = Field(default=60 * 24)  # 24 hours
    refresh_token_expire_days: int = Field(default=30)

    # Database
    database_url: str = Field(default="sqlite:///./ctk.db")

    # Frontend
    frontend_url: str = Field(default="http://localhost:5173")
    backend_cors_origins: str = Field(
        default="http://localhost:5173,https://combustion-toolkit.proreadyengineer.com"
    )

    # Stripe
    stripe_secret_key: str = Field(default="")
    stripe_publishable_key: str = Field(default="")
    stripe_webhook_secret: str = Field(default="")
    stripe_price_id_download: str = Field(default="")  # $100/yr download tier
    stripe_price_id_full: str = Field(default="")  # $150/yr download + online tier

    # Desktop license signing
    # ── Legacy HMAC (kept so old offline tokens still verify until they expire) ──
    license_signing_key: str = Field(default="")  # HMAC secret — DEPRECATED
    # ── Current: Ed25519 (anti-piracy upgrade) ──
    # Private key (server-only, base64-encoded raw 32 bytes) signs license tokens.
    # Public key (committed to repo + baked into desktop binary) verifies them.
    # An attacker who extracts the public key from the binary cannot forge tokens.
    ed25519_private_key_b64: str = Field(default="")  # raw 32-byte private key, b64
    ed25519_public_key_b64: str = Field(
        # Default = the production public key, committed to the repo. Override
        # via env var only for testing with a different keypair.
        default="/sUDVHHr3jNFwzG0TNcTYRkzDwEs5HlzU4mejzau2zI="
    )

    # Admin (free lifetime access, bypasses the Stripe gate)
    admin_emails: str = Field(default="")  # comma-separated list; auto-promoted on signup/login
    admin_secret: str = Field(default="")  # shared secret for /admin/promote runtime endpoint


    # Transactional email (Resend) — used for learning-module invitations
    resend_api_key: str = Field(default="")
    resend_from_email: str = Field(default="ProReadyEngineer <noreply@proreadyengineer.com>")
    instructor_contact_email: str = Field(default="info@proreadyengineer.com")

    @property
    def cors_origins_list(self) -> List[str]:
        return [o.strip() for o in self.backend_cors_origins.split(",") if o.strip()]

    @property
    def admin_emails_list(self) -> List[str]:
        return [e.strip().lower() for e in self.admin_emails.split(",") if e.strip()]

    @property
    def stripe_configured(self) -> bool:
        return bool(self.stripe_secret_key) and bool(self.stripe_publishable_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
