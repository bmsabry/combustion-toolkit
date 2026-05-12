"""Learning-module endpoints: per-email invitations, enrollments, progress.

Two roles:
  - Student (any authenticated user): check their own access for a module,
    request access if not invited, accept an invitation, read/write their
    own progress payload.
  - Admin (is_admin=True): manage invitations and enrollments for a module,
    see the roster and per-student progress.

Module IDs are short string keys (e.g. 'gt-05'). The frontend is the source
of truth for what each ID means; the API just stores rows keyed on it.
"""
from __future__ import annotations

import hashlib
import logging
import os
import secrets
from datetime import datetime, timezone
from typing import Optional, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_user, get_admin_user
from ..models import (
    ModuleInvitation, ModuleEnrollment, ModuleProgress, ModuleAccessRequest, User,
)
from ..email_sender import send_email

log = logging.getLogger("combustion-toolkit-api.learning")

router = APIRouter(prefix="/learning", tags=["learning"])

# Module ID → human metadata used in emails. Frontend has its own copy for UI.
_MODULES = {
    "gt-05": {
        "title": "GT-05 — Centrifugal Compressor",
        "subtitle": "Aerodynamics, Design & Performance Map",
        "url_base": "https://smallgasturbine.gt-05.proreadyengineer.com",
    },
    "gt-06": {
        "title": "GT-06 — Evaporative Tube Combustor",
        "subtitle": "Design Principles & Fuel Delivery",
        "url_base": "https://smallgasturbine.gt-06.proreadyengineer.com",
    },
}

# When a user accepts an invitation OR is granted access to module X, also
# auto-create enrollments for these modules. One-way: granting GT-05 → also
# grants GT-06. Granting GT-06 alone does NOT grant GT-05.
_AUTO_GRANT_ON_ACCEPT = {
    "gt-05": ["gt-06"],
}


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _module_info(module_id: str) -> dict:
    info = _MODULES.get(module_id)
    if not info:
        raise HTTPException(status_code=404, detail=f"Unknown module '{module_id}'")
    return info


# ─── schemas ────────────────────────────────────────────────────────────
class AccessOut(BaseModel):
    enrolled: bool
    has_pending_invitation: bool = False
    has_pending_request: bool = False
    is_admin: bool = False


class InviteCreateRequest(BaseModel):
    emails: list[EmailStr] = Field(min_length=1, max_length=200)
    notes: Optional[str] = Field(default=None, max_length=1000)
    send_email: bool = True


class InviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    module_id: str
    email: str
    created_at: datetime
    accepted_at: Optional[datetime]
    revoked_at: Optional[datetime]
    last_sent_at: Optional[datetime]
    notes: Optional[str]
    status: str  # 'pending' | 'accepted' | 'revoked'


class EnrollmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    user_id: str
    user_email: str
    user_full_name: Optional[str]
    module_id: str
    granted_at: datetime
    last_active_at: Optional[datetime]
    revoked_at: Optional[datetime]
    progress_summary: dict[str, Any]


class AccessRequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    user_id: str
    user_email: str
    user_full_name: Optional[str]
    module_id: str
    requested_at: datetime
    resolved_at: Optional[datetime]
    resolution: Optional[str]


class ProgressIn(BaseModel):
    payload: dict[str, Any]


class ProgressOut(BaseModel):
    payload: dict[str, Any]
    updated_at: Optional[datetime] = None


class AcceptInvitationRequest(BaseModel):
    token: str


# ─── helpers ────────────────────────────────────────────────────────────
def _invite_status(inv: ModuleInvitation) -> str:
    if inv.revoked_at:
        return "revoked"
    if inv.accepted_at:
        return "accepted"
    return "pending"


def _serialise_invitation(inv: ModuleInvitation) -> InviteOut:
    d = InviteOut(
        id=inv.id, module_id=inv.module_id, email=inv.email,
        created_at=inv.created_at, accepted_at=inv.accepted_at,
        revoked_at=inv.revoked_at, last_sent_at=inv.last_sent_at,
        notes=inv.notes, status=_invite_status(inv),
    )
    return d


def _progress_summary(payload: dict) -> dict:
    """Lightweight summary derived from the frontend progress blob for the
    instructor roster. Does NOT include full probe-level detail."""
    if not isinstance(payload, dict):
        return {"sections_completed": 0, "probe_accuracy": None, "summative_score": None}
    section_state = payload.get("sectionState") or {}
    completed = sum(1 for s in section_state.values() if isinstance(s, dict) and s.get("completedAt"))
    total_probes = 0
    correct_probes = 0
    for s in section_state.values():
        if not isinstance(s, dict):
            continue
        for attempts in (s.get("probeAttempts") or {}).values():
            if not isinstance(attempts, list) or not attempts:
                continue
            total_probes += 1
            if True in attempts:
                correct_probes += 1
    accuracy = round(100 * correct_probes / total_probes) if total_probes else None
    summative = payload.get("summative")
    summative_score = None
    if isinstance(summative, dict):
        sc = summative.get("score")
        tt = summative.get("total")
        if sc is not None and tt:
            summative_score = f"{sc}/{tt}"
    return {
        "sections_completed": completed,
        "probes_attempted": total_probes,
        "probe_accuracy": accuracy,
        "summative_score": summative_score,
        "needs_completed": bool(payload.get("needs")),
    }


def _send_invite_email(invitation: ModuleInvitation, plaintext_token: str, inviter: User) -> bool:
    info = _module_info(invitation.module_id)
    accept_url = f"{info['url_base']}/accept?token={plaintext_token}"
    contact = os.environ.get("INSTRUCTOR_CONTACT_EMAIL", "info@proreadyengineer.com")
    inviter_name = inviter.full_name or inviter.email
    subject = f"You've been invited to {info['title']}"
    text = (
        f"Hello,\n\n"
        f"{inviter_name} has invited you to take {info['title']} — {info['subtitle']} "
        f"on ProReadyEngineer's Small Jet Engine Design Training.\n\n"
        f"Accept the invitation here:\n{accept_url}\n\n"
        f"If you don't already have a ProReadyEngineer account, you'll be prompted "
        f"to create one (free, no payment required). The invitation is bound to "
        f"this email address.\n\n"
        f"Questions: {contact}\n\n"
        f"— ProReadyEngineer"
    )
    html = f"""<!DOCTYPE html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #1f2937; line-height: 1.6; padding: 24px; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #0a0e1a; margin-bottom: 4px;">You've been invited</h2>
  <p style="color: #6b7280; margin-top: 0;">{info['title']} — {info['subtitle']}</p>
  <p>{inviter_name} has invited you to take this course session on ProReadyEngineer's Small Jet Engine Design Training.</p>
  <p style="margin: 28px 0;">
    <a href="{accept_url}" style="background: #00d4ff; color: #0a0e1a; padding: 12px 22px; text-decoration: none; border-radius: 6px; font-weight: 700; letter-spacing: 0.5px;">ACCEPT INVITATION</a>
  </p>
  <p style="font-size: 13px; color: #6b7280;">Or paste this link into your browser:<br/><code style="font-size: 12px;">{accept_url}</code></p>
  <p style="font-size: 13px; color: #6b7280;">If you don't already have a ProReadyEngineer account, you'll be prompted to create one (free). The invitation is bound to <b>{invitation.email}</b>.</p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;"/>
  <p style="font-size: 12px; color: #9ca3af;">Questions? <a href="mailto:{contact}" style="color: #6b7280;">{contact}</a> · © ProReadyEngineer LLC</p>
</body></html>"""
    return send_email(
        to=invitation.email,
        subject=subject,
        html=html,
        text=text,
        reply_to=contact,
    )



def _ensure_linked_enrollments(user, source_module_id: str, granted_by_user_id: str, db: Session) -> int:
    """When user gets enrolled in source_module_id, auto-create enrollments for
    any modules listed in _AUTO_GRANT_ON_ACCEPT[source_module_id]. Returns count
    of new enrollments created."""
    created = 0
    for linked_id in _AUTO_GRANT_ON_ACCEPT.get(source_module_id, []):
        existing = (
            db.query(ModuleEnrollment)
            .filter(ModuleEnrollment.user_id == user.id, ModuleEnrollment.module_id == linked_id)
            .first()
        )
        if existing:
            if existing.revoked_at is not None:
                existing.revoked_at = None
                existing.granted_at = _now()
                existing.granted_by_user_id = granted_by_user_id
        else:
            db.add(ModuleEnrollment(
                user_id=user.id,
                module_id=linked_id,
                granted_by_user_id=granted_by_user_id,
            ))
            created += 1
    return created


# ─── student endpoints ─────────────────────────────────────────────────
@router.get("/{module_id}/access", response_model=AccessOut)
def get_access(
    module_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AccessOut:
    _module_info(module_id)
    enrolled = (
        db.query(ModuleEnrollment)
        .filter(
            ModuleEnrollment.user_id == user.id,
            ModuleEnrollment.module_id == module_id,
            ModuleEnrollment.revoked_at.is_(None),
        )
        .first()
        is not None
    )
    if not enrolled and user.is_admin:
        # admins always have access
        return AccessOut(enrolled=True, is_admin=True)
    pending_invite = (
        db.query(ModuleInvitation)
        .filter(
            ModuleInvitation.module_id == module_id,
            ModuleInvitation.email == user.email.lower(),
            ModuleInvitation.accepted_at.is_(None),
            ModuleInvitation.revoked_at.is_(None),
        )
        .first()
        is not None
    )
    pending_req = (
        db.query(ModuleAccessRequest)
        .filter(
            ModuleAccessRequest.user_id == user.id,
            ModuleAccessRequest.module_id == module_id,
            ModuleAccessRequest.resolved_at.is_(None),
        )
        .first()
        is not None
    )
    return AccessOut(
        enrolled=enrolled,
        has_pending_invitation=pending_invite,
        has_pending_request=pending_req,
        is_admin=user.is_admin,
    )


@router.post("/{module_id}/request-access", status_code=201)
def request_access(
    module_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _module_info(module_id)
    existing = (
        db.query(ModuleAccessRequest)
        .filter(
            ModuleAccessRequest.user_id == user.id,
            ModuleAccessRequest.module_id == module_id,
            ModuleAccessRequest.resolved_at.is_(None),
        )
        .first()
    )
    if existing:
        return {"ok": True, "already_requested": True}
    req = ModuleAccessRequest(user_id=user.id, module_id=module_id)
    db.add(req)
    db.commit()
    return {"ok": True, "already_requested": False}


@router.post("/invitations/accept")
def accept_invitation(
    body: AcceptInvitationRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    inv = (
        db.query(ModuleInvitation)
        .filter(ModuleInvitation.token_hash == _hash_token(body.token))
        .first()
    )
    if not inv:
        raise HTTPException(status_code=404, detail="Invalid or expired invitation")
    if inv.revoked_at:
        raise HTTPException(status_code=410, detail="This invitation has been revoked")
    if inv.email.lower() != user.email.lower():
        raise HTTPException(
            status_code=403,
            detail=f"This invitation is for {inv.email}. Sign in with that account to accept.",
        )
    # Idempotent: if already accepted by this user, no-op.
    if inv.accepted_at and inv.accepted_by_user_id == user.id:
        return {"ok": True, "already_accepted": True, "module_id": inv.module_id}

    # Mark accepted
    inv.accepted_at = _now()
    inv.accepted_by_user_id = user.id

    # Upsert enrollment
    existing = (
        db.query(ModuleEnrollment)
        .filter(ModuleEnrollment.user_id == user.id, ModuleEnrollment.module_id == inv.module_id)
        .first()
    )
    if existing:
        existing.revoked_at = None
        existing.granted_at = _now()
        existing.granted_by_user_id = inv.created_by_user_id
        existing.invitation_id = inv.id
    else:
        db.add(ModuleEnrollment(
            user_id=user.id,
            module_id=inv.module_id,
            granted_by_user_id=inv.created_by_user_id,
            invitation_id=inv.id,
        ))
    # Resolve any pending access request
    pending = (
        db.query(ModuleAccessRequest)
        .filter(
            ModuleAccessRequest.user_id == user.id,
            ModuleAccessRequest.module_id == inv.module_id,
            ModuleAccessRequest.resolved_at.is_(None),
        )
        .first()
    )
    if pending:
        pending.resolved_at = _now()
        pending.resolution = "granted"
    # Auto-grant linked modules (e.g. GT-05 → GT-06)
    _ensure_linked_enrollments(user, inv.module_id, inv.created_by_user_id, db)
    db.commit()
    return {"ok": True, "already_accepted": False, "module_id": inv.module_id}


@router.get("/{module_id}/progress", response_model=ProgressOut)
def get_progress(
    module_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProgressOut:
    _module_info(module_id)
    # Require enrollment (or admin)
    if not user.is_admin:
        enrolled = (
            db.query(ModuleEnrollment)
            .filter(
                ModuleEnrollment.user_id == user.id,
                ModuleEnrollment.module_id == module_id,
                ModuleEnrollment.revoked_at.is_(None),
            )
            .first()
        )
        if not enrolled:
            raise HTTPException(status_code=403, detail="Not enrolled in this module")
    row = (
        db.query(ModuleProgress)
        .filter(ModuleProgress.user_id == user.id, ModuleProgress.module_id == module_id)
        .first()
    )
    return ProgressOut(payload=row.payload if row else {}, updated_at=row.updated_at if row else None)


@router.put("/{module_id}/progress", response_model=ProgressOut)
def put_progress(
    module_id: str,
    body: ProgressIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProgressOut:
    _module_info(module_id)
    enrollment = (
        db.query(ModuleEnrollment)
        .filter(
            ModuleEnrollment.user_id == user.id,
            ModuleEnrollment.module_id == module_id,
            ModuleEnrollment.revoked_at.is_(None),
        )
        .first()
    )
    if not enrollment and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not enrolled in this module")
    row = (
        db.query(ModuleProgress)
        .filter(ModuleProgress.user_id == user.id, ModuleProgress.module_id == module_id)
        .first()
    )
    if row:
        row.payload = body.payload
        row.updated_at = _now()
    else:
        row = ModuleProgress(user_id=user.id, module_id=module_id, payload=body.payload)
        db.add(row)
    if enrollment:
        enrollment.last_active_at = _now()
    db.commit()
    db.refresh(row)
    return ProgressOut(payload=row.payload, updated_at=row.updated_at)




class ModuleAccessOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    module_id: str
    title: str
    subtitle: str
    url_base: str
    enrolled: bool
    granted_at: Optional[datetime] = None
    last_active_at: Optional[datetime] = None
    progress_summary: dict[str, Any] = {}
    via_admin: bool = False


@router.get("/my-modules", response_model=list[ModuleAccessOut])
def my_modules(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ModuleAccessOut]:
    """List all modules this user has access to. Used by the cross-module
    directory page. Admins additionally see modules they're not enrolled in
    (with via_admin=True) so they can preview/manage them."""
    enrollments = (
        db.query(ModuleEnrollment)
        .filter(
            ModuleEnrollment.user_id == user.id,
            ModuleEnrollment.revoked_at.is_(None),
        )
        .all()
    )
    enrolled_ids = {e.module_id for e in enrollments}
    progress_rows = (
        db.query(ModuleProgress)
        .filter(ModuleProgress.user_id == user.id)
        .all()
    )
    progress_by_module = {p.module_id: p.payload for p in progress_rows}
    enrollment_by_module = {e.module_id: e for e in enrollments}
    out: list[ModuleAccessOut] = []
    # First: all real enrollments, in module-id order
    for mid in sorted(enrolled_ids):
        info = _MODULES.get(mid)
        if not info:
            continue
        e = enrollment_by_module[mid]
        out.append(ModuleAccessOut(
            module_id=mid,
            title=info["title"],
            subtitle=info["subtitle"],
            url_base=info["url_base"],
            enrolled=True,
            granted_at=e.granted_at,
            last_active_at=e.last_active_at,
            progress_summary=_progress_summary(progress_by_module.get(mid, {})),
            via_admin=False,
        ))
    # Then: any other known modules, visible only to admins for management
    if user.is_admin:
        for mid, info in _MODULES.items():
            if mid in enrolled_ids:
                continue
            out.append(ModuleAccessOut(
                module_id=mid,
                title=info["title"],
                subtitle=info["subtitle"],
                url_base=info["url_base"],
                enrolled=False,
                granted_at=None,
                last_active_at=None,
                progress_summary=_progress_summary(progress_by_module.get(mid, {})),
                via_admin=True,
            ))
    return out


# ─── admin endpoints ───────────────────────────────────────────────────
@router.post("/{module_id}/invitations", response_model=list[InviteOut], status_code=201)
def create_invitations(
    module_id: str,
    body: InviteCreateRequest,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> list[InviteOut]:
    _module_info(module_id)
    out: list[ModuleInvitation] = []
    seen_emails: set[str] = set()
    for email in body.emails:
        email_norm = email.lower().strip()
        if email_norm in seen_emails:
            continue
        seen_emails.add(email_norm)
        # Re-use any active pending invitation for the same (module, email); otherwise create new
        existing = (
            db.query(ModuleInvitation)
            .filter(
                ModuleInvitation.module_id == module_id,
                ModuleInvitation.email == email_norm,
                ModuleInvitation.accepted_at.is_(None),
                ModuleInvitation.revoked_at.is_(None),
            )
            .first()
        )
        if existing:
            inv = existing
            plaintext_token = secrets.token_urlsafe(32)
            inv.token_hash = _hash_token(plaintext_token)  # rotate token
        else:
            plaintext_token = secrets.token_urlsafe(32)
            inv = ModuleInvitation(
                module_id=module_id,
                email=email_norm,
                token_hash=_hash_token(plaintext_token),
                created_by_user_id=admin.id,
                notes=body.notes,
            )
            db.add(inv)
        db.flush()
        if body.send_email:
            sent = _send_invite_email(inv, plaintext_token, admin)
            if sent:
                inv.last_sent_at = _now()
        out.append(inv)
    db.commit()
    return [_serialise_invitation(i) for i in out]


@router.get("/{module_id}/invitations", response_model=list[InviteOut])
def list_invitations(
    module_id: str,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> list[InviteOut]:
    _module_info(module_id)
    rows = (
        db.query(ModuleInvitation)
        .filter(ModuleInvitation.module_id == module_id)
        .order_by(ModuleInvitation.created_at.desc())
        .all()
    )
    return [_serialise_invitation(r) for r in rows]


@router.post("/{module_id}/invitations/{invitation_id}/resend")
def resend_invitation(
    module_id: str,
    invitation_id: str,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    _module_info(module_id)
    inv = db.query(ModuleInvitation).filter(
        ModuleInvitation.id == invitation_id,
        ModuleInvitation.module_id == module_id,
    ).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if inv.accepted_at:
        raise HTTPException(status_code=409, detail="Invitation already accepted")
    if inv.revoked_at:
        raise HTTPException(status_code=410, detail="Invitation revoked")
    # Rotate token on resend so old links become useless
    plaintext_token = secrets.token_urlsafe(32)
    inv.token_hash = _hash_token(plaintext_token)
    sent = _send_invite_email(inv, plaintext_token, admin)
    if sent:
        inv.last_sent_at = _now()
        db.commit()
        return {"ok": True, "sent": True}
    db.commit()
    return {"ok": False, "sent": False, "detail": "Email delivery failed — see server logs"}


@router.delete("/{module_id}/invitations/{invitation_id}")
def revoke_invitation(
    module_id: str,
    invitation_id: str,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    _module_info(module_id)
    inv = db.query(ModuleInvitation).filter(
        ModuleInvitation.id == invitation_id,
        ModuleInvitation.module_id == module_id,
    ).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if inv.revoked_at:
        return {"ok": True, "already_revoked": True}
    inv.revoked_at = _now()
    db.commit()
    return {"ok": True}


@router.get("/{module_id}/enrollments", response_model=list[EnrollmentOut])
def list_enrollments(
    module_id: str,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> list[EnrollmentOut]:
    _module_info(module_id)
    rows = (
        db.query(ModuleEnrollment, User)
        .join(User, User.id == ModuleEnrollment.user_id)
        .filter(ModuleEnrollment.module_id == module_id)
        .order_by(ModuleEnrollment.granted_at.desc())
        .all()
    )
    # batch-load progress for all those users
    user_ids = [r[1].id for r in rows]
    progress_rows = (
        db.query(ModuleProgress)
        .filter(ModuleProgress.module_id == module_id, ModuleProgress.user_id.in_(user_ids))
        .all()
    ) if user_ids else []
    progress_by_user = {p.user_id: p.payload for p in progress_rows}
    out: list[EnrollmentOut] = []
    for enr, u in rows:
        out.append(EnrollmentOut(
            user_id=u.id,
            user_email=u.email,
            user_full_name=u.full_name,
            module_id=enr.module_id,
            granted_at=enr.granted_at,
            last_active_at=enr.last_active_at,
            revoked_at=enr.revoked_at,
            progress_summary=_progress_summary(progress_by_user.get(u.id, {})),
        ))
    return out


@router.get("/{module_id}/enrollments/{user_id}/progress")
def get_student_progress(
    module_id: str,
    user_id: str,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    """Full progress payload for a specific student — used by the
    instructor-drill-down view."""
    _module_info(module_id)
    student = db.query(User).filter(User.id == user_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="User not found")
    progress = (
        db.query(ModuleProgress)
        .filter(ModuleProgress.user_id == user_id, ModuleProgress.module_id == module_id)
        .first()
    )
    enrollment = (
        db.query(ModuleEnrollment)
        .filter(ModuleEnrollment.user_id == user_id, ModuleEnrollment.module_id == module_id)
        .first()
    )
    return {
        "user": {"id": student.id, "email": student.email, "full_name": student.full_name},
        "enrollment": {
            "granted_at": enrollment.granted_at if enrollment else None,
            "last_active_at": enrollment.last_active_at if enrollment else None,
            "revoked_at": enrollment.revoked_at if enrollment else None,
        } if enrollment else None,
        "payload": progress.payload if progress else {},
        "updated_at": progress.updated_at if progress else None,
    }


@router.delete("/{module_id}/enrollments/{user_id}")
def revoke_enrollment(
    module_id: str,
    user_id: str,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    _module_info(module_id)
    enr = (
        db.query(ModuleEnrollment)
        .filter(ModuleEnrollment.user_id == user_id, ModuleEnrollment.module_id == module_id)
        .first()
    )
    if not enr:
        raise HTTPException(status_code=404, detail="Enrollment not found")
    if enr.revoked_at:
        return {"ok": True, "already_revoked": True}
    enr.revoked_at = _now()
    db.commit()
    return {"ok": True}


@router.post("/{module_id}/enrollments/{user_id}/restore")
def restore_enrollment(
    module_id: str,
    user_id: str,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    _module_info(module_id)
    enr = (
        db.query(ModuleEnrollment)
        .filter(ModuleEnrollment.user_id == user_id, ModuleEnrollment.module_id == module_id)
        .first()
    )
    if not enr:
        raise HTTPException(status_code=404, detail="Enrollment not found")
    if not enr.revoked_at:
        return {"ok": True, "already_active": True}
    enr.revoked_at = None
    enr.granted_at = _now()
    enr.granted_by_user_id = admin.id
    db.commit()
    return {"ok": True}


@router.get("/{module_id}/access-requests", response_model=list[AccessRequestOut])
def list_access_requests(
    module_id: str,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> list[AccessRequestOut]:
    _module_info(module_id)
    rows = (
        db.query(ModuleAccessRequest, User)
        .join(User, User.id == ModuleAccessRequest.user_id)
        .filter(ModuleAccessRequest.module_id == module_id)
        .order_by(ModuleAccessRequest.requested_at.desc())
        .all()
    )
    out = []
    for req, u in rows:
        out.append(AccessRequestOut(
            id=req.id, user_id=u.id, user_email=u.email, user_full_name=u.full_name,
            module_id=req.module_id, requested_at=req.requested_at,
            resolved_at=req.resolved_at, resolution=req.resolution,
        ))
    return out


@router.post("/{module_id}/access-requests/{user_id}/grant")
def grant_access_request(
    module_id: str,
    user_id: str,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    """Convert a pending access request into an enrollment directly (no
    email round-trip — the requester is already signed in)."""
    _module_info(module_id)
    req = (
        db.query(ModuleAccessRequest)
        .filter(
            ModuleAccessRequest.user_id == user_id,
            ModuleAccessRequest.module_id == module_id,
        )
        .first()
    )
    if not req:
        raise HTTPException(status_code=404, detail="Access request not found")
    existing = (
        db.query(ModuleEnrollment)
        .filter(ModuleEnrollment.user_id == user_id, ModuleEnrollment.module_id == module_id)
        .first()
    )
    if existing:
        existing.revoked_at = None
        existing.granted_at = _now()
        existing.granted_by_user_id = admin.id
    else:
        db.add(ModuleEnrollment(
            user_id=user_id,
            module_id=module_id,
            granted_by_user_id=admin.id,
        ))
    _student = db.query(User).filter(User.id == user_id).first()
    if _student:
        _ensure_linked_enrollments(_student, module_id, admin.id, db)
    req.resolved_at = _now()
    req.resolution = "granted"
    db.commit()
    return {"ok": True}


@router.post("/{module_id}/access-requests/{user_id}/deny")
def deny_access_request(
    module_id: str,
    user_id: str,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
) -> dict:
    _module_info(module_id)
    req = (
        db.query(ModuleAccessRequest)
        .filter(
            ModuleAccessRequest.user_id == user_id,
            ModuleAccessRequest.module_id == module_id,
            ModuleAccessRequest.resolved_at.is_(None),
        )
        .first()
    )
    if not req:
        raise HTTPException(status_code=404, detail="Pending access request not found")
    req.resolved_at = _now()
    req.resolution = "denied"
    db.commit()
    return {"ok": True}
