"""WhatsApp gateway: contacts, status, QR/session and operational alerts."""

from __future__ import annotations

import json
import logging
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import require_any_permission, require_any_principal, require_permission
from app.api.schemas import WhatsAppAlertRequest
from app.api.state import history_store
from app.core.env import getenv
from app.core.paths import DRIVER_CONTACTS_EXAMPLE_FILE, DRIVER_CONTACTS_FILE
from app.field.privacy import mask_phones_in_text
from app.integrations import wa_gateway_process
from app.integrations.whatsapp import (
    PLACEHOLDER_GROUP_ID,
    OpenWAClient,
    build_alert_message,
    default_chat_id,
    default_group_id,
)

router = APIRouter()
logger = logging.getLogger(__name__)

# H6: what the gateway is. Shown with every status read so nobody mistakes the
# prototype's transport for an official WhatsApp channel.
GATEWAY_PROVENANCE = {
    "classification": "UNOFFICIAL_CLIENT",
    "label": (
        "Baileys (unofficial WhatsApp Web client) — a government pilot would use the "
        "WhatsApp Business Platform"
    ),
}


# Module attributes so tests can point them at temporary files.
CONTACTS_FILE = DRIVER_CONTACTS_FILE
EXAMPLE_CONTACTS_FILE = DRIVER_CONTACTS_EXAMPLE_FILE


def default_contacts() -> dict:
    """Contacts served while no local driver_contacts.json exists.

    Driver names come from the example file; every number is the configured
    default chat/group (placeholders unless PYTHIA_WA_DEFAULT_* are set).
    """
    try:
        example = json.loads(EXAMPLE_CONTACTS_FILE.read_text(encoding="utf-8"))
        names = list(example.get("drivers") or {})
    except (OSError, ValueError, AttributeError):
        names = []
    return {
        "drivers": {name: default_chat_id() for name in names},
        "group_jid": default_group_id(),
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
    if not CONTACTS_FILE.exists():
        return default_contacts()
    try:
        with open(CONTACTS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data.get("drivers"), dict):
            data["drivers"] = {name: normalize_phone_number(num) for name, num in data["drivers"].items()}
        data["group_jid"] = normalize_group_jid(data.get("group_jid", ""))
        return data
    except Exception:
        return default_contacts()


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
    with open(CONTACTS_FILE, "w", encoding="utf-8") as f:
        json.dump(normalized, f, indent=4)


_UNMATCHED_DRIVERS_LOGGED: set[str] = set()


def driver_chat_id(config: dict, driver_name: str) -> str:
    """The driver's WhatsApp chat, or the default chat when the contacts have no such key.

    Keys must match the simulated fleet's driver names ("Pengemudi Sim NN"); an
    unmatched name is logged once per process so a mis-keyed file is visible.
    """
    jid = (config.get("drivers") or {}).get(driver_name)
    if jid:
        return jid
    if driver_name not in _UNMATCHED_DRIVERS_LOGGED:
        _UNMATCHED_DRIVERS_LOGGED.add(driver_name)
        logger.warning(
            "driver_contacts has no entry for driver '%s' (keys must match the fleet's "
            "driver names, e.g. 'Pengemudi Sim 01'); alerts go to the default chat",
            driver_name,
        )
    return default_chat_id()


def get_truck_info(truck_code: str) -> dict:
    from app.fleet.data import get_dynamic_trucks

    for t in get_dynamic_trucks():
        if t["truck_code"] == truck_code:
            return t
    return {"driver_name": "Supir Pythia", "plate_number": "B 1234 CD"}


@router.get("/api/whatsapp/contacts")
def get_whatsapp_contacts(_role: str = Depends(require_permission("admin:manage"))):
    return load_contacts()


@router.post("/api/whatsapp/contacts")
def post_whatsapp_contacts(payload: dict, _role: str = Depends(require_permission("admin:manage"))):
    save_contacts(payload)
    return {"status": "success"}


def alert_group() -> tuple[str, str]:
    """The group that receives operational alerts, and where that choice comes from.

    Same precedence as ``whatsapp_alert``: the local contacts file, then
    PYTHIA_WA_DEFAULT_GROUP_ID, then the repo placeholder.
    """
    if CONTACTS_FILE.exists():
        jid = load_contacts().get("group_jid")
        if jid and jid != PLACEHOLDER_GROUP_ID:
            return jid, "contacts_file"
    if getenv("WA_DEFAULT_GROUP_ID"):
        return default_group_id(), "env"
    return PLACEHOLDER_GROUP_ID, "placeholder"


def link_state(configured: bool, health: dict) -> str:
    """One word for the settings screen: connected, pairing, starting, offline or unconfigured.

    A reachable gateway always reports its socket ``state``; only the client's
    exception branch (gateway not running) leaves it out.
    """
    if not configured:
        return "unconfigured"
    if health.get("connected"):
        return "connected"
    state = health.get("state")
    if state is None:
        return "offline"
    return "pairing" if state == "qr" else "starting"


def masked_account(me: str | None) -> str | None:
    """The paired WhatsApp account ('62812...:7@s.whatsapp.net'), masked, without the device suffix."""
    if not me:
        return None
    return mask_phones_in_text(re.sub(r":\d+(?=@)", "", str(me)))


@router.get("/api/whatsapp/status")
def whatsapp_status(
    _role: str = Depends(require_any_permission("dashboard:read", "dispatch:create")),
) -> dict:
    client = OpenWAClient.from_env()
    health = client.health()
    configured = client.is_configured()
    group_jid, group_source = alert_group()
    return {
        "configured": configured,
        "connected": health.get("connected", False),
        "link_state": link_state(configured, health),
        "linked_account": masked_account(health.get("me")),
        "alert_group": {"jid": mask_phones_in_text(group_jid), "source": group_source},
        "message": health.get("message", ""),
        "provider": health.get("provider", "baileys"),
        "state": health.get("state"),
        "base_url": client.base_url,
        "session_id": client.session_id,
        "gateway_process": wa_gateway_process.process_state(client.base_url),
        "provenance": GATEWAY_PROVENANCE,
    }


@router.post("/api/whatsapp/gateway/start")
def whatsapp_gateway_start(principal: dict = Depends(require_any_principal("admin:manage"))) -> dict:
    """Start the local gateway so an administrator can pair from Settings without a terminal.

    409 when the gateway is not this machine's to start (not configured, or managed
    externally as in docker), 503 when it cannot start here (no Node.js, spawn failed).
    """
    try:
        result = wa_gateway_process.start(OpenWAClient.from_env().base_url)
    except wa_gateway_process.GatewayExternal as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except wa_gateway_process.GatewayUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if result["started"]:
        history_store.record_event("whatsapp_gateway_start", {"actor": principal["username"]})
    return result


# The pairing QR links a WhatsApp account to this gateway and the group list
# exposes chat IDs: administrator only.
@router.get("/api/whatsapp/qr")
def whatsapp_qr(_role: str = Depends(require_permission("admin:manage"))) -> dict:
    return OpenWAClient.from_env().qr()


@router.get("/api/whatsapp/groups")
def whatsapp_groups(_role: str = Depends(require_permission("admin:manage"))) -> dict:
    payload = OpenWAClient.from_env().groups()
    current, _source = alert_group()
    payload["groups"] = [
        {**group, "selected": group.get("jid") == current} for group in payload.get("groups") or []
    ]
    return payload


class AlertGroupRequest(BaseModel):
    group_jid: str = Field(pattern=r"^[0-9-]{5,64}@g\.us$")


@router.post("/api/whatsapp/alert-group")
def set_whatsapp_alert_group(
    payload: AlertGroupRequest, principal: dict = Depends(require_any_principal("admin:manage"))
) -> dict:
    """Persist the alert group in the local contacts file (git-ignored), keeping its drivers."""
    data = load_contacts() if CONTACTS_FILE.exists() else {"send_to_group": True, "send_to_driver": True}
    data["group_jid"] = payload.group_jid
    try:
        save_contacts(data)
    except OSError as error:
        raise HTTPException(status_code=503, detail="The contacts file could not be written.") from error
    masked = mask_phones_in_text(payload.group_jid)
    history_store.record_event(
        "whatsapp_alert_group", {"recipient": f"Group: {masked}", "actor": principal["username"]}
    )
    return {"alert_group": {"jid": masked, "source": "contacts_file"}}


TEST_MESSAGE = (
    "Pythia: pesan uji koneksi WhatsApp. Grup ini menerima peringatan operasional Pythia. "
    "Tidak perlu dibalas."
)


@router.post("/api/whatsapp/test")
def whatsapp_test_message(principal: dict = Depends(require_any_principal("admin:manage"))) -> dict:
    """Send one fixed test text to the alert group only (never to drivers)."""
    jid, source = alert_group()
    if source == "placeholder":
        raise HTTPException(status_code=409, detail="Choose an alert group before sending a test message.")
    result = OpenWAClient.from_env().send_text(jid, TEST_MESSAGE)
    masked = mask_phones_in_text(jid)
    sent = bool(result.get("sent"))
    history_store.record_event(
        "whatsapp_test",
        {"recipient": f"Group: {masked}", "sent": sent, "actor": principal["username"]},
    )
    return {"sent": sent, "recipient": masked}


class WhatsAppSummaryBody(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    lang: str | None = Field(default=None, pattern="^(id|en)$")


@router.post("/api/whatsapp/summary")
def whatsapp_summary(
    body: WhatsAppSummaryBody, principal: dict = Depends(require_any_principal("dispatch:create"))
) -> dict:
    """Send the day's summary text to the alert group (never to drivers); wave 13 Reports.

    409 when no alert group is chosen, 503 when the gateway did not deliver it.
    Phone numbers in the text are masked before sending; the history log keeps
    only the length, never the text.
    """
    jid, source = alert_group()
    if source == "placeholder":
        raise HTTPException(status_code=409, detail="Choose an alert group before sending a summary.")
    text = mask_phones_in_text(body.text.strip())
    result = OpenWAClient.from_env().send_text(jid, text)
    masked = mask_phones_in_text(jid)
    sent = bool(result.get("sent"))
    history_store.record_event(
        "whatsapp_summary",
        {"recipient": f"Group: {masked}", "sent": sent, "chars": len(text), "actor": principal["username"]},
    )
    if not sent:
        raise HTTPException(status_code=503, detail="The WhatsApp gateway did not deliver the summary.")
    return {"sent": True, "recipient": masked, "chars": len(text)}


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
        driver_jid = driver_chat_id(config, driver_name)
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
                # Gap 7: the history log never stores a full phone number.
                "recipient": f"Driver: {driver_name} ({mask_phones_in_text(driver_jid)})",
                "truck_code": payload.truck_code,
                "sent": res_driver.get("sent", False),
                "message": res_driver.get("message", ""),
                "msg": driver_msg,
            },
        )

    # 2. Send to Group
    if config.get("send_to_group", True):
        group_jid = config.get("group_jid") or default_group_id()
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
                "recipient": f"Group: {mask_phones_in_text(group_jid)}",
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
