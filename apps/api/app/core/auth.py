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


# Cloudflare's published edge ranges (https://www.cloudflare.com/ips/). A request that
# reaches the host from one of them carries the visitor's address in CF-Connecting-IP.
CLOUDFLARE_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
        "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
        "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
        "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
        "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
        "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
    )
)  # fmt: skip


def _from_cloudflare(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return any(ip in network for network in CLOUDFLARE_NETWORKS)


def client_ip(
    peer: str | None,
    real_ip: str | None,
    forwarded_for: str | None,
    cf_connecting_ip: str | None = None,
) -> str:
    """The caller's address as the deploy's nginx reports it.

    nginx (deploy/frontend/nginx*.conf) sets X-Real-IP to the address it saw. When that
    is a loopback or private address, nginx itself sits behind another proxy on the
    host, and the last X-Forwarded-For entry (the one that proxy appended) is the
    client. When that client is a Cloudflare edge, the visitor is CF-Connecting-IP
    (trusted only then, so a direct caller cannot pick its own address). Without
    nginx (local dev) the socket peer is used.
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
            real = last
    visitor = (cf_connecting_ip or "").strip()
    if visitor and _from_cloudflare(real) and not _from_cloudflare(visitor):
        try:
            return str(ipaddress.ip_address(visitor))
        except ValueError:
            pass
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
                    _forget(tok)
            _prune_sessions()
        # Dicts keep insertion order and tokens are never re-inserted: first = oldest.
        while len(_TOKEN_REGISTRY) >= _MAX_TOKENS:
            oldest = next(iter(_TOKEN_REGISTRY))
            _TOKEN_REGISTRY.pop(oldest)
            _TOKEN_PRINCIPALS.pop(oldest, None)
            _forget(oldest)
        tok = secrets.token_urlsafe(32)
        _TOKEN_REGISTRY[tok] = (principal["role"], now)
        _TOKEN_PRINCIPALS[tok] = {
            **_shared_principal(principal["role"]),
            **{k: principal[k] for k in ("username", "truck_code", "display_name") if principal.get(k)},
            "shared_account": bool(principal.get("shared_account", True)),
        }
        _persist(tok, principal["role"], _TOKEN_PRINCIPALS[tok])
    return tok


# Sessions survive a restart or a redeploy: each token's SHA-256 (never the token
# itself) maps to its principal and wall-clock issue time in SQLite. Memory stays the
# hot path; a token missing there is looked up once and restored with its age.
# A storage failure only costs the restart survival, never a login.
_SESSIONS = None


def _sessions():
    global _SESSIONS
    if _SESSIONS is None:
        from app.core.storage import RecordStore

        _SESSIONS = RecordStore("pythia_sessions")
    return _SESSIONS


def _session_key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _credential(principal: dict) -> str | None:
    """A fingerprint of what the session was granted on: the account's current password
    (hash) and role. A changed password, role or truck binding, or a removed personal
    account, no longer matches, so a stored session does not outlive it."""
    if principal.get("shared_account", True):
        material = f"shared|{principal['role']}|{_expected_password(principal['role'])}"
    else:
        user = load_users().get(str(principal.get("username") or "").lower())
        if user is None:
            return None
        material = f"user|{user['role']}|{user['truck_code']}|{user['password_hash']}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _persist(token: str, role: str, principal: dict) -> None:
    key = _session_key(token)
    try:
        _sessions().write(
            key,
            {
                "key": key,
                "role": role,
                "principal": principal,
                "credential": _credential(principal),
                "issued_epoch": time.time(),
            },
        )
    except Exception:  # noqa: BLE001 - see the note above _SESSIONS
        logger.warning("session not persisted; it ends at the next restart", exc_info=True)


def _forget(token: str) -> None:
    try:
        _sessions().delete(_session_key(token))
    except Exception:  # noqa: BLE001
        logger.warning("session record not removed", exc_info=True)


def _prune_sessions() -> None:
    """Drop stored sessions past the TTL, including ones never used since a restart."""
    try:
        store = _sessions()
        for record in store.all():
            if time.time() - float(record.get("issued_epoch") or 0) > _TOKEN_TTL_SECONDS:
                store.delete(record["key"])
    except Exception:  # noqa: BLE001
        logger.warning("stored sessions not pruned", exc_info=True)


def _restore(token: str) -> bool:
    """Bring a token issued before a restart back into memory, keeping its age."""
    try:
        record = _sessions().get(_session_key(token))
    except Exception:  # noqa: BLE001
        return False
    if not record or record.get("role") not in ROLES:
        return False
    age = time.time() - float(record.get("issued_epoch") or 0)
    principal = record.get("principal") or _shared_principal(record["role"])
    # A wall clock set back a little reads as a fresh session, not a lost one.
    stale = age > _TOKEN_TTL_SECONDS or age < -_PRUNE_INTERVAL_SECONDS
    if stale or not record.get("credential") or record["credential"] != _credential(principal):
        _forget(token)
        return False
    with _TOKEN_LOCK:
        _TOKEN_REGISTRY[token] = (record["role"], time.monotonic() - max(age, 0.0))
        _TOKEN_PRINCIPALS[token] = principal
    return True


def revoke(token: str) -> None:
    """Sign a session out on the server, in memory and in the store."""
    with _TOKEN_LOCK:
        _TOKEN_REGISTRY.pop(token, None)
        _TOKEN_PRINCIPALS.pop(token, None)
    if token:
        _forget(token)


# Issued-token -> (role, issued-at). In-process registry with a 12 h expiry, backed by
# the SQLite session store above so a restart keeps everyone signed in; a real
# deployment uses signed JWTs.
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
    if entry is None and token and _restore(token):
        entry = _TOKEN_REGISTRY.get(token)
    if entry is None:
        return None
    role, issued_at = entry
    if time.monotonic() - issued_at > _TOKEN_TTL_SECONDS:
        _TOKEN_REGISTRY.pop(token, None)
        _TOKEN_PRINCIPALS.pop(token, None)
        _forget(token)
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
