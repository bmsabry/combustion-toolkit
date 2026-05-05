"""Auth endpoints: signup, login, refresh, me."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..deps import get_current_user
from ..models import LicenseKey, Subscription, SubscriptionStatus, SubscriptionTier, User
from ..schemas import LoginRequest, RefreshRequest, SignupRequest, TokenResponse, UserOut
from ..security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    generate_license_key,
    hash_license_key,
    hash_password,
    verify_password,
)

# Trial config — every new signup gets a 14-day Everything-tier license so the
# user can try the full desktop without paying. After expiry the desktop binary
# locks and the web app falls back to FREE-tier panels.
_TRIAL_DAYS = 14
_TRIAL_TIER = SubscriptionTier.EVERYTHING
_TRIAL_MAX_ACTIVATIONS = 2  # matches paid licenses

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()


def _token_response(user_id: str) -> TokenResponse:
    return TokenResponse(
        access_token=create_access_token(user_id),
        refresh_token=create_refresh_token(user_id),
        expires_in=settings.access_token_expire_minutes * 60,
    )


def _maybe_promote_admin(user: User) -> bool:
    """If the user's email is in settings.admin_emails_list, flip is_admin on. Returns whether it changed."""
    if user.is_admin:
        return False
    if user.email.lower() in settings.admin_emails_list:
        user.is_admin = True
        return True
    return False


def _issue_trial_license(user: User, db: Session) -> str:
    """Create a 14-day Everything-tier LicenseKey for a brand-new user and
    return the plaintext key (caller must email/display it). The trial gives
    the user enough time to evaluate the desktop without payment; after
    expiry the JWT in their license.json hits its hard cutoff and the
    desktop locks regardless of internet access.
    """
    key = generate_license_key()
    now = datetime.now(timezone.utc)
    lk = LicenseKey(
        user_id=user.id,
        key_hash=hash_license_key(key),
        key_prefix=key[:8],
        tier=_TRIAL_TIER,
        issued_at=now,
        expires_at=now + timedelta(days=_TRIAL_DAYS),
        max_activations=_TRIAL_MAX_ACTIVATIONS,
    )
    db.add(lk)
    return key


@router.post("/signup", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def signup(body: SignupRequest, db: Session = Depends(get_db)) -> TokenResponse:
    existing = db.query(User).filter(User.email == body.email.lower()).first()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
    user = User(
        email=body.email.lower(),
        password_hash=hash_password(body.password),
        full_name=body.full_name,
    )
    _maybe_promote_admin(user)
    db.add(user)
    db.flush()  # get user.id
    sub = Subscription(
        user_id=user.id,
        tier=SubscriptionTier.FREE,
        status=SubscriptionStatus.INACTIVE,
    )
    db.add(sub)
    # Auto-issue 14-day Everything-tier trial license so user can immediately
    # download + activate the desktop. The trial license sits alongside the
    # FREE Subscription row — the desktop reads from LicenseKey, the web app
    # from Subscription, so the user effectively has full access on the
    # desktop for 14 days while their web tier remains FREE.
    _issue_trial_license(user, db)
    db.commit()
    return _token_response(user.id)


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.query(User).filter(User.email == body.email.lower()).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account disabled")
    if _maybe_promote_admin(user):
        db.commit()
    return _token_response(user.id)


@router.post("/refresh", response_model=TokenResponse)
def refresh(body: RefreshRequest, db: Session = Depends(get_db)) -> TokenResponse:
    payload = decode_token(body.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    user = db.get(User, payload.get("sub"))
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return _token_response(user.id)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> UserOut:
    return UserOut.model_validate(user)
