"""SQLAlchemy ORM models."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class SubscriptionTier(str, enum.Enum):
    """Subscription tiers — 1:1 mapping to the 4 application modes in the UI.

    Internal IDs match the existing `mode` strings used everywhere in App.jsx
    so we don't have to remap on every read. Legacy values (DOWNLOAD, FULL)
    are kept so existing rows in the DB stay valid; new rows should use the
    new IDs only. Map legacy → new in tier_features() below.
    """
    # Current 4-tier model (matches App.jsx mode IDs)
    FREE = "free"
    CTK = "ctk"             # Combustion Toolkit
    GTS = "gts"             # Gas Turbine Simulator
    EVERYTHING = "everything"  # Advanced — all panels

    # Legacy aliases (kept for backward compat with rows issued under the
    # old 3-tier model: free / download / full). The activation handler
    # maps these to the closest new tier when issuing offline tokens.
    DOWNLOAD = "download"   # legacy → maps to CTK
    FULL = "full"           # legacy → maps to EVERYTHING


# Tier → feature map (which panels are unlocked). Lives next to the enum so
# the desktop activation handler can stamp this list into the signed token,
# and the desktop binary doesn't need a hardcoded copy of the matrix — it
# just gates panels off the JWT's "features" claim. Changing tier
# composition becomes a server-side config change with no rebuild.
def tier_features(tier: "SubscriptionTier") -> list[str]:
    """Return the list of panel IDs unlocked by a given tier.
    Panel IDs match the `id` field of NAV_TABS in App.jsx.
    """
    if tier in (SubscriptionTier.EVERYTHING, SubscriptionTier.FULL):
        # Advanced — every panel
        return ["summary", "cycle", "mapping", "aft", "exhaust",
                "combustor", "flame", "automate"]
    if tier == SubscriptionTier.GTS:
        # Gas Turbine Simulator — engine-side panels
        return ["summary", "cycle", "mapping", "exhaust"]
    if tier in (SubscriptionTier.CTK, SubscriptionTier.DOWNLOAD):
        # Combustion Toolkit — combustion-physics panels
        return ["aft", "exhaust", "combustor", "flame", "automate"]
    # FREE — basic combustion panels only
    return ["aft", "exhaust", "combustor"]


def normalize_tier(tier: "SubscriptionTier") -> "SubscriptionTier":
    """Map legacy tier values to their new-model equivalents.
    Used by the activation handler so the JWT always carries a current
    tier ID even if the LicenseKey row was issued under the old enum.
    """
    if tier == SubscriptionTier.DOWNLOAD:
        return SubscriptionTier.CTK
    if tier == SubscriptionTier.FULL:
        return SubscriptionTier.EVERYTHING
    return tier


class SubscriptionStatus(str, enum.Enum):
    INACTIVE = "inactive"
    ACTIVE = "active"
    PAST_DUE = "past_due"
    CANCELED = "canceled"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    stripe_customer_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )

    subscription: Mapped[Optional["Subscription"]] = relationship(
        back_populates="user", uselist=False, cascade="all, delete-orphan"
    )
    licenses: Mapped[list["LicenseKey"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Subscription(Base):
    __tablename__ = "subscriptions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), unique=True, nullable=False)
    stripe_subscription_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True, index=True)
    tier: Mapped[SubscriptionTier] = mapped_column(
        Enum(SubscriptionTier), default=SubscriptionTier.FREE, nullable=False
    )
    status: Mapped[SubscriptionStatus] = mapped_column(
        Enum(SubscriptionStatus), default=SubscriptionStatus.INACTIVE, nullable=False
    )
    current_period_end: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    cancel_at_period_end: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )

    user: Mapped["User"] = relationship(back_populates="subscription")

    @property
    def is_active(self) -> bool:
        return self.status == SubscriptionStatus.ACTIVE and self.tier != SubscriptionTier.FREE

    @property
    def has_online_access(self) -> bool:
        """The "Everything" tier (and legacy FULL) get full online Cantera API
        access. Other paid tiers get only the panels their tier covers."""
        return self.is_active and self.tier in (
            SubscriptionTier.EVERYTHING, SubscriptionTier.FULL,
        )

    @property
    def has_download_access(self) -> bool:
        """Every paid tier gets the downloadable desktop app — features inside
        are gated by the tier claim baked into the issued license token."""
        return self.is_active and self.tier in (
            SubscriptionTier.CTK, SubscriptionTier.GTS, SubscriptionTier.EVERYTHING,
            SubscriptionTier.DOWNLOAD, SubscriptionTier.FULL,  # legacy
        )


class LicenseKey(Base):
    """Offline license key for activating the desktop app."""

    __tablename__ = "license_keys"
    __table_args__ = (Index("ix_license_keys_key_hash", "key_hash"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    key_hash: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    key_prefix: Mapped[str] = mapped_column(String(16), nullable=False)  # first 8 chars, for display
    tier: Mapped[SubscriptionTier] = mapped_column(Enum(SubscriptionTier), nullable=False)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    activation_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_activations: Mapped[int] = mapped_column(Integer, default=2, nullable=False)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_activation_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_activation_device: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    user: Mapped["User"] = relationship(back_populates="licenses")


class ApiUsage(Base):
    """Lightweight per-user usage counter for rate limiting & analytics."""

    __tablename__ = "api_usage"
    __table_args__ = (Index("ix_api_usage_user_endpoint_date", "user_id", "endpoint", "date"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    endpoint: Mapped[str] = mapped_column(String(64), nullable=False)
    date: Mapped[str] = mapped_column(String(10), nullable=False)  # YYYY-MM-DD
    count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
