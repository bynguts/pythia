import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, CloudOff } from "lucide-react";
import { apiFetch, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { enqueueDriverOperation, OutboxStorageFullError } from "./DriverOutbox.js";
import { SyncChip } from "./DriverPanels.jsx";
import { receiptWeights } from "./driverHelpers.js";
import { PhotoSize } from "./StopProof.jsx";
import { postQueueable } from "./tripApi.js";

// The receipt as the server recorded it: weights plus weight_labels. The POST
// answer carries it as `receipt`; without one the SPJ is read back.
export async function recordedReceipt(spjId, body) {
  if (body?.receipt?.weight_labels) return body.receipt;
  try {
    const res = await apiFetch(`/spj/${encodeURIComponent(spjId)}`, { tokenKey: FIELD_TOKEN_KEY });
    return res.ok ? (await res.json()).receipt || null : null;
  } catch {
    return null;
  }
}

function tareKey(truckCode) {
  return `pythia_driver_tare_${truckCode}`;
}

// lteU7: the weighbridge ticket. The photo goes to the ticket OCR first; the
// driver confirms its reading ("Correct", recorded as ocr) or types the number
// ("Fix number", recorded as manual). No signal or no reading: typed only.
// The OCR reads the whole ticket: gross, plus the tare when printed (otherwise
// the tare is pre-filled from this phone); only the server computes the net.
export function WeighTicket({ spj, photo, online, pending, flushing, onBack, onDone, say }) {
  const { t, lang } = useLanguage();
  // reading | read | manual
  const [ocr, setOcr] = useState({ state: online ? "reading" : "manual", kg: null });
  const [editing, setEditing] = useState(!online);
  const [gross, setGross] = useState("");
  const [tare, setTare] = useState(() => {
    try {
      return localStorage.getItem(tareKey(spj.truck_code)) || "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // One id per submission: a retry after a dropped response replays the same
  // id, so the server returns the original receipt instead of a conflict.
  const operationId = useRef(null);
  const backRef = useRef(null);

  useEffect(() => {
    backRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!online) return undefined;
    let cancelled = false;
    apiFetch("/ocr/timbangan", { method: "POST", body: { photo_b64: photo.b64 }, tokenKey: FIELD_TOKEN_KEY })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body) => {
        if (cancelled) return;
        const kg = Number(body?.weight_kg);
        const hasGross = body?.weight_kg !== null && Number.isFinite(kg) && kg > 0;
        const tareKg = Number(body?.tare_kg);
        // The model reads the whole ticket: the tare it read replaces this phone's
        // last tare; ticket number and plate are shown for the driver to check.
        if (body?.tare_kg !== null && Number.isFinite(tareKg) && tareKg > 0 && (!hasGross || tareKg < kg)) {
          setTare(String(tareKg));
        }
        const ticket = {
          ticketNo: typeof body?.ticket_no === "string" ? body.ticket_no : null,
          plate: typeof body?.plate === "string" ? body.plate : null,
          notTicket: body?.document === "not_a_ticket",
        };
        if (hasGross) {
          setOcr({ state: "read", kg, ...ticket });
          setGross(String(kg));
        } else {
          setOcr({ state: "manual", kg: null, ...ticket });
          setEditing(true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setOcr({ state: "manual", kg: null });
        setEditing(true);
      });
    return () => {
      cancelled = true;
    };
    // One reading per ticket photo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo]);

  const weights = receiptWeights(gross, tare);
  const confirmed = ocr.state === "read" && Number(gross) === ocr.kg;
  const fmt = (kg) => Number(kg).toLocaleString(localeFor(lang), { maximumFractionDigits: 1 });

  const edit = (setter) => (e) => {
    setter(e.target.value);
    operationId.current = null; // edited weights are a new submission
  };

  const send = async () => {
    if (!weights.ok || busy || ocr.state === "reading") return;
    setBusy(true);
    setFailed(false);
    operationId.current = operationId.current || `${spj.spj_id}-${Date.now()}`;
    const path = `/spj/${spj.spj_id}/receipt`;
    const data = {
      photo_name: photo.name,
      photo_b64: photo.b64,
      ...weights.weights,
      ...(confirmed && weights.weights.total_weight_kg ? { weight_source: "ocr" } : {}),
      operation_id: operationId.current,
    };
    if (data.tare_weight_kg) {
      try {
        localStorage.setItem(tareKey(spj.truck_code), String(data.tare_weight_kg));
      } catch {
        // Pre-fill is a convenience only.
      }
    }
    try {
      const body = await postQueueable(path, data);
      markReceiptDone(spj.spj_id);
      onDone(await recordedReceipt(spj.spj_id, body));
    } catch (err) {
      if (err?.network) {
        // #45: the receipt replays with its stable operation_id, so a
        // reconnect can never double-record the handover.
        try {
          await enqueueDriverOperation({ path, data, label: t("drv_receipt_title") });
        } catch (queueErr) {
          setFailed(true);
          say(
            queueErr instanceof OutboxStorageFullError ? t("drv6_storage_full") : t("drv_receipt_failed"),
            8000,
          );
          return;
        }
        markReceiptDone(spj.spj_id);
        onDone(null);
        say(t("drv_queued_offline"));
      } else {
        setFailed(true);
        say(err.message || t("drv_receipt_failed"));
      }
    } finally {
      setBusy(false);
    }
  };

  const reading = ocr.state === "reading";
  return (
    <div
      className="drt-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drt-weigh-title"
      data-testid="weigh-ticket"
    >
      <header className="drt-head">
        <button
          ref={backRef}
          type="button"
          className="drt-icon-btn drt-back"
          onClick={onBack}
          disabled={busy}
          aria-label={t("d2_back")}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h2 className="drt-head-title" id="drt-weigh-title">
          {t("d2_weigh_title")}
        </h2>
        <SyncChip online={online} pending={pending} flushing={flushing} />
      </header>

      <div className="drt-layer-body">
        {!online && (
          <p className="drt-banner" role="status">
            <CloudOff size={16} aria-hidden="true" /> {t("d2_weigh_offline")}
          </p>
        )}
        <figure className="drt-ticket">
          <img src={photo.b64} alt={t("d2_weigh_photo_alt")} />
          <PhotoSize photo={photo} />
        </figure>

        <section className="drt-card" aria-labelledby="drt-read-title" data-testid="weigh-read">
          <div className="drt-read-head">
            <h2 id="drt-read-title">
              {editing || ocr.state !== "read" ? t("d2_weigh_manual_title") : t("d2_weigh_read_title")}
            </h2>
            {ocr.state === "read" && !editing ? (
              <span className="drt-tag" title={t("d2_weigh_ocr_tip")}>
                OCR
              </span>
            ) : (
              <span className="drt-tag is-manual">{t("d2_weigh_manual_tag")}</span>
            )}
          </div>

          {reading ? (
            <div className="drt-read-value" role="status" data-testid="weigh-reading">
              <strong className="is-reading">{t("d2_weigh_reading")}</strong>
            </div>
          ) : editing ? (
            <div className="drt-input-wrap">
              <label className="drt-sr" htmlFor="receipt-gross">
                {t("d2_weigh_gross_label")}
              </label>
              <input
                id="receipt-gross"
                data-testid="receipt-gross"
                className="drt-input is-big"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={gross}
                disabled={busy}
                onChange={edit(setGross)}
                placeholder="0"
              />
              <span className="drt-unit">kg</span>
            </div>
          ) : (
            <div className="drt-read-value" data-testid="weigh-ocr-value">
              <strong>{fmt(ocr.kg)}</strong>
              <span>kg</span>
            </div>
          )}

          {ocr.state === "manual" &&
            online &&
            (ocr.notTicket ? (
              <p className="drt-error" role="alert" data-testid="weigh-not-ticket">
                {t("oc_weigh_not_ticket")}
              </p>
            ) : (
              <p className="drt-note" data-testid="weigh-ocr-none">
                {t("d2_weigh_ocr_none")}
              </p>
            ))}

          {(ocr.ticketNo || ocr.plate) && (
            <p className="drt-note" data-testid="weigh-ticket-read" title={t("d2_weigh_ocr_tip")}>
              {t("oc_weigh_ticket_read")}{" "}
              {[
                ocr.ticketNo && `${t("oc_weigh_ticket_no")} ${ocr.ticketNo}`,
                ocr.plate && `${t("oc_weigh_plate")} ${ocr.plate}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}

          <div className="drt-field-row">
            <label className="drt-field-label is-grow" htmlFor="receipt-tare">
              {t("d2_weigh_tare_label")}
            </label>
            <div className="drt-input-wrap is-tare">
              <input
                id="receipt-tare"
                data-testid="receipt-tare"
                className="drt-input"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={tare}
                disabled={busy}
                onChange={edit(setTare)}
                placeholder="0"
              />
              <span className="drt-unit">kg</span>
            </div>
          </div>

          {!weights.ok && (
            <p className="drt-error" role="alert" data-testid="receipt-weight-error">
              {t(`drv7_receipt_${weights.error}_invalid`)}
            </p>
          )}
          <p className="drt-note">{t("d2_weigh_check")}</p>
        </section>
      </div>

      <div className="drt-layer-foot">
        {editing || ocr.state !== "read" ? (
          <button
            type="button"
            className="drt-btn is-primary"
            data-testid="receipt-send"
            onClick={send}
            disabled={busy || reading || !weights.ok}
          >
            <Check size={18} aria-hidden="true" /> {busy ? t("drv_receipt_sending") : t("d2_weigh_send")}
          </button>
        ) : (
          <div className="drt-btn-row">
            <button
              type="button"
              className="drt-btn is-secondary"
              data-testid="weigh-fix"
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              {t("d2_weigh_fix")}
            </button>
            <button
              type="button"
              className="drt-btn is-primary"
              data-testid="weigh-correct"
              disabled={busy || !weights.ok}
              onClick={send}
            >
              <Check size={18} aria-hidden="true" /> {busy ? t("drv_receipt_sending") : t("d2_weigh_correct")}
            </button>
          </div>
        )}
        {failed && (
          <p className="drt-error is-foot" role="alert" data-testid="receipt-retry-note">
            {t("drv_receipt_failed")}
          </p>
        )}
      </div>
    </div>
  );
}

export function markReceiptDone(spjId) {
  try {
    localStorage.setItem(`pythia_receipt_${spjId}`, "done");
  } catch {
    /* flag is best-effort; the server (or the queue) holds the receipt */
  }
}
