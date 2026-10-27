// Strings (English).
export const slEn = {
  sl_seal_ok: "Sealed · {hash}",
  sl_seal_broken: "Seal broken",
  sl_seal_legacy: "Recorded before sealing",
  sl_checks_title: "Checks to review (rules, not AI)",
  sl_check_ocr: "from the ticket OCR reading",
  sl_check_ticket_document: "Ticket photo",
  sl_check_ocr_vs_entered: "OCR vs recorded gross",
  sl_check_ticket_arithmetic: "Ticket arithmetic",
  sl_check_net_vs_capacity: "Net vs truck capacity",
  sl_check_duplicate_ticket_no: "Duplicate ticket number",
  sl_check_duplicate_ticket: "Duplicate ticket photo",
  sl_check_sealed: "Seal",
  sl_check_plate_vs_truck: "Plate vs truck",
  sl_check_ticket_document_fail: "The ticket OCR says the photo is not a weighbridge ticket.",
  sl_check_ocr_vs_entered_fail:
    "Ticket OCR reads {ocr_gross_kg} kg, recorded gross is {gross_kg} kg ({difference_kg} kg apart, tolerance {tolerance_kg} kg).",
  sl_check_ticket_arithmetic_fail:
    "On the ticket, gross {gross_kg} kg - tare {tare_kg} kg is not the printed net {net_kg} kg ({difference_kg} kg apart).",
  sl_check_net_vs_capacity_fail: "The net load is above the truck capacity of {capacity_kg} kg.",
  sl_check_duplicate_ticket_no_fail: "Ticket no. {ticket_no} is also on another work order: {other_spj}.",
  sl_check_duplicate_ticket_fail: "The same ticket photo is sealed on another work order: {other_spj}.",
  sl_check_sealed_fail: "Seal broken: {problems}.",
  sl_check_plate_vs_truck_fail:
    "The ticket plate {ocr_plate} is not the plate of {truck_code} ({truck_plate}).",
};
