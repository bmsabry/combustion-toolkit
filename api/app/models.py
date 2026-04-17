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
    FREE = "free"
    DOWNLOAD = "download"  # $100/yr
    FULL = "full"  # $150/yr (download + online)


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
        """Only $150 tier (FULL) gets access to the online Cantera API."""
        return self.is_active and self.tier == SubscriptionTier.FULL

    @property
    def has_download_access(self) -> bool:
        """Both paid tiers get the downloadable desktop app."""
        return self.is_active and self.tier in (SubscriptionTier.DOWNLOAD, SubscriptionTier.FULL)


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
    max_activations: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
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
