"""Gap 7 phone masking, H6 WhatsApp gateway label, gap 1 nginx body size."""

from __future__ import annotations

import re
from pathlib import Path

from app.api.state import history_store
from app.field.privacy import mask_phone, mask_phones_in_text

REPO = Path(__file__).resolve().parents[4]


def test_phone_mask_shape():
    assert mask_phone("6281234567890") == "62812****7890"
    assert mask_phones_in_text("Driver: X (6281234567890@c.us)") == "Driver: X (62812****7890@c.us)"
    assert mask_phones_in_text("T-088 at 06:00") == "T-088 at 06:00"


def test_history_never_serves_a_full_phone_number(api_client, auth_headers):
    # A legacy event written before masking existed.
    history_store.record_event(
        "whatsapp_alert", {"recipient": "Driver: Pengemudi Sim 09 (6281299998888@c.us)", "sent": False}
    )
    res = api_client.get("/api/history", headers=auth_headers("supervisor"))
    assert res.status_code == 200
    assert "6281299998888" not in res.text
    assert "62812****8888@c.us" in res.text


def test_whatsapp_alert_history_is_written_masked(api_client, auth_headers):
    res = api_client.post(
        "/api/whatsapp/alert",
        json={"truck_code": "T-001", "issue": "uji", "route_name": "r", "recommendation": "uji"},
        headers=auth_headers("dispatcher"),
    )
    assert res.status_code == 200
    events = [e for e in history_store.list_events(limit=20) if e["event_type"] == "whatsapp_alert"]
    assert events
    for event in events[:2]:
        assert not re.search(r"\d{9,}", event["payload"]["recipient"]), event


def test_whatsapp_status_discloses_the_unofficial_gateway(api_client, auth_headers):
    body = api_client.get("/api/whatsapp/status", headers=auth_headers("dispatcher")).json()
    assert body["provenance"]["label"] == (
        "Baileys (unofficial WhatsApp Web client) — a government pilot would use the WhatsApp Business Platform"
    )


def test_nginx_accepts_photo_sized_bodies():
    conf = (REPO / "deploy" / "frontend" / "nginx.conf").read_text(encoding="utf-8")
    match = re.search(r"client_max_body_size\s+(\d+)m;", conf)
    assert match and int(match.group(1)) >= 15
