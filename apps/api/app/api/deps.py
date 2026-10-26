"""FastAPI auth dependencies: bearer token -> role (or principal), gated by permission."""

from __future__ import annotations

from fastapi import Header, HTTPException

from app.core.auth import has_permission, principal_for_token


def _principal_or_raise(authorization: str | None, permissions: tuple[str, ...]) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token.")
    token = authorization.split(" ", 1)[1].strip()
    principal = principal_for_token(token)
    if principal is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")
    role = principal["role"]
    if not any(has_permission(role, p) for p in permissions):
        raise HTTPException(status_code=403, detail=f"Role '{role}' lacks all of {permissions}.")
    return principal


def require_any_permission(*permissions: str):
    """FastAPI dependency: 401 if no valid token, 403 if the role holds none of the permissions."""

    def _dep(authorization: str | None = Header(default=None)) -> str:
        return _principal_or_raise(authorization, permissions)["role"]

    return _dep


def require_permission(permission: str):
    """FastAPI dependency: 401 if no valid token, 403 if role lacks the permission."""
    return require_any_permission(permission)


def require_any_principal(*permissions: str):
    """Like require_any_permission, but returns the whole principal.

    The principal carries `username` (the actor for audit trails) and, for a
    personal driver account, the `truck_code` that account is bound to.
    """

    def _dep(authorization: str | None = Header(default=None)) -> dict:
        return _principal_or_raise(authorization, permissions)

    return _dep


def ensure_truck_access(principal: dict, truck_code: str | None) -> None:
    """403 when a truck-bound account (a personal driver login) asks about another truck.

    Unbound principals (operators, the shared demo driver account) are not
    restricted here; their permission check already happened.
    """
    bound = principal.get("truck_code") if principal.get("role") == "driver" else None
    if bound and truck_code != bound:
        raise HTTPException(status_code=403, detail="This account may only read its own truck's records.")
    if principal.get("role") == "driver":
        # The driver app's truck-scoped calls are its heartbeat (GET /api/field/devices).
        from app.field.devices import note_seen

        note_seen(principal.get("username") or "driver", truck_code)
