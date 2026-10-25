"""Personal-data helpers for API payloads and outbound text (UU PDP 27/2022, R9).

- ``mask_phone`` / ``mask_phones_in_text``: what an operator may still see of a
  phone number or WhatsApp JID, e.g. ``62812****7890@c.us``.
- ``scrub_pii``: what may leave the server for an external LLM provider: phone
  numbers, Indonesian vehicle plates and known personal names are replaced
  with neutral placeholders.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

# A bare digit run long enough to be a phone number or JID (09xx... is 10-13 digits,
# 62xx... 11-14, WhatsApp group ids are longer).
_DIGIT_RUN = re.compile(r"(?<!\d)\d{9,20}(?!\d)")
# Formatted Indonesian mobile numbers: +62 812-3456-7890, 0812 3456 7890, 62812...
_FORMATTED_PHONE = re.compile(r"(?<![\w+])(?:\+62|62|0)[\s-]?8\d{1,3}(?:[\s-]?\d{2,4}){2,3}(?!\d)")
# Indonesian plates: region code, 1-4 digits, 1-3 letter suffix ("B 1234 CD", "B1234CD").
_PLATE_REGIONS = (
    "A|B|D|E|F|G|H|K|L|M|N|P|R|S|T|W|Z|AA|AB|AD|AE|AG|BA|BB|BD|BE|BG|BH|BK|BL|BM|BN|BP|"
    "DA|DB|DC|DD|DE|DG|DH|DK|DL|DM|DN|DR|DS|DT|EA|EB|ED|KB|KH|KT|KU|PA|PB"
)
_PLATE = re.compile(rf"\b(?:{_PLATE_REGIONS})\s?\d{{1,4}}\s?[A-Z]{{1,3}}\b")

PHONE_PLACEHOLDER = "[nomor telepon]"
PLATE_PLACEHOLDER = "[nomor polisi]"
NAME_PLACEHOLDER = "[nama]"


def mask_phone(digits: str) -> str:
    """``6281234567890`` -> ``62812****7890``: the first 5 and last 4 digits stay."""
    if len(digits) < 9:
        return digits
    return f"{digits[:5]}****{digits[-4:]}"


def mask_phones_in_text(text: str) -> str:
    """Mask every phone-number-like digit run (also inside a JID) in ``text``."""
    if not isinstance(text, str):
        return text
    return _DIGIT_RUN.sub(lambda m: mask_phone(m.group(0)), text)


def scrub_pii(text: str, names: Iterable[str] = ()) -> str:
    """Replace phone numbers, plates and the given personal names with placeholders.

    Names are matched case-insensitively on word boundaries, longest first, so
    "Budi Santoso" is replaced before a shorter "Budi" entry could split it.
    """
    if not isinstance(text, str) or not text:
        return text
    out = _FORMATTED_PHONE.sub(PHONE_PLACEHOLDER, text)
    out = _DIGIT_RUN.sub(PHONE_PLACEHOLDER, out)
    out = _PLATE.sub(PLATE_PLACEHOLDER, out)
    cleaned = sorted(
        {n.strip() for n in names if isinstance(n, str) and len(n.strip()) >= 3}, key=len, reverse=True
    )
    for name in cleaned:
        out = re.sub(rf"(?<!\w){re.escape(name)}(?!\w)", NAME_PLACEHOLDER, out, flags=re.IGNORECASE)
    return out
