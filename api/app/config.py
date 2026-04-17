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
    license_signing_key: str = Field(default="")  # HMAC secret for offline license validation

    @property
    def cors_origins_list(self) -> List[str]:
        return [o.strip() for o in self.backend_cors_origins.split(",") if o.strip()]

    @property
    def stripe_configured(self) -> bool:
        return bool(self.stripe_secret_key) and bool(self.stripe_publishable_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
