"""Regression tests for the permanent fix to the recurring admin-flag drift bug.

Symptom history: bmsabry@gmail.com would intermittently lose the "ACCURATE MODE"
toggle in the header. Root cause was that `User.is_admin` could end up False in
the DB despite the email being listed in `ADMIN_EMAILS`, and the only repair was
manually POSTing /admin/promote.

Three layers of defense are now in place; this file pins all three.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app import deps
from app.config import get_settings
from app.routers.billing import get_subscription


# ---------------------------------------------------------------------------
# Layer 1: per-request self-heal in deps._self_heal_admin
# ---------------------------------------------------------------------------


def _user(email: str, is_admin: bool):
    """Build a minimal stand-in for a SQLAlchemy User row."""
    return SimpleNamespace(email=email, is_admin=is_admin, is_active=True, id="u1")


def _patch_admin_emails(monkeypatch, emails):
    """Force the cached settings.admin_emails_list to a known value."""
    monkeypatch.setattr(
        type(get_settings()),
        "admin_emails_list",
        property(lambda self: [e.lower() for e in emails]),
    )


def test_self_heal_flips_admin_true_when_email_is_listed(monkeypatch):
    _patch_admin_emails(monkeypatch, ["bmsabry@gmail.com"])
    user = _user("bmsabry@gmail.com", is_admin=False)
    db = MagicMock()
    deps._self_heal_admin(user, db)
    assert user.is_admin is True
    db.commit.assert_called_once()


def test_self_heal_is_idempotent_when_already_admin(monkeypatch):
    _patch_admin_emails(monkeypatch, ["bmsabry@gmail.com"])
    user = _user("bmsabry@gmail.com", is_admin=True)
    db = MagicMock()
    deps._self_heal_admin(user, db)
    assert user.is_admin is True
    db.commit.assert_not_called()


def test_self_heal_is_case_insensitive(monkeypatch):
    _patch_admin_emails(monkeypatch, ["bmsabry@gmail.com"])
    user = _user("BMSabry@GMAIL.com", is_admin=False)
    db = MagicMock()
    deps._self_heal_admin(user, db)
    assert user.is_admin is True


def test_self_heal_does_not_promote_unlisted_email(monkeypatch):
    _patch_admin_emails(monkeypatch, ["bmsabry@gmail.com"])
    user = _user("someone-else@example.com", is_admin=False)
    db = MagicMock()
    deps._self_heal_admin(user, db)
    assert user.is_admin is False
    db.commit.assert_not_called()


def test_self_heal_no_admin_emails_configured_is_noop(monkeypatch):
    _patch_admin_emails(monkeypatch, [])
    user = _user("bmsabry@gmail.com", is_admin=False)
    db = MagicMock()
    deps._self_heal_admin(user, db)
    assert user.is_admin is False
    db.commit.assert_not_called()


def test_self_heal_swallows_db_failure(monkeypatch, caplog):
    """A broken commit must NOT break the auth path — the worst case is one
    extra request without admin, not a 500."""
    _patch_admin_emails(monkeypatch, ["bmsabry@gmail.com"])
    user = _user("bmsabry@gmail.com", is_admin=False)
    db = MagicMock()
    db.commit.side_effect = RuntimeError("DB exploded")
    # Must not raise.
    deps._self_heal_admin(user, db)


# ---------------------------------------------------------------------------
# Layer 3: /subscription returns admin tier when email is listed, even if
# the DB row says is_admin=False (covers the gap before self-heal commits)
# ---------------------------------------------------------------------------


def test_get_subscription_treats_listed_email_as_admin_even_if_db_says_no(
    monkeypatch,
):
    _patch_admin_emails(monkeypatch, ["bmsabry@gmail.com"])
    user = _user("bmsabry@gmail.com", is_admin=False)
    out = get_subscription(user=user)
    assert out.tier == "admin"
    assert out.has_online_access is True
    assert out.has_download_access is True


def test_get_subscription_unlisted_non_admin_with_no_subscription_is_free(
    monkeypatch,
):
    _patch_admin_emails(monkeypatch, ["bmsabry@gmail.com"])
    user = _user("someone-else@example.com", is_admin=False)
    user.subscription = None
    out = get_subscription(user=user)
    assert out.tier == "free"
    assert out.has_online_access is False


def test_get_subscription_listed_email_with_admin_flag_already_true(monkeypatch):
    _patch_admin_emails(monkeypatch, ["bmsabry@gmail.com"])
    user = _user("bmsabry@gmail.com", is_admin=True)
    out = get_subscription(user=user)
    assert out.tier == "admin"
    assert out.has_online_access is True
