"""Role-aware authentication and RBAC for Pythia.

Replaces the frontend-only admin/admin123 gate with a backend principal model.
Passwords are demo credentials sourced from environment when set; this is a
pilot-grade gate, not production IdP integration (documented as such).
"""

from __future__ import annotations

import hmac
import secrets
import threading
import time

from app.core.env import getenv

# Permission sets per role. Least privilege: drivers only act on their tasks.
ROLES: dict[str, set[str]] = {
    "executive": {"dashboard:read", "reports:read", "history:read"},
    "dispatcher": {"dashboard:read", "operations:plan", "dispatch:create", "history:read"},
    "supervisor": {
        "dashboard:read",
        "dispatch:create",
        "dispatch:confirm",
        "operations:approve",
        "history:read",
        "spj:override",
    },
    "driver": {"dispatch:confirm"},
    "auditor": {"history:read", "reports:read", "provenance:read"},
    "administrator": {
        "dashboard:read",
        "reports:read",
        "history:read",
        "operations:plan",
        "operations:approve",
        "dispatch:create",
        "dispatch:confirm",
        "provenance:read",
        "admin:manage",
        "spj:override",
    },
}


# Demo credentials: password is "<role>-demo-pass" unless overridden by env
# PYTHIA_PW_<ROLE>. Pilot-grade only.
def _expected_password(role: str) -> str:
    return getenv(f"PW_{role.upper()}", f"{role}-demo-pass")


def authenticate(username: str, password: str) -> dict[str, str] | None:
    role = username.strip().lower()
    if role not in ROLES:
        return None
    expected = _expected_password(role)
    if hmac.compare_digest(password, expected):
        return {"username": role, "role": role}
    return None


def has_permission(role: str, permission: str) -> bool:
    return permission in ROLES.get(role, set())


def token_for(principal: dict[str, str]) -> str:
    """Issue a fresh random opaque token per login (not a signed JWT; pilot-grade).

    Tokens are unguessable and unique per login, so two sessions of the same role
    never share a credential. Expired entries are pruned at most once a minute,
    and the registry is capped: past `_MAX_TOKENS` the oldest token is evicted,
    so a login flood cannot grow memory without bound.
    """
    global _last_prune
    now = time.monotonic()
    with _TOKEN_LOCK:
        if now - _last_prune >= _PRUNE_INTERVAL_SECONDS:
            _last_prune = now
            for tok, (_role, issued_at) in list(_TOKEN_REGISTRY.items()):
                if now - issued_at > _TOKEN_TTL_SECONDS:
                    _TOKEN_REGISTRY.pop(tok, None)
        # Dicts keep insertion order and tokens are never re-inserted: first = oldest.
        while len(_TOKEN_REGISTRY) >= _MAX_TOKENS:
            _TOKEN_REGISTRY.pop(next(iter(_TOKEN_REGISTRY)))
        tok = secrets.token_urlsafe(32)
        _TOKEN_REGISTRY[tok] = (principal["role"], now)
    return tok


# Issued-token -> (role, issued-at). In-process registry with a 12 h expiry: one
# uvicorn worker only (tokens are not shared across workers and are lost on
# restart); a real deployment uses signed JWTs.
_TOKEN_REGISTRY: dict[str, tuple[str, float]] = {}
_TOKEN_TTL_SECONDS = 12 * 60 * 60
_TOKEN_LOCK = threading.Lock()
_MAX_TOKENS = 5000
_PRUNE_INTERVAL_SECONDS = 60.0
_last_prune = float("-inf")


def role_for_token(token: str) -> str | None:
    entry = _TOKEN_REGISTRY.get(token)
    if entry is None:
        return None
    role, issued_at = entry
    if time.monotonic() - issued_at > _TOKEN_TTL_SECONDS:
        _TOKEN_REGISTRY.pop(token, None)
        return None
    return role
