"""Rule checks on a recorded weighbridge receipt: plain comparisons, not AI.

Each check compares numbers already on record (the recorded weights, the
reviewer-side OCR suggestion, the truck capacity, the sealed audit trail) and
says ``pass``, ``fail`` or ``unknown`` when a number it needs is missing.
A check with ``uses_ocr`` true reads the ticket OCR, which is MODEL OUTPUT: its
``fail`` asks a person to look at the ticket, it never changes a recorded weight.
``overall`` is ``review`` when any check fails, ``ok`` when none fails and the
two checks every sealed receipt can answer (seal, duplicate ticket photo) pass, and
``unknown`` otherwise (for instance a receipt recorded before sealing).
"""

from __future__ import annotations

from typing import Any

from app.core.units import TRUCK_CAPACITY_TONS
from app.field.spj import normalize_ticket_no

# The OCR gross may differ from the recorded gross by this much before it is flagged.
OCR_TOLERANCE_SHARE = 0.02
OCR_TOLERANCE_MIN_KG = 200.0
# Gross - tare may differ from the printed net by this much (rounding on the ticket).
TICKET_ARITHMETIC_TOLERANCE_KG = 20.0
BASIS = "Rule checks, not AI: recorded weights, the sealed audit trail and the ticket OCR (MODEL OUTPUT)."
OCR_CHECKS = (
    "ticket_document",
    "ocr_vs_entered",
    "ticket_arithmetic",
    "duplicate_ticket_no",
    "plate_vs_truck",
)


def _check(check_id: str, state: str, detail: str, **numbers: Any) -> dict[str, Any]:
    return {
        "id": check_id,
        "state": state,
        "detail": detail,
        "uses_ocr": check_id in OCR_CHECKS,
        "numbers": numbers,
    }


def _plate(value: Any) -> str | None:
    if not value:
        return None
    return "".join(ch for ch in str(value).upper() if ch.isalnum()) or None


def _kg(value: float) -> str:
    return f"{value:,.0f} kg"


def _ocr_vs_entered(receipt: dict) -> dict[str, Any]:
    ocr_gross = (receipt.get("ocr") or {}).get("gross_kg")
    gross = receipt.get("gross_weight_kg")
    if gross is None:
        gross = receipt.get("total_weight_kg")
    if ocr_gross is None or gross is None:
        missing = "no OCR reading of the ticket" if ocr_gross is None else "no recorded gross weight"
        return _check(
            "ocr_vs_entered", "unknown", f"Cannot compare: {missing}.", ocr_gross_kg=ocr_gross, gross_kg=gross
        )
    difference = round(abs(float(ocr_gross) - float(gross)), 1)
    tolerance = round(max(OCR_TOLERANCE_SHARE * float(gross), OCR_TOLERANCE_MIN_KG), 1)
    numbers = {
        "ocr_gross_kg": ocr_gross,
        "gross_kg": gross,
        "difference_kg": difference,
        "tolerance_kg": tolerance,
    }
    if difference > tolerance:
        detail = (
            f"Ticket OCR reads {_kg(ocr_gross)}, recorded gross is {_kg(gross)} ({_kg(difference)} apart)."
        )
        return _check("ocr_vs_entered", "fail", detail, **numbers)
    return _check(
        "ocr_vs_entered", "pass", f"Ticket OCR and recorded gross agree within {_kg(tolerance)}.", **numbers
    )


def _net_vs_capacity(receipt: dict) -> dict[str, Any]:
    capacity = TRUCK_CAPACITY_TONS * 1000.0
    net = receipt.get("net_weight_kg")
    gross = receipt.get("gross_weight_kg")
    if gross is None:
        gross = receipt.get("total_weight_kg")
    tare = receipt.get("tare_weight_kg")
    difference = round(float(gross) - float(tare), 1) if gross is not None and tare is not None else None
    numbers = {"net_kg": net, "gross_minus_tare_kg": difference, "capacity_kg": capacity}
    loads = [value for value in (net, difference) if value is not None]
    if not loads:
        return _check(
            "net_vs_capacity", "unknown", "No tare recorded, so the net load is not known.", **numbers
        )
    heaviest = max(loads)
    if heaviest > capacity:
        detail = f"Net load {_kg(heaviest)} is above the truck capacity of {_kg(capacity)}."
        return _check("net_vs_capacity", "fail", detail, **numbers)
    return _check(
        "net_vs_capacity", "pass", f"Net load is within the {_kg(capacity)} truck capacity.", **numbers
    )


def _spj_list(others: list[dict]) -> str:
    return ", ".join(str(o.get("spj_number") or o.get("spj_id")) for o in others)


def _duplicate_photo(verify_result: dict, other_receipt_photo_hashes: dict[str, list]) -> dict[str, Any]:
    digest = verify_result.get("receipt_photo_sha256")
    if not digest:
        return _check("duplicate_ticket", "unknown", "The ticket photo was recorded before sealing.")
    others = other_receipt_photo_hashes.get(digest) or []
    numbers = {"photo_sha256": digest, "other_spj": others}
    if others:
        detail = f"The same ticket photo is sealed on another work order: {_spj_list(others)}."
        return _check("duplicate_ticket", "fail", detail, **numbers)
    return _check("duplicate_ticket", "pass", "No other work order carries this ticket photo.", **numbers)


def _duplicate_ticket_no(receipt: dict, other_ticket_numbers: dict[str, list]) -> dict[str, Any]:
    ticket = normalize_ticket_no((receipt.get("ocr") or {}).get("ticket_no"))
    if not ticket:
        return _check("duplicate_ticket_no", "unknown", "The ticket OCR read no ticket number.")
    others = other_ticket_numbers.get(ticket) or []
    numbers = {"ticket_no": ticket, "other_spj": others}
    if others:
        detail = f"Ticket no. {ticket} is also on another work order: {_spj_list(others)}."
        return _check("duplicate_ticket_no", "fail", detail, **numbers)
    return _check("duplicate_ticket_no", "pass", f"Ticket no. {ticket} is on no other work order.", **numbers)


def _ticket_arithmetic(receipt: dict) -> dict[str, Any]:
    ocr = receipt.get("ocr") or {}
    gross, tare, net = ocr.get("gross_kg"), ocr.get("tare_kg"), ocr.get("net_kg")
    numbers = {
        "gross_kg": gross,
        "tare_kg": tare,
        "net_kg": net,
        "tolerance_kg": TICKET_ARITHMETIC_TOLERANCE_KG,
    }
    if gross is None or tare is None or net is None:
        return _check(
            "ticket_arithmetic", "unknown", "The ticket OCR did not read gross, tare and net.", **numbers
        )
    difference = round(abs(float(gross) - float(tare) - float(net)), 1)
    numbers["difference_kg"] = difference
    if difference > TICKET_ARITHMETIC_TOLERANCE_KG:
        detail = (
            f"On the ticket, gross {_kg(gross)} - tare {_kg(tare)} is not the printed net {_kg(net)} "
            f"({_kg(difference)} apart)."
        )
        return _check("ticket_arithmetic", "fail", detail, **numbers)
    return _check("ticket_arithmetic", "pass", "Gross - tare = net on the ticket.", **numbers)


def _ticket_document(receipt: dict) -> dict[str, Any]:
    document = (receipt.get("ocr") or {}).get("document")
    if document == "not_a_ticket":
        detail = "The ticket OCR says the photo is not a weighbridge ticket."
        return _check("ticket_document", "fail", detail, document=document)
    if document == "weighbridge_ticket":
        return _check("ticket_document", "pass", "The photo is a weighbridge ticket.", document=document)
    if document == "scale_display":
        detail = "The photo shows a scale display, not a printed ticket."
    else:
        detail = "The ticket OCR could not tell what the photo shows."
    return _check("ticket_document", "unknown", detail, document=document)


def _sealed(verify_result: dict) -> dict[str, Any]:
    numbers = {
        "sealed_entries": verify_result.get("sealed_entries"),
        "legacy_unsealed": verify_result.get("legacy_unsealed"),
        "problems": verify_result.get("problems") or [],
    }
    broken = (
        not verify_result.get("chain_ok")
        or verify_result.get("receipt_photo_ok") is False
        or verify_result.get("receipt_weights_ok") is False
    )
    if broken:
        detail = f"Seal broken: {', '.join(numbers['problems']) or 'chain does not verify'}."
        return _check("sealed", "fail", detail, **numbers)
    if verify_result.get("receipt_photo_ok") is None or verify_result.get("receipt_weights_ok") is None:
        return _check("sealed", "unknown", "The receipt was recorded before sealing.", **numbers)
    return _check("sealed", "pass", "Audit trail and receipt match their seal.", **numbers)


def _plate_vs_truck(spj: Any, receipt: dict, truck_plate: str | None) -> dict[str, Any]:
    read = (receipt.get("ocr") or {}).get("plate")
    truck_code = getattr(spj, "truck_code", None)
    numbers = {"ocr_plate": read, "truck_code": truck_code, "truck_plate": truck_plate}
    if not _plate(read):
        return _check("plate_vs_truck", "unknown", "The ticket OCR read no plate.", **numbers)
    if not _plate(truck_plate):
        return _check(
            "plate_vs_truck", "unknown", "The fleet register has no plate for this truck.", **numbers
        )
    if _plate(read) != _plate(truck_plate):
        detail = f"The ticket plate {read} is not the plate of {truck_code} ({truck_plate})."
        return _check("plate_vs_truck", "fail", detail, **numbers)
    return _check("plate_vs_truck", "pass", "The ticket plate matches the truck.", **numbers)


def receipt_checks(
    spj: Any,
    receipt: dict,
    verify_result: dict,
    other_receipt_photo_hashes: dict[str, list],
    other_ticket_numbers: dict[str, list] | None = None,
    truck_plate: str | None = None,
) -> dict[str, Any]:
    """Cross-check one receipt.

    ``other_receipt_photo_hashes``: photo_sha256 -> other SPJs; ``other_ticket_numbers``:
    normalized ticket number -> other SPJs; ``truck_plate``: the fleet register's plate.
    ``integrity`` repeats the seal verdict (SpjStore.verify) for display.
    """
    checks = [
        _ticket_document(receipt),
        _ocr_vs_entered(receipt),
        _ticket_arithmetic(receipt),
        _net_vs_capacity(receipt),
        _duplicate_ticket_no(receipt, other_ticket_numbers or {}),
        _duplicate_photo(verify_result, other_receipt_photo_hashes),
        _sealed(verify_result),
        _plate_vs_truck(spj, receipt, truck_plate),
    ]
    states = {c["id"]: c["state"] for c in checks}
    if "fail" in states.values():
        overall = "review"
    elif states["sealed"] == "pass" and states["duplicate_ticket"] == "pass":
        overall = "ok"
    else:
        overall = "unknown"
    integrity = {
        key: verify_result.get(key)
        for key in ("chain_ok", "head_sha256", "receipt_photo_ok", "receipt_weights_ok", "problems")
    }
    return {"overall": overall, "basis": BASIS, "integrity": integrity, "checks": checks}


def _fleet_plate(truck_code: str | None) -> str | None:
    try:
        from app.fleet.data import TRUCKS

        return next((t.get("plate_number") for t in TRUCKS if t.get("truck_code") == truck_code), None)
    except Exception:  # noqa: BLE001 - no plate on file means "unknown", never an error
        return None


def checks_for(
    store: Any, spj: Any, photos: dict[str, list] | None = None, tickets: dict[str, list] | None = None
) -> dict[str, Any] | None:
    """The checks of a stored SPJ's receipt, or None without one.

    ``photos`` is ``store.sealed_receipt_photos()`` and ``tickets`` is
    ``store.receipt_ticket_numbers()``; pass them when checking many SPJs.
    """
    if not spj.receipt:
        return None
    photos = store.sealed_receipt_photos() if photos is None else photos
    tickets = store.receipt_ticket_numbers() if tickets is None else tickets
    other_photos = {d: [o for o in owners if o["spj_id"] != spj.spj_id] for d, owners in photos.items()}
    other_tickets = {t: [o for o in owners if o["spj_id"] != spj.spj_id] for t, owners in tickets.items()}
    # The fleet register is read only when the ticket OCR read a plate to compare.
    plate = _fleet_plate(spj.truck_code) if (spj.receipt.get("ocr") or {}).get("plate") else None
    return receipt_checks(spj, spj.receipt, store.verify(spj.spj_id), other_photos, other_tickets, plate)
