"""Stripe subscription endpoints: create checkout session, customer portal, webhook."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import stripe
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..deps import get_current_user
from ..models import (
    LicenseKey,
    Subscription,
    SubscriptionStatus,
    SubscriptionTier,
    User,
)
from ..schemas import (
    CheckoutRequest,
    CheckoutResponse,
    LicenseKeyOut,
    LicenseKeyWithValue,
    PortalResponse,
    SubscriptionOut,
)
from ..security import generate_license_key, hash_license_key

log = logging.getLogger("billing")
router = APIRouter(prefix="/billing", tags=["billing"])
settings = get_settings()

if settings.stripe_secret_key:
    stripe.api_key = settings.stripe_secret_key


TIER_TO_PRICE = {
    SubscriptionTier.DOWNLOAD: lambda: settings.stripe_price_id_download,
    SubscriptionTier.FULL: lambda: settings.stripe_price_id_full,
}


@router.get("/subscription", response_model=SubscriptionOut)
def get_subscription(user: User = Depends(get_current_user)) -> SubscriptionOut:
    # Admins get a synthetic "admin" tier that unlocks everything regardless of
    # the underlying Stripe subscription state. Defense-in-depth: also treat any
    # email currently listed in ADMIN_EMAILS as admin, even if user.is_admin happens
    # to be False (the per-request self-heal in deps will already have flipped it
    # back, but this keeps the symptom from ever reaching the UI).
    if user.is_admin or (user.email and user.email.lower() in settings.admin_emails_list):
        return SubscriptionOut(
            tier="admin",
            status="active",
            current_period_end=None,
            cancel_at_period_end=False,
            has_online_access=True,
            has_download_access=True,
        )
    sub = user.subscription
    if not sub:
        return SubscriptionOut(
            tier="free",
            status="inactive",
            current_period_end=None,
            cancel_at_period_end=False,
            has_online_access=False,
            has_download_access=False,
        )
    return SubscriptionOut(
        tier=sub.tier.value,
        status=sub.status.value,
        current_period_end=sub.current_period_end,
        cancel_at_period_end=sub.cancel_at_period_end,
        has_online_access=sub.has_online_access,
        has_download_access=sub.has_download_access,
    )


@router.post("/checkout", response_model=CheckoutResponse)
def create_checkout(
    body: CheckoutRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CheckoutResponse:
    if not settings.stripe_configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Payments are not yet configured. Please contact sales@proreadyengineer.com.",
        )

    tier = SubscriptionTier(body.tier)
    price_id = TIER_TO_PRICE[tier]()
    if not price_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Price ID for {tier.value} is not yet set in Render env vars.",
        )

    # Ensure Stripe customer exists
    if not user.stripe_customer_id:
        customer = stripe.Customer.create(email=user.email, metadata={"user_id": user.id})
        user.stripe_customer_id = customer.id
        db.commit()

    session = stripe.checkout.Session.create(
        customer=user.stripe_customer_id,
        payment_method_types=["card"],
        line_items=[{"price": price_id, "quantity": 1}],
        mode="subscription",
        success_url=f"{settings.frontend_url}/billing/success?session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{settings.frontend_url}/billing/canceled",
        client_reference_id=user.id,
        metadata={"user_id": user.id, "tier": tier.value},
        subscription_data={"metadata": {"user_id": user.id, "tier": tier.value}},
    )
    return CheckoutResponse(checkout_url=session.url, session_id=session.id)


@router.get("/portal", response_model=PortalResponse)
def customer_portal(user: User = Depends(get_current_user)) -> PortalResponse:
    if not settings.stripe_configured or not user.stripe_customer_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No Stripe customer exists for this user yet.",
        )
    session = stripe.billing_portal.Session.create(
        customer=user.stripe_customer_id,
        return_url=f"{settings.frontend_url}/account",
    )
    return PortalResponse(portal_url=session.url)


@router.get("/license-keys", response_model=list[LicenseKeyOut])
def list_license_keys(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[LicenseKeyOut]:
    keys = db.query(LicenseKey).filter(LicenseKey.user_id == user.id).all()
    return [LicenseKeyOut.model_validate(k) for k in keys]


@router.post("/license-keys/generate", response_model=LicenseKeyWithValue)
def generate_new_license(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LicenseKeyWithValue:
    sub = user.subscription
    if not user.is_admin and (not sub or not sub.has_download_access):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="An active subscription with download access is required.",
        )
    # Admins: use FULL tier with a generous 1-year expiry.
    tier = SubscriptionTier.FULL if user.is_admin else sub.tier
    default_expiry = datetime.now(timezone.utc) + timedelta(days=365)
    sub_expiry = sub.current_period_end if sub else None
    key = generate_license_key()
    lk = LicenseKey(
        user_id=user.id,
        key_hash=hash_license_key(key),
        key_prefix=key[:8],
        tier=tier,
        expires_at=sub_expiry or default_expiry,
    )
    db.add(lk)
    db.commit()
    db.refresh(lk)
    out = LicenseKeyWithValue.model_validate(lk).model_copy(update={"key": key})
    return out


@router.post("/webhook", include_in_schema=False)
async def stripe_webhook(
    request: Request,
    stripe_signature: str = Header(default=""),
    db: Session = Depends(get_db),
):
    if not settings.stripe_configured:
        raise HTTPException(status_code=503, detail="stripe not configured")

    payload = await request.body()
    try:
        event = stripe.Webhook.construct_event(
            payload=payload,
            sig_header=stripe_signature,
            secret=settings.stripe_webhook_secret,
        )
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid payload")
    except stripe.error.SignatureVerificationError:
        raise HTTPException(status_code=400, detail="Invalid signature")

    etype = event["type"]
    data = event["data"]["object"]

    if etype == "checkout.session.completed":
        user_id = data.get("client_reference_id") or (data.get("metadata") or {}).get("user_id")
        tier_str = (data.get("metadata") or {}).get("tier", "download")
        subscription_id = data.get("subscription")
        _activate_subscription(db, user_id, tier_str, subscription_id)

    elif etype == "customer.subscription.updated" or etype == "invoice.paid":
        sub_id = data.get("subscription") if etype == "invoice.paid" else data.get("id")
        if sub_id:
            try:
                sub_obj = stripe.Subscription.retrieve(sub_id)
                user_id = (sub_obj.metadata or {}).get("user_id")
                tier_str = (sub_obj.metadata or {}).get("tier", "download")
                _update_from_stripe(db, user_id, sub_obj)
            except Exception as e:
                log.exception("failed to sync subscription: %s", e)

    elif etype == "customer.subscription.deleted":
        user_id = (data.get("metadata") or {}).get("user_id")
        if user_id:
            _cancel_subscription(db, user_id)

    return {"received": True}


def _activate_subscription(db: Session, user_id: str, tier_str: str, stripe_sub_id: str | None):
    user = db.get(User, user_id)
    if not user:
        return
    sub = user.subscription
    if not sub:
        sub = Subscription(user_id=user.id)
        db.add(sub)
    sub.tier = SubscriptionTier(tier_str)
    sub.status = SubscriptionStatus.ACTIVE
    sub.stripe_subscription_id = stripe_sub_id
    if stripe_sub_id:
        try:
            sub_obj = stripe.Subscription.retrieve(stripe_sub_id)
            sub.current_period_end = datetime.fromtimestamp(sub_obj.current_period_end, tz=timezone.utc)
        except Exception:
            sub.current_period_end = datetime.now(timezone.utc) + timedelta(days=365)
    db.commit()


def _update_from_stripe(db: Session, user_id: str | None, sub_obj):
    if not user_id:
        return
    user = db.get(User, user_id)
    if not user or not user.subscription:
        return
    sub = user.subscription
    sub.stripe_subscription_id = sub_obj.id
    sub.status = {
        "active": SubscriptionStatus.ACTIVE,
        "past_due": SubscriptionStatus.PAST_DUE,
        "canceled": SubscriptionStatus.CANCELED,
    }.get(sub_obj.status, SubscriptionStatus.INACTIVE)
    sub.current_period_end = datetime.fromtimestamp(sub_obj.current_period_end, tz=timezone.utc)
    sub.cancel_at_period_end = bool(sub_obj.cancel_at_period_end)
    db.commit()


def _cancel_subscription(db: Session, user_id: str):
    user = db.get(User, user_id)
    if not user or not user.subscription:
        return
    user.subscription.status = SubscriptionStatus.CANCELED
    user.subscription.tier = SubscriptionTier.FREE
    db.commit()
