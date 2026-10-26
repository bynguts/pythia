"""Read the whole weighbridge ticket (or scale display) via a vision model.

The provider is GutsAI vision when ``GUTS_API_KEY`` is set, otherwise the
OpenAI-compatible gateway (``OPENAI_API_KEY`` / ``OPENAI_BASE_URL`` with
``OPENAI_VISION_MODEL`` or ``OPENAI_MODEL``).

Never fabricate a value: config, transport, or parsing failures return null,
and every field the model could not read legibly (or that fails validation)
is null on its own, so the driver confirms the ticket against the same photo.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.request
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

MAX_WEIGHT_KG = 100_000.0
_TIMEOUT_SECONDS = 25.0
DOCUMENT_TYPES = ("weighbridge_ticket", "scale_display", "not_a_ticket", "unreadable")
# Field -> max length of the trimmed string the model may return.
_TEXT_FIELDS = {"ticket_no": 40, "plate": 20, "weighed_in_at": 40, "weighed_out_at": 40, "site": 80}
_KG_FIELDS = ("gross_kg", "tare_kg", "net_kg")

_SYSTEM_PROMPT = "Kamu pembaca struk atau display timbangan truk sampah. Jawab HANYA satu objek JSON."
_USER_PROMPT = (
    "Baca seluruh struk timbangan (atau display timbangan) pada foto ini. "
    "Isi JSON berikut, tanpa teks lain:\n"
    '{"document": "weighbridge_ticket" | "scale_display" | "not_a_ticket" | "unreadable", '
    '"gross_kg": <number|null>, "tare_kg": <number|null>, "net_kg": <number|null>, '
    '"ticket_no": <string|null>, "plate": <string|null>, '
    '"weighed_in_at": <string|null>, "weighed_out_at": <string|null>, "site": <string|null>}\n'
    "Aturan: gross_kg = bruto/berat masuk (truk bermuatan), tare_kg = tara/berat kosong, "
    "net_kg = netto. Berat dalam kg sebagai angka tanpa pemisah ribuan. "
    "Display timbangan dengan satu angka: isi gross_kg saja, document = scale_display. "
    "ticket_no = nomor tiket/struk, plate = nomor polisi kendaraan, waktu masuk/keluar "
    "disalin persis seperti tercetak, site = nama lokasi timbangan/TPA. "
    "Jika foto bukan struk atau display timbangan, document = not_a_ticket. "
    "Jangan menebak: isi null untuk nilai yang buram, terpotong, atau ambigu."
)


def _default_http_post(url: str, headers: dict, json_body: dict, timeout: float) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(json_body).encode(),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _provider() -> dict[str, str] | None:
    """GutsAI vision when its key is set, else the OpenAI-compatible gateway; None without a key."""
    guts_key = os.getenv("GUTS_API_KEY")
    if guts_key:
        model = os.getenv("GUTS_VISION_MODEL") or "gemini-3.8-flash"
        return {
            "api_key": guts_key,
            "base_url": os.getenv("GUTS_BASE_URL") or "https://api.gutsai.id/v1",
            "model": model,
            "source": f"gutsai-vision ({model})",
        }
    openai_key = os.getenv("OPENAI_API_KEY")
    if openai_key:
        model = os.getenv("OPENAI_VISION_MODEL") or os.getenv("OPENAI_MODEL") or "gpt-4.1-mini"
        return {
            "api_key": openai_key,
            "base_url": os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1",
            "model": model,
            "source": f"vision ({model})",
        }
    return None


def _kg(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, str) and re.fullmatch(r"\s*\d+(\.\d+)?\s*", value):
        value = float(value)
    if not isinstance(value, (int, float)):
        return None
    weight = float(value)
    return weight if 0 < weight < MAX_WEIGHT_KG else None


def _text(value: Any, max_len: int) -> str | None:
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    return value[:max_len] or None


def _parse_ticket(content: str) -> dict[str, Any]:
    """The model's JSON as validated fields; anything unparseable or invalid is null."""
    fields: dict[str, Any] = {key: None for key in (*_KG_FIELDS, *_TEXT_FIELDS)}
    start, end = content.find("{"), content.rfind("}")
    try:
        data = json.loads(content[start : end + 1]) if 0 <= start < end else None
    except json.JSONDecodeError:
        data = None
    if not isinstance(data, dict):
        fields["document"] = "unreadable"
        return fields
    document = data.get("document")
    if document == "not_a_ticket":
        fields["document"] = document
        return fields
    for key in _KG_FIELDS:
        fields[key] = _kg(data.get(key))
    if fields["gross_kg"] is None:
        # Older prompt shape: a single "weight_kg" is the gross weight.
        fields["gross_kg"] = _kg(data.get("weight_kg"))
    for key, max_len in _TEXT_FIELDS.items():
        fields[key] = _text(data.get(key), max_len)
    gross = fields["gross_kg"]
    if gross is not None:
        if fields["net_kg"] is not None and fields["net_kg"] > gross:
            fields["net_kg"] = None
        if fields["tare_kg"] is not None and fields["tare_kg"] >= gross:
            fields["tare_kg"] = None
    if document not in DOCUMENT_TYPES:
        document = "unreadable" if gross is None else "weighbridge_ticket"
    fields["document"] = document
    return fields


def _failed(raw_text: str, source: str) -> dict[str, Any]:
    return {
        "weight_kg": None,
        **{key: None for key in (*_KG_FIELDS, *_TEXT_FIELDS)},
        "document": None,
        "raw_text": raw_text,
        "confidence": "failed",
        "source": source,
    }


def is_configured() -> bool:
    """Whether a vision key is set; without one every read returns ``failed`` at once."""
    return _provider() is not None


def read_weight_from_photo(photo_b64: str, http_post: Callable[..., dict] | None = None) -> dict[str, Any]:
    """Read the ticket photo. ``weight_kg`` is the gross weight (kept for older callers)."""
    provider = _provider()
    if provider is None:
        return _failed("no vision key is set (GUTS_API_KEY or OPENAI_API_KEY)", "vision (not configured)")
    source = provider["source"]
    post = http_post or _default_http_post
    body = {
        "model": provider["model"],
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _USER_PROMPT},
                    {"type": "image_url", "image_url": {"url": photo_b64}},
                ],
            },
        ],
        "max_tokens": 400,
        "stream": False,
    }
    try:
        resp = post(
            url=f"{provider['base_url'].rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {provider['api_key']}"},
            json_body=body,
            timeout=_TIMEOUT_SECONDS,
        )
        content = resp["choices"][0]["message"]["content"]
    except Exception as exc:  # noqa: BLE001
        # The exception type only: never the request (image) or the key.
        logger.warning("timbangan OCR call failed: %s", type(exc).__name__)
        return _failed("OCR request failed", source)
    if not isinstance(content, str) or not content.strip():
        return _failed("OCR returned empty content", source)
    fields = _parse_ticket(content)
    return {
        "weight_kg": fields["gross_kg"],
        **fields,
        "raw_text": content[:200],
        "confidence": "high" if fields["gross_kg"] is not None else "low",
        "source": source,
    }
