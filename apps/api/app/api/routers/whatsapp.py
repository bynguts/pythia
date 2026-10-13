"""WhatsApp gateway: contacts, status, QR/session and operational alerts."""

from __future__ import annotations

import json
import os
import re

from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import require_permission
from app.api.schemas import WhatsAppAlertRequest
from app.api.state import history_store
from app.integrations.whatsapp import OpenWAClient, build_alert_message

router = APIRouter()


CONTACTS_FILE = "driver_contacts.json"
DEFAULT_CONTACTS = {
    "drivers": {
        "Budi Santoso": "6289675877496@c.us",
        "Agus Pratama": "6289675877496@c.us",
        "Joko Wijaya": "6289675877496@c.us",
        "Rizky Maulana": "6289675877496@c.us",
    },
    "group_jid": "6285229890542-1620000000@g.us",
    "send_to_group": True,
    "send_to_driver": True,
}


def normalize_phone_number(raw: str) -> str:
    """Normalize operator input: '08xx', '+62xx', '628xx' -> '628xx@c.us'."""
    if not raw:
        return ""
    cleaned = re.sub(r"[^\d]", "", raw)
    if not cleaned:
        return ""
    if cleaned.startswith("0"):
        cleaned = "62" + cleaned[1:]
    if "@" not in cleaned:
        cleaned += "@c.us"
    return cleaned


def normalize_group_jid(raw: str) -> str:
    """Normalize group input: phone number -> '628xx@g.us', or keep full JID."""
    if not raw:
        return ""
    cleaned = raw.strip()
    if "@" in cleaned and cleaned.endswith("@g.us"):
        return cleaned
    digits = re.sub(r"[^\d]", "", cleaned)
    if not digits:
        return cleaned
    if digits.startswith("0"):
        digits = "62" + digits[1:]
    if "@" not in digits:
        digits += "@g.us"
    return digits


def load_contacts():
    if not os.path.exists(CONTACTS_FILE):
        with open(CONTACTS_FILE, "w") as f:
            json.dump(DEFAULT_CONTACTS, f, indent=4)
        return DEFAULT_CONTACTS
    try:
        with open(CONTACTS_FILE) as f:
            data = json.load(f)
        if isinstance(data.get("drivers"), dict):
            data["drivers"] = {name: normalize_phone_number(num) for name, num in data["drivers"].items()}
        data["group_jid"] = normalize_group_jid(data.get("group_jid", ""))
        return data
    except Exception:
        return DEFAULT_CONTACTS


def save_contacts(data):
    # An unauthenticated {"drivers": {}} probe once wiped every contact. Never
    # let a POST reduce the stored driver set to fewer entries than before
    # unless the caller explicitly sends the whole list.
    existing = load_contacts()
    new_drivers = dict(data).get("drivers")
    if isinstance(new_drivers, dict) and len(new_drivers) < len(existing.get("drivers", {})):
        raise HTTPException(
            status_code=409, detail="Refusing to shrink the driver contact list; send the full list."
        )
    normalized = dict(data)
    if isinstance(normalized.get("drivers"), dict):
        normalized["drivers"] = {
            name: normalize_phone_number(num) for name, num in normalized["drivers"].items()
        }
    normalized["group_jid"] = normalize_group_jid(normalized.get("group_jid", ""))
    with open(CONTACTS_FILE, "w") as f:
        json.dump(normalized, f, indent=4)


def get_truck_info(truck_code: str) -> dict:
    from app.fleet.data import get_dynamic_trucks

    for t in get_dynamic_trucks():
        if t["truck_code"] == truck_code:
            return t
    return {"driver_name": "Supir Pythia", "plate_number": "B 1234 CD"}


@router.get("/api/whatsapp/contacts")
def get_whatsapp_contacts():
    return load_contacts()


@router.post("/api/whatsapp/contacts")
def post_whatsapp_contacts(payload: dict, _role: str = Depends(require_permission("admin:manage"))):
    save_contacts(payload)
    return {"status": "success"}


@router.get("/api/whatsapp/status")
def whatsapp_status() -> dict:
    client = OpenWAClient.from_env()
    health = client.health()
    return {
        "configured": client.is_configured(),
        "connected": health.get("connected", False),
        "message": health.get("message", ""),
        "provider": health.get("provider", "baileys"),
        "state": health.get("state"),
        "base_url": client.base_url,
        "session_id": client.session_id,
    }


@router.get("/api/whatsapp/qr")
def whatsapp_qr() -> dict:
    return OpenWAClient.from_env().qr()


@router.get("/api/whatsapp/groups")
def whatsapp_groups() -> dict:
    return OpenWAClient.from_env().groups()


@router.post("/api/whatsapp/logout")
def whatsapp_logout(_role: str = Depends(require_permission("admin:manage"))) -> dict:
    return OpenWAClient.from_env().logout()


@router.post("/api/whatsapp/alert")
def whatsapp_alert(
    payload: WhatsAppAlertRequest, _role: str = Depends(require_permission("dispatch:create"))
) -> dict:
    client = OpenWAClient.from_env()
    config = load_contacts()
    info = get_truck_info(payload.truck_code)

    driver_name = info.get("driver_name", "Supir Pythia")
    plate_number = info.get("plate_number", "B 1234 CD")

    responses = {}
    attempted = []

    # 1. Send to Driver
    if config.get("send_to_driver", True):
        driver_jid = config.get("drivers", {}).get(driver_name, "6289675877496@c.us")
        driver_msg = (
            f"Yth. Bapak {driver_name} (Supir Unit {payload.truck_code} / {plate_number}),\n"
            f"Anda terdeteksi mengalami kendala: {payload.issue}.\n"
            f"Rekomendasi rute/tindakan: {payload.recommendation}.\n"
            f"Harap segera respon di aplikasi Pythia Field App."
        )
        res_driver = client.send_text(driver_jid, driver_msg)
        responses["driver"] = res_driver
        attempted.append(("driver", res_driver))
        history_store.record_event(
            "whatsapp_alert",
            {
                "recipient": f"Driver: {driver_name} ({driver_jid})",
                "truck_code": payload.truck_code,
                "sent": res_driver.get("sent", False),
                "message": res_driver.get("message", ""),
                "msg": driver_msg,
            },
        )

    # 2. Send to Group
    if config.get("send_to_group", True):
        group_jid = config.get("group_jid", "6285229890542-1620000000@g.us")
        group_msg = (
            "⚠️ PYTHIA OPERATIONAL ALERT ⚠️\n"
            f"Unit: {payload.truck_code} ({driver_name} / {plate_number})\n"
            f"Kendala: {payload.issue}\n"
            f"Rekomendasi Tindakan: {payload.recommendation}"
        )
        res_group = client.send_text(group_jid, group_msg)
        responses["group"] = res_group
        attempted.append(("group", res_group))
        history_store.record_event(
            "whatsapp_alert",
            {
                "recipient": f"Group: {group_jid}",
                "truck_code": payload.truck_code,
                "sent": res_group.get("sent", False),
                "message": res_group.get("message", ""),
                "msg": group_msg,
            },
        )

    if not attempted:
        return {
            "status": "skipped",
            "sent": False,
            "message": "WhatsApp routing is disabled. Enable driver or group delivery.",
            "results": responses,
        }

    delivered = [name for name, result in attempted if result.get("sent")]
    failed = [
        f"{name}: {result.get('message', 'send failed')}"
        for name, result in attempted
        if not result.get("sent")
    ]
    all_sent = len(delivered) == len(attempted)
    if all_sent:
        message = "WhatsApp alert delivered to " + ", ".join(delivered) + "."
    elif delivered:
        message = (
            "WhatsApp alert partially delivered to " + ", ".join(delivered) + "; failed " + "; ".join(failed)
        )
    else:
        message = "WhatsApp alert failed: " + "; ".join(failed)

    return {
        "status": "processed",
        "sent": all_sent,
        "partial": bool(delivered) and not all_sent,
        "message": message,
        "results": responses,
    }


@router.post("/api/whatsapp/alert/simulate")
def whatsapp_alert_simulate(
    payload: WhatsAppAlertRequest, _role: str = Depends(require_permission("dispatch:create"))
) -> dict:
    """Explicit demo-only simulation of a WhatsApp alert (clearly not a real send)."""
    msg = build_alert_message(payload.truck_code, payload.issue, payload.recommendation)
    return {
        "provider": "openwa-simulated",
        "sent": False,
        "simulated": True,
        "message": "Demo simulation only — no real WhatsApp message was sent.",
        "payload": {"recipient": payload.chat_id, "body": msg},
    }
