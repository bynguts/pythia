"""Refusals the UI says in its own language.

An HTTP ``detail`` is either plain English text or ``{"code", "params", "message"}``:
the console translates ``code`` with ``params`` (``lx_err_<code>``) and API users read
``message``. Stores raise :class:`CodedError` (a ``ValueError``) to give a refusal a code.
"""

from __future__ import annotations

from typing import Any


class CodedError(ValueError):
    def __init__(self, code: str, message: str, **params: Any) -> None:
        super().__init__(message)
        self.code = code
        self.params = params


def coded_detail(code: str, message: str, **params: Any) -> dict[str, Any]:
    return {"code": code, "params": params, "message": message}


def error_detail(exc: Exception) -> str | dict[str, Any]:
    """The HTTP detail of a refusal: coded when it carries a code, else its text."""
    if isinstance(exc, CodedError):
        return coded_detail(exc.code, str(exc), **exc.params)
    return str(exc)
