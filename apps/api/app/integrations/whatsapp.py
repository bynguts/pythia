from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app.core.env import getenv
from app.core.storage import RecordStore, StorageError

# Placeholder JIDs: the repo never carries a real number. Point alerts at a
# real chat/group with PYTHIA_WA_DEFAULT_CHAT_ID / PYTHIA_WA_DEFAULT_GROUP_ID.
PLACEHOLDER_CHAT_ID = "6281234567890@c.us"
PLACEHOLDER_GROUP_ID = "6281234567890-1620000000@g.us"


def default_chat_id() -> str:
    return getenv("WA_DEFAULT_CHAT_ID") or PLACEHOLDER_CHAT_ID


def default_group_id() -> str:
    return getenv("WA_DEFAULT_GROUP_ID") or PLACEHOLDER_GROUP_ID


# Every WhatsApp message is written in ONE language: the Settings → WhatsApp choice
# (stored), else PYTHIA_WA_LANG, else Indonesian, the language the drivers read.
WA_LANGS = ("id", "en")
_SETTING_ID = "message_language"
_SETTINGS: RecordStore | None = None

WA_TEMPLATES: dict[str, dict[str, str]] = {
    "alert": {
        "id": (
            "PERINGATAN PYTHIA\nTruk: {truck}\nKendala: {issue}\nRekomendasi tindakan: {recommendation}\n"
            "Mohon konfirmasi tindak lanjut di aplikasi sopir Pythia."
        ),
        "en": (
            "PYTHIA ALERT\nTruck: {truck}\nIssue: {issue}\nRecommended action: {recommendation}\n"
            "Please confirm the field response in the Pythia driver app."
        ),
    },
    "alert_driver": {
        "id": (
            "Yth. {driver} (unit {truck} / {plate}),\nPythia mendeteksi kendala: {issue}.\n"
            "Rekomendasi rute/tindakan: {recommendation}.\nMohon segera konfirmasi di aplikasi sopir Pythia."
        ),
        "en": (
            "Hello {driver} (unit {truck} / {plate}),\nPythia detected an issue: {issue}.\n"
            "Recommended route/action: {recommendation}.\nPlease confirm right away in the Pythia driver app."
        ),
    },
    "alert_group": {
        "id": (
            "⚠️ PERINGATAN OPERASIONAL PYTHIA ⚠️\nUnit: {truck} ({driver} / {plate})\n"
            "Kendala: {issue}\nRekomendasi tindakan: {recommendation}"
        ),
        "en": (
            "⚠️ PYTHIA OPERATIONAL ALERT ⚠️\nUnit: {truck} ({driver} / {plate})\n"
            "Issue: {issue}\nRecommended action: {recommendation}"
        ),
    },
    "test": {
        "id": (
            "Pythia terhubung ke WhatsApp. Grup ini menerima peringatan operasional Pythia. "
            "Pesan uji, tidak perlu dibalas."
        ),
        "en": (
            "Pythia is connected to WhatsApp. This group receives Pythia operational alerts. "
            "Test message, no reply needed."
        ),
    },
    "gate_hold": {
        "id": "Tahan keberangkatan {n} menit; slot gerbang baru Anda {slot}.",
        "en": "Hold your departure {n} min; your new gate slot is {slot}.",
    },
    "gate_safety": {
        "id": (
            "PYTHIA · PERINGATAN KESELAMATAN SOPIR\n"
            "Truk {truck} sudah menunggu {h} jam {m} menit di gerbang {dest} (sejak {since} WIB).\n"
            "Batas layanan DLH: {limit} jam.\n"
            "Tindakan: prioritaskan bongkar atau rotasi sopir, lalu konfirmasi di Pythia.\n"
            "Sumber: kejadian tercatat di aplikasi Pythia (bukan simulasi)."
        ),
        "en": (
            "PYTHIA · DRIVER SAFETY ALERT\n"
            "Truck {truck} has waited {h} h {m} min at the {dest} gate (since {since} WIB).\n"
            "DLH service limit: {limit} h.\n"
            "Action: prioritise unloading or rotate the driver, then confirm in Pythia.\n"
            "Source: Pythia app event (not simulated)."
        ),
    },
}


def _settings() -> RecordStore:
    global _SETTINGS
    if _SETTINGS is None:
        _SETTINGS = RecordStore("pythia_whatsapp_settings")
    return _SETTINGS


def message_language() -> tuple[str, str]:
    """(lang, source): the stored Settings choice, else PYTHIA_WA_LANG, else Indonesian."""
    try:
        stored = (_settings().get(_SETTING_ID) or {}).get("lang")
    except StorageError:
        stored = None
    if stored in WA_LANGS:
        return stored, "settings"
    env = (getenv("WA_LANG") or "").strip().lower()
    if env in WA_LANGS:
        return env, "env"
    return "id", "default"


def set_message_language(lang: str) -> None:
    if lang not in WA_LANGS:
        raise ValueError(f"lang must be one of {', '.join(WA_LANGS)}")
    _settings().write(_SETTING_ID, {"lang": lang})


def wa_text(key: str, lang: str | None = None, **params: Any) -> str:
    """One WhatsApp template, fully in ``lang`` (default: the message language setting)."""
    if lang not in WA_LANGS:
        lang = message_language()[0]
    return WA_TEMPLATES[key][lang].format(**params)


def driver_display(name: str, lang: str) -> str:
    """A fleet driver name in the message language: 'Pengemudi Sim 03' reads 'Driver Sim 03' in English."""
    if lang != "en":
        return name
    if name == "Supir Pythia":
        return "Pythia driver"
    return re.sub(r"^(Pengemudi|Supir)\b", "Driver", name)


def build_alert_message(truck_code: str, issue: str, recommendation: str, lang: str | None = None) -> str:
    return wa_text("alert", lang, truck=truck_code, issue=issue, recommendation=recommendation)


GROUPS_TIMEOUT_SECONDS = 25.0


@dataclass
class OpenWAClient:
    base_url: str = ""
    api_key: str = ""
    session_id: str = ""
    timeout_seconds: float = 8.0

    @classmethod
    def from_env(cls) -> OpenWAClient:
        return cls(
            base_url=os.getenv("OPENWA_BASE_URL", "http://127.0.0.1:2785/api").rstrip("/"),
            api_key=os.getenv("OPENWA_API_KEY", ""),
            session_id=os.getenv("OPENWA_SESSION_ID", "default"),
            timeout_seconds=float(os.getenv("OPENWA_TIMEOUT_SECONDS", "3")),
        )

    def is_configured(self) -> bool:
        return bool(self.base_url and self.session_id)

    def _request(self, path: str, method: str = "GET") -> Request:
        """A gateway request carrying OPENWA_API_KEY (X-API-Key) when one is set."""
        headers = {"X-API-Key": self.api_key} if self.api_key else {}
        return Request(f"{self.base_url}{path}", headers=headers, method=method)

    def health(self) -> dict[str, Any]:
        if not self.is_configured():
            return {
                "provider": "openwa",
                "configured": False,
                "connected": False,
                "message": "WhatsApp gateway is not configured.",
            }
        try:
            with urlopen(self._request("/health"), timeout=self.timeout_seconds) as response:
                body = response.read().decode("utf-8")
            payload = json.loads(body) if body else {}
            return {
                "provider": payload.get("provider", "baileys"),
                "configured": True,
                "connected": bool(payload.get("connected")),
                "message": payload.get("message", "WhatsApp gateway is reachable."),
                "state": payload.get("state"),
                # Raw paired account id; the API router masks it before responding.
                "me": payload.get("me"),
            }
        except Exception as error:
            return {
                "provider": "baileys",
                "configured": True,
                "connected": False,
                "message": f"WhatsApp gateway is offline: {error}",
            }

    def qr(self) -> dict[str, Any]:
        """Fetch the pairing QR as a PNG data URL from the gateway."""
        if not self.is_configured():
            return {
                "provider": "baileys",
                "configured": False,
                "state": "unconfigured",
                "qr": None,
                "message": "WhatsApp gateway is not configured.",
            }
        try:
            with urlopen(self._request("/qr"), timeout=self.timeout_seconds) as response:
                body = response.read().decode("utf-8")
            payload = json.loads(body) if body else {}
            return {
                "provider": "baileys",
                "configured": True,
                "state": payload.get("state", "unknown"),
                "qr": payload.get("qr"),
                "message": payload.get("message"),
            }
        except Exception as error:
            return {
                "provider": "baileys",
                "configured": True,
                "state": "gateway_offline",
                "qr": None,
                "message": f"WhatsApp gateway is offline: {error}",
            }

    def groups(self) -> dict[str, Any]:
        """Fetch participating group chats (JID + subject) from the gateway."""
        if not self.is_configured():
            return {
                "provider": "baileys",
                "configured": False,
                "groups": [],
                "message": "WhatsApp gateway is not configured.",
            }
        try:
            # The first listing after pairing waits for WhatsApp, which takes several
            # seconds on an account with many groups; later ones come from the cache.
            timeout = max(self.timeout_seconds, GROUPS_TIMEOUT_SECONDS)
            with urlopen(self._request("/groups"), timeout=timeout) as response:
                body = response.read().decode("utf-8")
            payload = json.loads(body) if body else {}
            return {
                "provider": "baileys",
                "configured": True,
                "connected": bool(payload.get("connected")),
                "groups": payload.get("groups", []),
                "message": payload.get("message", ""),
            }
        except Exception as error:
            return {
                "provider": "baileys",
                "configured": True,
                "connected": False,
                "groups": [],
                "message": f"WhatsApp gateway is offline: {error}",
            }

    def logout(self) -> dict[str, Any]:
        """End the current session so the dashboard can pair a fresh QR."""
        if not self.is_configured():
            return {
                "provider": "baileys",
                "configured": False,
                "logged_out": False,
                "message": "WhatsApp gateway is not configured.",
            }
        request = self._request("/logout", method="POST")
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read().decode("utf-8")
            payload = json.loads(body) if body else {}
            return {
                "provider": "baileys",
                "configured": True,
                "logged_out": bool(payload.get("logged_out")),
                "state": payload.get("state"),
                "message": "WhatsApp session ended. Scan the new QR to re-link.",
            }
        except HTTPError as error:
            return {
                "provider": "baileys",
                "configured": True,
                "logged_out": False,
                "status_code": error.code,
                "message": f"Logout failed: {error}",
            }
        except Exception as error:
            return {
                "provider": "baileys",
                "configured": True,
                "logged_out": False,
                "message": str(error),
            }

    def send_text(self, chat_id: str, text: str) -> dict[str, Any]:
        if not self.is_configured():
            return {
                "provider": "openwa",
                "sent": False,
                "message": "OpenWA is not configured. Set OPENWA_BASE_URL, OPENWA_API_KEY, and OPENWA_SESSION_ID.",
            }
        if not chat_id:
            return {"provider": "openwa", "sent": False, "message": "Missing WhatsApp chat_id."}

        url = f"{self.base_url}/sessions/{self.session_id}/messages/send-text"
        payload = {"chatId": chat_id, "text": text}
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["X-API-Key"] = self.api_key

        request = Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read().decode("utf-8")
            response_payload = json.loads(body) if body else {}
            sent = bool(response_payload.get("sent", 200 <= response.status < 300))
            return {
                "provider": response_payload.get("provider", "baileys"),
                "sent": sent,
                "status_code": response.status,
                "message": response_payload.get("message")
                or response_payload.get("error")
                or ("WhatsApp message sent." if sent else "WhatsApp gateway rejected the message."),
                "response": response_payload,
            }
        except HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                payload = {"error": body}
            return {
                "provider": payload.get("provider", "baileys"),
                "sent": False,
                "status_code": error.code,
                "message": payload.get("message") or payload.get("error") or str(error),
                "response": payload,
            }
        except Exception as error:
            return {
                "provider": "baileys",
                "sent": False,
                "message": str(error),
            }
