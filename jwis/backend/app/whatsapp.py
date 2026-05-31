from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any
from urllib.request import Request, urlopen


def build_alert_message(truck_code: str, issue: str, recommendation: str) -> str:
    return (
        "JWIS ALERT\n"
        f"Truck: {truck_code}\n"
        f"Issue: {issue}\n"
        f"Recommended action: {recommendation}\n"
        "Please confirm field response in the JWIS Field App."
    )


@dataclass
class OpenWAClient:
    base_url: str = ""
    api_key: str = ""
    session_id: str = ""
    timeout_seconds: float = 8.0

    @classmethod
    def from_env(cls) -> "OpenWAClient":
        return cls(
            base_url=os.getenv("OPENWA_BASE_URL", "http://localhost:2785/api").rstrip("/"),
            api_key=os.getenv("OPENWA_API_KEY", ""),
            session_id=os.getenv("OPENWA_SESSION_ID", ""),
        )

    def is_configured(self) -> bool:
        return bool(self.base_url and self.api_key and self.session_id)

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
        request = Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-API-Key": self.api_key,
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read().decode("utf-8")
            return {
                "provider": "openwa",
                "sent": True,
                "status_code": response.status,
                "response": json.loads(body) if body else {},
            }
        except Exception as error:
            return {
                "provider": "openwa",
                "sent": False,
                "message": str(error),
            }
