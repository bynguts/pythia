"""Role-aware authentication and RBAC for Pythia.

Replaces the frontend-only admin/admin123 gate with a backend principal model.
Passwords are demo credentials sourced from environment when set; this is a
pilot-grade gate, not production IdP integration (documented as such).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import secrets
import threading
import time
from pathlib import Path

from app.core.env import getenv
from app.core.paths import API_DIR
from app.core.ratelimit import SlidingWindowLimiter

logger = logging.getLogger(__name__)

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


# Shared demo accounts: username == role, password "<role>-demo-pass" unless
# overridden by env PYTHIA_PW_<ROLE>. An empty value (`cp .env.example .env`
# leaves `PYTHIA_PW_DRIVER=`) counts as unset, never as an empty password.
def _expected_password(role: str) -> str:
    return getenv(f"PW_{role.upper()}") or f"{role}-demo-pass"


# Personal accounts (optional): PYTHIA_USERS_FILE points at a JSON file, see
# apps/api/users.example.json. Each user has a username, a PBKDF2 password hash
# (`python -m app.core.auth hash <password>`), a role, and optionally the
# truck_code a driver is bound to and a display name.
PBKDF2_ITERATIONS = 260_000
_HASH_SCHEME = "pbkdf2_sha256"


def hash_password(password: str, *, salt: bytes | None = None, iterations: int = PBKDF2_ITERATIONS) -> str:
    """`pbkdf2_sha256$<iterations>$<salt b64>$<hash b64>` (hashlib only, no extra dependency)."""
    salt = salt if salt is not None else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "$".join(
        (_HASH_SCHEME, str(iterations), base64.b64encode(salt).decode(), base64.b64encode(digest).decode())
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, iterations, salt, expected = str(encoded).split("$")
        if scheme != _HASH_SCHEME:
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), base64.b64decode(salt), int(iterations)
        )
        return hmac.compare_digest(digest, base64.b64decode(expected))
    except (ValueError, TypeError):
        return False


def load_users() -> dict[str, dict]:
    """Users from PYTHIA_USERS_FILE keyed by lower-case username; {} when unset.

    A configured but unreadable file is logged and yields no personal accounts
    (it never falls open). Entries with an unknown role or no hash are skipped.
    """
    path = (getenv("USERS_FILE") or "").strip()
    if not path:
        return {}
    file = Path(path)
    if not file.is_absolute():
        file = API_DIR / file  # like PYTHIA_WEATHER_SNAPSHOT: relative to apps/api
    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.error("PYTHIA_USERS_FILE %s could not be read: %s", path, exc)
        return {}
    entries = raw.get("users") if isinstance(raw, dict) else raw
    users: dict[str, dict] = {}
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        username = str(entry.get("username") or "").strip().lower()
        role = str(entry.get("role") or "").strip().lower()
        if not username or role not in ROLES or not entry.get("password_hash"):
            logger.warning("PYTHIA_USERS_FILE: skipping an entry without username, known role or hash")
            continue
        users[username] = {
            "username": username,
            "role": role,
            "password_hash": str(entry["password_hash"]),
            "truck_code": str(entry.get("truck_code") or "").strip() or None,
            "display_name": str(entry.get("display_name") or "").strip() or None,
        }
    return users


def authenticate(username: str, password: str) -> dict | None:
    """A principal: username, role, truck_code, display_name, shared_account.

    A personal account from PYTHIA_USERS_FILE wins over the shared role account
    of the same name. The shared role accounts stay available as demo mode
    (`shared_account: True`), so the audit trail can tell them apart.
    """
    name = username.strip().lower()
    user = load_users().get(name)
    if user is not None:
        if not verify_password(password, user["password_hash"]):
            return None
        return {
            "username": user["username"],
            "role": user["role"],
            "truck_code": user["truck_code"],
            "display_name": user["display_name"],
            "shared_account": False,
        }
    if name not in ROLES:
        return None
    # Bytes, not str: compare_digest raises TypeError on non-ASCII str (a 500 at login).
    if hmac.compare_digest(password.encode("utf-8"), _expected_password(name).encode("utf-8")):
        return _shared_principal(name)
    return None


# Login throttle: 10 failed logins per (client IP, username) in 5 minutes, then 429
# until the oldest failure leaves the window. A successful login clears the count.
LOGIN_MAX_FAILURES = 10
LOGIN_WINDOW_SECONDS = 5 * 60
LOGIN_FAILURES = SlidingWindowLimiter(LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS)


def login_throttle_key(client_ip: str, username: str) -> str:
    return f"{client_ip}|{username.strip().lower()}"


def client_ip(peer: str | None, real_ip: str | None, forwarded_for: str | None) -> str:
    """The caller's address as the deploy's nginx reports it.

    nginx (deploy/frontend/nginx*.conf) sets X-Real-IP to the address it saw. When that
    is a loopback or private address, nginx itself sits behind another proxy on the
    host, and the last X-Forwarded-For entry (the one that proxy appended) is the
    client. Without nginx (local dev) the socket peer is used.
    """
    real = (real_ip or "").strip()
    if not real:
        return peer or "unknown"
    try:
        address = ipaddress.ip_address(real)
        internal = address.is_private or address.is_loopback
    except ValueError:
        internal = False
    if internal and forwarded_for:
        last = forwarded_for.split(",")[-1].strip()
        if last:
            return last
    return real


def _shared_principal(role: str) -> dict:
    return {"username": role, "role": role, "truck_code": None, "display_name": None, "shared_account": True}


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
                    _TOKEN_PRINCIPALS.pop(tok, None)
        # Dicts keep insertion order and tokens are never re-inserted: first = oldest.
        while len(_TOKEN_REGISTRY) >= _MAX_TOKENS:
            oldest = next(iter(_TOKEN_REGISTRY))
            _TOKEN_REGISTRY.pop(oldest)
            _TOKEN_PRINCIPALS.pop(oldest, None)
        tok = secrets.token_urlsafe(32)
        _TOKEN_REGISTRY[tok] = (principal["role"], now)
        _TOKEN_PRINCIPALS[tok] = {
            **_shared_principal(principal["role"]),
            **{k: principal[k] for k in ("username", "truck_code", "display_name") if principal.get(k)},
            "shared_account": bool(principal.get("shared_account", True)),
        }
    return tok


# Issued-token -> (role, issued-at). In-process registry with a 12 h expiry: one
# uvicorn worker only (tokens are not shared across workers and are lost on
# restart); a real deployment uses signed JWTs.
_TOKEN_REGISTRY: dict[str, tuple[str, float]] = {}
# Issued-token -> the principal behind it (username, truck binding), kept beside
# the (role, issued-at) entry so expiry stays decided in one place.
_TOKEN_PRINCIPALS: dict[str, dict] = {}
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
        _TOKEN_PRINCIPALS.pop(token, None)
        return None
    return role


def principal_for_token(token: str) -> dict | None:
    """The signed-in principal (username, role, truck_code, ...); None when invalid or expired."""
    role = role_for_token(token)
    if role is None:
        return None
    principal = _TOKEN_PRINCIPALS.get(token)
    if principal is None or principal.get("role") != role:
        return _shared_principal(role)
    return dict(principal)


if __name__ == "__main__":  # python -m app.core.auth hash <password>
    import sys

    if len(sys.argv) == 3 and sys.argv[1] == "hash":
        print(hash_password(sys.argv[2]))
    else:
        print("usage: python -m app.core.auth hash <password>")
        sys.exit(2)
