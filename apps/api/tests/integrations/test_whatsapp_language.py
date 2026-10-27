"""Every WhatsApp message is written in one language: the Settings choice, else PYTHIA_WA_LANG, else id."""

import re

import pytest

from app.api.routers import whatsapp as wa_router
from app.core.storage import RecordStore
from app.field.safety import gate_alert_message
from app.integrations import whatsapp as wa
from app.integrations.whatsapp import OpenWAClient, driver_display, wa_text

ID_MARKERS = (
    "truk kendala rekomendasi tindakan mohon sopir pengemudi menunggu menit jam gerbang sejak batas "
    "tahan keberangkatan peringatan grup pesan dibalas terhubung menerima simulasi sumber bukan dan "
    "yang di untuk aplikasi segera kejadian"
).split()
EN_MARKERS = (
    "truck issue recommended action please driver waited gate since limit hold departure alert group "
    "message reply connected receives simulated source the and for app event right"
).split()

PARAMS = {
    "truck": "T-088",
    "driver": "Sim 03",
    "plate": "B 9012 GH",
    "issue": "X1",
    "recommendation": "X2",
    "m": 15,
    "n": 15,
    "slot": "09:15",
    "h": 2,
    "start": "09:15",
    "end": "09:30",
    "dest": "TPA Bantargebang",
    "since": "07:40",
    "limit": 2,
}


def words(text: str) -> set[str]:
    return set(re.findall(r"[a-z]+", text.lower()))


@pytest.fixture()
def wa_settings(tmp_path, monkeypatch):
    """A fresh settings store and no PYTHIA_WA_LANG, so each test starts from the default."""
    monkeypatch.setattr(wa, "_SETTINGS", RecordStore("pythia_whatsapp_settings", tmp_path / "wa.db"))
    monkeypatch.delenv("PYTHIA_WA_LANG", raising=False)


@pytest.fixture()
def sent(monkeypatch, tmp_path):
    out: list[tuple[str, str]] = []

    def send_text(self, chat_id, text):
        out.append((chat_id, text))
        return {"sent": True, "message": "WhatsApp message sent."}

    monkeypatch.setattr(OpenWAClient, "send_text", send_text)
    monkeypatch.setattr(wa_router, "CONTACTS_FILE", tmp_path / "driver_contacts.json")
    return out


@pytest.mark.parametrize("key", sorted(wa.WA_TEMPLATES))
def test_each_template_is_entirely_one_language(key):
    english = wa_text(key, "en", **PARAMS)
    indonesian = wa_text(key, "id", **PARAMS)
    assert not words(english) & set(ID_MARKERS), (key, words(english) & set(ID_MARKERS))
    assert not words(indonesian) & set(EN_MARKERS), (key, words(indonesian) & set(EN_MARKERS))
    assert english != indonesian


def test_the_language_comes_from_settings_then_env_then_indonesian(wa_settings, monkeypatch):
    assert wa.message_language() == ("id", "default")
    monkeypatch.setenv("PYTHIA_WA_LANG", "en")
    assert wa.message_language() == ("en", "env")
    wa.set_message_language("id")
    assert wa.message_language() == ("id", "settings")
    with pytest.raises(ValueError):
        wa.set_message_language("fr")


def test_simulated_driver_names_read_in_the_message_language():
    assert driver_display("Pengemudi Sim 03", "en") == "Driver Sim 03"
    assert driver_display("Supir Pythia", "en") == "Pythia driver"
    assert driver_display("Pengemudi Sim 03", "id") == "Pengemudi Sim 03"


def test_the_gate_safety_alert_follows_the_language():
    alert = {
        "truck_code": "T-088",
        "wait_minutes": 135,
        "gate_arrived_at": "2026-10-27T00:40:00+00:00",
        "destination": "TPA Bantargebang",
    }
    english = gate_alert_message(alert, "en")
    assert english.startswith("PYTHIA · DRIVER SAFETY ALERT")
    assert "2 h 15 min" in english and "07:40 WIB" in english
    assert not words(english) & set(ID_MARKERS)
    indonesian = gate_alert_message(alert, "id")
    assert "2 jam 15 menit" in indonesian
    assert not words(indonesian) & set(EN_MARKERS)


def test_message_language_setting_is_for_the_dispatcher_and_administrator(
    api_client, auth_headers, wa_settings
):
    assert api_client.post("/api/whatsapp/language", json={"lang": "en"}).status_code == 401
    for role in ("driver", "supervisor"):
        res = api_client.post("/api/whatsapp/language", json={"lang": "en"}, headers=auth_headers(role))
        assert res.status_code == 403, role
    res = api_client.post("/api/whatsapp/language", json={"lang": "fr"}, headers=auth_headers("dispatcher"))
    assert res.status_code == 422
    res = api_client.post("/api/whatsapp/language", json={"lang": "en"}, headers=auth_headers("dispatcher"))
    assert res.status_code == 200, res.text
    assert res.json() == {"lang": "en", "source": "settings", "options": ["id", "en"]}
    res = api_client.get("/api/whatsapp/language", headers=auth_headers("supervisor"))
    assert res.json()["lang"] == "en"
    status = api_client.get("/api/whatsapp/status", headers=auth_headers("dispatcher")).json()
    assert status["message_language"] == {"lang": "en", "source": "settings"}


@pytest.mark.parametrize("lang", ["en", "id"])
def test_alert_driver_and_group_messages_are_one_language(api_client, auth_headers, wa_settings, sent, lang):
    wa.set_message_language(lang)
    issue, reco = (
        ("Pre-trip missing", "Fill in the pre-trip")
        if lang == "en"
        else ("Pre-trip belum diisi", "Isi pre-trip")
    )
    res = api_client.post(
        "/api/whatsapp/alert",
        json={"truck_code": "T-088", "issue": issue, "recommendation": reco},
        headers=auth_headers("dispatcher"),
    )
    assert res.status_code == 200, res.text
    texts = [text for _chat, text in sent]
    assert len(texts) == 2
    other = ID_MARKERS if lang == "en" else EN_MARKERS
    for text in texts:
        assert not words(text) & set(other), (text, words(text) & set(other))
    group = texts[1]
    if lang == "en":
        assert group.startswith("⚠️ PYTHIA OPERATIONAL ALERT ⚠️")
        assert "Driver Sim 03" in group and "Pengemudi" not in group
    else:
        assert group.startswith("⚠️ PERINGATAN OPERASIONAL PYTHIA ⚠️")
        assert "Pengemudi Sim 03" in group


@pytest.mark.parametrize("lang", ["en", "id"])
def test_the_test_message_follows_the_language(api_client, auth_headers, wa_settings, sent, lang):
    wa_router.CONTACTS_FILE.write_text('{"group_jid": "120363000000000042@g.us"}', encoding="utf-8")
    wa.set_message_language(lang)
    res = api_client.post("/api/whatsapp/test", headers=auth_headers("dispatcher"))
    assert res.status_code == 200, res.text
    assert sent == [("120363000000000042@g.us", wa_text("test", lang))]
