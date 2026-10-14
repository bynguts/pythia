"""FastAPI auth dependencies: bearer token -> role, gated by permission."""

from __future__ import annotations

from fastapi import Header, HTTPException

from app.core.auth import has_permission, role_for_token


def require_any_permission(*permissions: str):
    """FastAPI dependency: 401 if no valid token, 403 if the role holds none of the permissions."""

    def _dep(authorization: str | None = Header(default=None)) -> str:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(status_code=401, detail="Missing bearer token.")
        token = authorization.split(" ", 1)[1].strip()
        role = role_for_token(token)
        if role is None:
            raise HTTPException(status_code=401, detail="Invalid or expired token.")
        if not any(has_permission(role, p) for p in permissions):
            raise HTTPException(status_code=403, detail=f"Role '{role}' lacks all of {permissions}.")
        return role

    return _dep


def require_permission(permission: str):
    """FastAPI dependency: 401 if no valid token, 403 if role lacks the permission."""
    return require_any_permission(permission)
