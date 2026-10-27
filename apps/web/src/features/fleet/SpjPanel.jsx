import { Fragment, useState, useEffect, useCallback } from "react";
import { LocateFixed } from "lucide-react";
import { apiFetch, apiGet, apiPost } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { formatDriverName } from "../../shared/format/driverName.js";

const copy = {
  id: {
    title: "Surat Perintah Jalan",
    create: "Buat SPJ baru",
    vehicle: "Kendaraan",
    selectVehicle: "Pilih kendaraan…",
    destination: "Tujuan pembuangan",
    priority: "Prioritas",
    normal: "Normal",
    vip: "VIP (permintaan khusus)",
    weighOnSite: "Timbang di lokasi",
    note: "Keterangan",
    searchSite: "Cari lokasi TPS…",
    addStop: "Tambah titik",
    removeStop: "Hapus titik",
    selectSite: "Pilih lokasi TPS dari daftar untuk menambahkan titik.",
    selectTruckStops: "Pilih kendaraan dan tambahkan setidaknya satu titik.",
    saving: "Menyimpan…",
    saveDraft: "Simpan draf",
    number: "Nomor",
    driver: "Pengemudi",
    truck: "Truk",
    destinationColumn: "Tujuan",
    progress: "Kemajuan",
    status: "Status",
    loading: "Memuat daftar SPJ…",
    loadingVehicles: "Memuat kendaraan…",
    loadingSites: "Memuat lokasi TPS…",
    empty: "Belum ada SPJ. Buat draf untuk memulai.",
    draft: "Draf",
    aktif: "Aktif",
    selesai: "Selesai",
    batal: "Dibatalkan",
    pending: "Belum selesai",
    completed: "Selesai",
    unknown: "Tidak diketahui",
    showDetails: "Tampilkan rincian",
    hideDetails: "Sembunyikan rincian",
    activate: "Ubah ke aktif",
    cancel: "Batalkan SPJ",
    tableLabel: "Daftar surat perintah jalan",
    evidenceLoading: "Memuat ringkasan bukti…",
    evidenceEmpty: "Belum ada bukti untuk SPJ ini.",
    arrival: "Kedatangan (geotag)",
    weighing: "Penimbangan",
    photos: "foto",
    officer: "Petugas",
    override: "Penyelesaian oleh pengawas",
    overrideReason: "Alasan pengawas (wajib, min. 10 karakter)",
    overrideSubmit: "Selesaikan dengan alasan",
    overrideHint: "Penyelesaian tanpa bukti lapangan hanya melalui pengawas dan tercatat di jejak audit.",
    evidenceRequired:
      "Titik hanya dapat diselesaikan dengan bukti lapangan dari aplikasi pengemudi. Pengawas dapat menyelesaikan seluruh SPJ dengan alasan yang tercatat.",
    close: "Tutup",
    retry: "Coba lagi",
    noSession: "Sesi berakhir atau belum masuk. Masuk kembali, lalu coba lagi.",
    forbidden:
      "Akun ini tidak memiliki izin untuk tindakan SPJ tersebut. Gunakan akun dengan izin pengiriman atau hubungi pengawas.",
    conflict: "Status atau persyaratan SPJ telah berubah. Perbarui daftar dan periksa titiknya.",
    invalid: "Periksa data SPJ lalu coba lagi.",
    serverFailed: "Layanan sedang bermasalah. Coba lagi nanti.",
    createFailed: "Gagal membuat SPJ",
    stopFailed: "Gagal menambahkan titik ke SPJ",
    actionFailed: "Gagal memperbarui SPJ",
    listFailed: "Gagal memuat daftar SPJ",
    fleetFailed: "Gagal memuat kendaraan",
    sitesFailed: "Gagal memuat lokasi TPS",
    evidenceFailed: "Gagal memuat ringkasan bukti",
    networkFailed: "Periksa koneksi dan coba lagi.",
    retryStops: "Draf SPJ sudah dibuat. Lanjutkan penambahan titik tanpa membuat draf baru.",
    continueStops: "Lanjutkan penambahan titik",
    missingDriver: "Kendaraan yang dipilih tidak memiliki pengemudi terdaftar.",
    count: "{n} SPJ",
  },
  en: {
    title: "Dispatch orders",
    count: "{n} work orders",
    create: "Create a dispatch order",
    vehicle: "Vehicle",
    selectVehicle: "Select a vehicle…",
    destination: "Disposal destination",
    priority: "Priority",
    normal: "Normal",
    vip: "VIP (special request)",
    weighOnSite: "Weigh on site",
    note: "Notes",
    searchSite: "Search TPS sites…",
    addStop: "Add stop",
    removeStop: "Remove stop",
    selectSite: "Select a TPS site from the list to add a stop.",
    selectTruckStops: "Select a vehicle and add at least one stop.",
    saving: "Saving…",
    saveDraft: "Save draft",
    number: "Number",
    driver: "Driver",
    truck: "Truck",
    destinationColumn: "Destination",
    progress: "Progress",
    status: "Status",
    loading: "Loading dispatch orders…",
    loadingVehicles: "Loading vehicles…",
    loadingSites: "Loading TPS sites…",
    empty: "No dispatch orders yet. Create a draft to get started.",
    draft: "Draft",
    aktif: "Active",
    selesai: "Completed",
    batal: "Canceled",
    pending: "Pending",
    completed: "Completed",
    unknown: "Unknown",
    showDetails: "Show details for",
    hideDetails: "Hide details for",
    activate: "Change to active",
    cancel: "Cancel order",
    tableLabel: "Dispatch order list",
    evidenceLoading: "Loading evidence summary…",
    evidenceEmpty: "No evidence recorded for this order.",
    arrival: "Arrival (geotag)",
    weighing: "Weighing",
    photos: "photos",
    officer: "Officer",
    override: "Closed by supervisor override",
    overrideReason: "Supervisor reason (required, 10+ characters)",
    overrideSubmit: "Complete with reason",
    overrideHint:
      "Closing an order without field evidence is a supervisor action and is recorded in the audit trail.",
    evidenceRequired:
      "Stops close only with field evidence from the driver app. A supervisor can close the whole order with a recorded reason.",
    close: "Close",
    retry: "Try again",
    noSession: "Your session has expired or you are not signed in. Sign in again, then retry.",
    forbidden:
      "This account cannot perform that dispatch action. Use an account with dispatch permission or contact a supervisor.",
    conflict: "The order status or requirements changed. Refresh the list and check its stops.",
    invalid: "Check the order details and try again.",
    serverFailed: "The service is unavailable. Try again later.",
    createFailed: "Could not create the dispatch order",
    stopFailed: "Could not add stops to the dispatch order",
    actionFailed: "Could not update the dispatch order",
    listFailed: "Could not load dispatch orders",
    fleetFailed: "Could not load vehicles",
    sitesFailed: "Could not load TPS sites",
    evidenceFailed: "Could not load evidence summary",
    networkFailed: "Check your connection and try again.",
    retryStops: "The draft was created. Continue adding stops without creating another draft.",
    continueStops: "Continue adding stops",
    missingDriver: "The selected vehicle has no assigned driver.",
  },
};

function errorMessage(error, label, words) {
  if (error.status === 401) return words.noSession;
  if (error.status === 403) return words.forbidden;
  if (error.status === 409) return `${label} (HTTP 409). ${words.conflict}`;
  if (error.status === 422 || error.status === 400)
    return `${label} (HTTP ${error.status}). ${words.invalid}`;
  if (error.status >= 500) return `${label} (HTTP ${error.status}). ${words.serverFailed}`;
  if (!error.status) return `${label}. ${words.networkFailed}`;
  return `${label} (HTTP ${error.status}).`;
}

// Gap 3: evidence photos need the bearer token, so they are fetched as blobs
// (an <img src> cannot send it) and shown from an object URL.
export function EvidencePhoto({ spjId, photo, stopName, width = 96, height }) {
  const { t } = useLanguage();
  const [large, setLarge] = useState(false);
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  const slotKey = photo.slot.startsWith("weighing") ? "weighing" : photo.slot;
  const slot = t(`spj6_slot_${slotKey}`);

  useEffect(() => {
    let url = null;
    let cancelled = false;
    const path = `/spj/${encodeURIComponent(spjId)}/evidence/${photo.n}${large ? "" : "/thumb"}`;
    apiFetch(path)
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
        setFailed(false);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [spjId, photo.n, large]);

  if (failed) return <span className="spj-hint">{t("spj6_photo_failed")}</span>;
  const label = t(large ? "spj6_photo_close" : "spj6_photo_open")
    .replace("{slot}", slot)
    .replace("{stop}", stopName);
  return (
    <button
      type="button"
      className="spj-evidence-photo"
      aria-label={label}
      aria-pressed={large}
      onClick={() => setLarge((value) => !value)}
      data-testid={`spj-evidence-photo-${photo.n}`}
      style={{ minWidth: "var(--tap-min)", minHeight: "var(--tap-min)", padding: 0 }}
    >
      {src && (
        <img
          src={src}
          alt={`${slot}, ${stopName}`}
          style={{
            display: "block",
            width: large ? "min(100%, 480px)" : `${width}px`,
            height: height && !large ? `${height}px` : "auto",
            objectFit: "cover",
          }}
        />
      )}
    </button>
  );
}

function GeotagNote({ geotag }) {
  const { t } = useLanguage();
  if (!geotag || !Number.isFinite(geotag.distance_to_stop_m)) return null;
  const dist = Math.round(geotag.distance_to_stop_m);
  const text =
    geotag.status === "approx"
      ? t("spj6_geo_approx")
      : Number.isFinite(geotag.accuracy_m)
        ? t("spj6_geo_gps").replace("{acc}", Math.round(geotag.accuracy_m)).replace("{dist}", dist)
        : t("spj6_geo_gps_noacc").replace("{dist}", dist);
  return (
    <span className={geotag.flagged ? "pill danger" : "pill"} data-testid="spj-geotag">
      {text}
      {geotag.status !== "approx" && geotag.flagged && ` · ${t("spj6_geo_far")}`}
    </span>
  );
}

// Roles holding dispatch:create (app/core/auth.py ROLES); only they may sign off a
// receipt weight. The server enforces it; this only hides buttons that would 403.
const RECEIPT_REVIEW_ROLES = ["dispatcher", "supervisor", "administrator"];
const RECEIPT_REVIEWED = ["confirmed", "corrected"];

function mayReviewReceipt() {
  try {
    return RECEIPT_REVIEW_ROLES.includes(localStorage.getItem("pythia_role"));
  } catch {
    return false;
  }
}

function receiptNeedsReview(receipt) {
  return !!receipt && !RECEIPT_REVIEWED.includes(receipt.ocr?.status);
}

// The thumbnail is a 320 px JPEG fetched with the bearer token; the enlarged
// view reads the stored original from the receipt-photo endpoint.
function ReceiptPhoto({ spjId }) {
  const { t } = useLanguage();
  const [large, setLarge] = useState(false);
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url = null;
    let cancelled = false;
    const base = `/spj/${encodeURIComponent(spjId)}/receipt`;
    const load = large
      ? apiGet(`${base}/photo`).then((body) =>
          body.photo_b64.startsWith("data:image/")
            ? body.photo_b64
            : `data:image/jpeg;base64,${body.photo_b64}`,
        )
      : apiFetch(`${base}/thumb`)
          .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
          .then((blob) => (url = URL.createObjectURL(blob)));
    load
      .then((next) => {
        if (cancelled) return;
        setSrc(next);
        setFailed(false);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [spjId, large]);

  if (failed) return <span className="spj-hint">{t("spj6_photo_failed")}</span>;
  return (
    <button
      type="button"
      className="spj-evidence-photo spj-receipt-photo"
      aria-label={t(large ? "spj7_receipt_photo_close" : "spj7_receipt_photo_open")}
      aria-pressed={large}
      onClick={() => setLarge((value) => !value)}
      data-testid="spj-receipt-photo"
    >
      {src && (
        <img
          src={src}
          alt={t("drv_receipt_photo_label")}
          style={{ display: "block", width: large ? "min(100%, 480px)" : "96px", height: "auto" }}
        />
      )}
    </button>
  );
}

export function ReceiptReview({ spj, act, pendingAction, words }) {
  const { lang, t } = useLanguage();
  const [correcting, setCorrecting] = useState(false);
  const [gross, setGross] = useState("");
  const [tare, setTare] = useState("");
  const [invalid, setInvalid] = useState(false);
  const receipt = spj.receipt;
  // Receipts recorded before H10 carry only the legacy total (= gross).
  const recordedGross = receipt.gross_weight_kg ?? receipt.total_weight_kg;
  const ocr = receipt.ocr;
  // Rule checks + seal verdict from the server (receipt.checks); null on payloads without them.
  const checks = receipt.checks;
  const failing = (checks?.checks || []).filter((c) => c.state === "fail");
  const sealBroken = failing.some((c) => c.id === "sealed");
  const sealed = checks?.checks?.some((c) => c.id === "sealed" && c.state === "pass");
  const sealHead = sealed ? checks.integrity?.head_sha256 : null;
  const status = ocr?.status || "none";
  const reviewed = RECEIPT_REVIEWED.includes(status);
  const allowed = mayReviewReceipt();
  const canReview = !reviewed && allowed;
  const path = `/spj/${encodeURIComponent(spj.spj_id)}/receipt/review`;
  const number = (n) => Number(n).toLocaleString(lang === "en" ? "en-US" : "id-ID");
  const kg = (n) => (n == null ? t("spj7_receipt_not_recorded") : `${number(n)} kg`);
  // A check's sentence from sl_check_<id>_<state> filled with its numbers; the server's
  // English detail when there is no key or a number the sentence needs is missing (in
  // Indonesian, a plain "needs a look" rather than English). Seal problems are codes.
  const fallback = (c) => (lang === "en" ? c.detail : t("lx_check_fallback"));
  const checkText = (c) => {
    const key = `sl_check_${c.id}_${c.state}`;
    const template = t(key);
    if (template === key) return fallback(c);
    let missing = false;
    const text = template.replace(/\{(\w+)\}/g, (_m, name) => {
      const value = c.numbers?.[name];
      if (value == null || (Array.isArray(value) && value.length === 0)) missing = true;
      else if (name === "problems") return value.map((code) => t(`lx_seal_${code}`)).join(", ");
      else if (Array.isArray(value)) return value.map((o) => o?.spj_number || o?.spj_id || o).join(", ");
      else if (typeof value === "number") return number(value);
      return value == null ? "" : String(value);
    });
    return missing ? fallback(c) : text;
  };

  // Weights the driver recorded (typed, or a phone OCR reading the driver accepted) are
  // labelled as the driver's, not as the reviewer-side OCR, whenever that OCR has no reading.
  const ocrReading = status === "unreviewed" && ocr.gross_kg != null;
  const driverWeights =
    !reviewed && !ocrReading && recordedGross != null && ["manual", "ocr"].includes(receipt.weight_source);

  const suggestion =
    status === "pending"
      ? t("drv_receipt_reading")
      : driverWeights
        ? t("spj7_receipt_check_driver")
        : status === "none"
          ? t("spj7_receipt_ocr_none")
          : ocr.gross_kg == null
            ? t(ocr.confidence === "low" ? "drv_receipt_unreadable" : "drv_receipt_unavailable")
            : t("drv_receipt_suggested")
                .replace("{source}", ocr.source || "OCR")
                .replace("{n}", number(ocr.gross_kg))
                .replace("{extra}", reviewed ? "" : t("drv_receipt_confirm_hint"))
                .trim();
  const badge = reviewed
    ? t(`spj7_receipt_badge_${status}`).replace("{who}", ocr.reviewed_by || "")
    : driverWeights
      ? t(`spj7_receipt_badge_driver_${receipt.weight_source}`)
      : t("spj7_receipt_badge_unreviewed");

  const startCorrecting = () => {
    setGross(String(recordedGross ?? ocr?.gross_kg ?? ""));
    setTare(receipt.tare_weight_kg == null ? "" : String(receipt.tare_weight_kg));
    setInvalid(false);
    setCorrecting(true);
  };

  const saveCorrection = async (event) => {
    event.preventDefault();
    const grossKg = Number(gross);
    const tareKg = tare.trim() === "" ? null : Number(tare);
    const tareOk = tareKg === null || (Number.isFinite(tareKg) && tareKg > 0 && tareKg < grossKg);
    if (!(Number.isFinite(grossKg) && grossKg > 0) || !tareOk) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (await act(path, { action: "correct", gross_weight_kg: grossKg, tare_weight_kg: tareKg })) {
      setCorrecting(false);
    }
  };

  return (
    <section
      className="spj-receipt-review"
      aria-label={t("spj7_receipt_title")}
      data-testid={`spj-receipt-review-${spj.spj_id}`}
    >
      <h4>{t("spj7_receipt_title")}</h4>
      <div className="spj-receipt-body">
        {receipt.has_photo !== false && <ReceiptPhoto spjId={spj.spj_id} />}
        <div className="spj-receipt-text">
          {(status !== "none" || driverWeights) && (
            <span className="pill info spj-receipt-badge" data-testid="spj-receipt-ocr-badge">
              {badge}
            </span>
          )}
          <p className="spj-hint" data-testid="spj-receipt-ocr-suggestion">
            {suggestion}
          </p>
          <p className="spj-receipt-recorded" data-testid="spj-receipt-recorded">
            <strong>{t("spj7_receipt_recorded")}:</strong> {t("spj7_receipt_gross")} {kg(recordedGross)} ·{" "}
            {t("spj7_receipt_tare")} {kg(receipt.tare_weight_kg)} · {t("spj7_receipt_net")}{" "}
            {kg(receipt.net_weight_kg)}
          </p>
          {checks && (
            <p className="spj-hint" data-testid="spj-receipt-seal">
              <span className={sealBroken ? "pill danger" : "pill"}>
                {sealBroken
                  ? t("sl_seal_broken")
                  : sealHead
                    ? t("sl_seal_ok").replace("{hash}", `sha256:${sealHead.slice(7, 15)}`)
                    : t("sl_seal_legacy")}
              </span>
            </p>
          )}
          {failing.length > 0 && (
            <div data-testid="spj-receipt-checks">
              <p className="spj-hint">{t("sl_checks_title")}</p>
              <ul>
                {failing.map((c) => (
                  <li key={c.id} data-testid={`spj-receipt-check-${c.id}`}>
                    <strong>{t(`sl_check_${c.id}`)}:</strong> {checkText(c)}
                    {c.uses_ocr && ` (${t("sl_check_ocr")})`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      {!reviewed && !allowed && <p className="spj-hint">{t("spj7_receipt_readonly")}</p>}
      {canReview && !correcting && (
        <div className="spj-receipt-actions">
          {status === "unreviewed" && ocr.gross_kg != null && (
            <button
              type="button"
              className="compact-enforce-btn spj-receipt-btn"
              data-testid="spj-receipt-confirm"
              disabled={!!pendingAction}
              onClick={() => act(path, { action: "confirm" })}
            >
              {t("spj7_receipt_confirm")}
            </button>
          )}
          <button
            type="button"
            className="compact-enforce-btn spj-receipt-btn"
            data-testid="spj-receipt-correct"
            disabled={!!pendingAction}
            onClick={startCorrecting}
          >
            {t("spj7_receipt_correct")}
          </button>
        </div>
      )}
      {canReview && correcting && (
        <form className="spj-override-form spj-receipt-form" onSubmit={saveCorrection}>
          <label>
            {t("drv_receipt_weight_label")}
            <input
              type="number"
              inputMode="decimal"
              min="1"
              step="any"
              value={gross}
              onChange={(event) => setGross(event.target.value)}
              data-testid="spj-receipt-gross"
            />
          </label>
          <label>
            {t("spj7_receipt_tare_label")}
            <input
              type="number"
              inputMode="decimal"
              min="1"
              step="any"
              value={tare}
              onChange={(event) => setTare(event.target.value)}
              data-testid="spj-receipt-tare"
            />
          </label>
          {invalid && (
            <p className="spj-form-error" role="alert">
              {t("spj7_receipt_invalid")}
            </p>
          )}
          <div className="spj-receipt-actions">
            <button
              type="submit"
              className="compact-enforce-btn spj-receipt-btn"
              data-testid="spj-receipt-save"
              disabled={!!pendingAction}
            >
              {t("spj7_receipt_save")}
            </button>
            <button
              type="button"
              className="compact-enforce-btn spj-receipt-btn"
              onClick={() => setCorrecting(false)}
            >
              {words.close}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

const initialForm = {
  truck_code: "",
  destination: "TPST Bantargebang",
  weigh_on_site: false,
  priority: "normal",
  note: "",
};

export function SpjCreateForm({ onCreated }) {
  const { lang, t } = useLanguage();
  const words = copy[lang] || copy.id;
  const [fleet, setFleet] = useState([]);
  const [sites, setSites] = useState([]);
  const [form, setForm] = useState(initialForm);
  const [stops, setStops] = useState([]);
  const [pick, setPick] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [pendingDraft, setPendingDraft] = useState(null);
  const [fleetError, setFleetError] = useState("");
  const [sitesError, setSitesError] = useState("");
  const [loadingFleet, setLoadingFleet] = useState(true);
  const [loadingSites, setLoadingSites] = useState(true);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    let active = true;
    apiGet("/fleet")
      .then((body) => {
        if (active) setFleet(body);
      })
      .catch((err) => {
        if (active) setFleetError(err);
      })
      .finally(() => {
        if (active) setLoadingFleet(false);
      });
    apiGet("/geo/tps-coordinates")
      .then((body) => {
        if (active)
          setSites(
            (body.features || [])
              .map((f) => ({
                name: f.properties?.name || "",
                kecamatan: f.properties?.kecamatan || "",
                address: f.properties?.name || "",
                lat: f.geometry?.coordinates?.[1],
                lng: f.geometry?.coordinates?.[0],
              }))
              .filter((s) => s.name && s.lat != null && s.lng != null),
          );
      })
      .catch((err) => {
        if (active) setSitesError(err);
      })
      .finally(() => {
        if (active) setLoadingSites(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const trucks = Array.isArray(fleet) ? fleet : fleet.trucks || [];

  const addStop = () => {
    const site = sites.find((s) => s.name === pick);
    if (!site) {
      setError({ key: "selectSite" });
      return;
    }
    setStops((prev) => [
      ...prev,
      {
        name: site.name,
        kecamatan: site.kecamatan || "",
        address: site.address || site.name,
        lat: site.lat,
        lng: site.lng,
      },
    ]);
    setPick("");
    setError(null);
  };

  // gsc P0-3: a DEMO stop at this device's GPS fix, so a judge can complete a
  // stop wherever the demo runs. The backend stores it DEMO-labelled.
  const addDemoStop = () => {
    // A real TPS stop comes first, so the DEMO stop is stop 2 or later and the
    // leg into it starts on the road network (the AR street path follows it).
    if (!stops.some((stop) => !stop.demo)) {
      setError({ demoKey: "spj_demo_needs_stop" });
      return;
    }
    if (!navigator.geolocation) {
      setError({ demoKey: "spj_demo_unavailable" });
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude: lat, longitude: lng } = position.coords;
        // gsc n17: stop names must be unique within an SPJ, so a second DEMO
        // stop gets its number (the first keeps the plain name).
        setStops((prev) => {
          const ordinal = prev.filter((stop) => stop.demo).length + 1;
          return [
            ...prev,
            {
              name: `DEMO · ${t("spj_demo_name")}${ordinal > 1 ? ` ${ordinal}` : ""}`,
              kecamatan: "DEMO",
              address: `DEMO · ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
              lat,
              lng,
              demo: true,
            },
          ];
        });
        setLocating(false);
      },
      (geoError) => {
        setLocating(false);
        setError({ demoKey: geoError.code === 1 ? "spj_demo_denied" : "spj_demo_unavailable" });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  const save = async () => {
    if (saving) return;
    if (!pendingDraft && (!form.truck_code || !stops.length)) {
      setError({ key: "selectTruckStops" });
      return;
    }
    const truck = trucks.find((t) => t.truck_code === form.truck_code);
    if (!pendingDraft && !truck?.driver_name) {
      setError({ key: "missingDriver" });
      return;
    }
    setSaving(true);
    setError(null);
    let draft = pendingDraft;
    let nextStop = pendingDraft?.nextStop || 0;
    try {
      if (!draft) {
        const spj = await apiPost("/spj", {
          driver_name: truck.driver_name,
          truck_code: form.truck_code,
          destination: form.destination,
          weigh_on_site: form.weigh_on_site,
          priority: form.priority,
          note:
            stops.some((stop) => stop.demo) && !form.note.includes("DEMO")
              ? `${form.note} [DEMO]`.trim()
              : form.note,
        });
        if (!spj.spj_id) throw new Error("Missing SPJ ID");
        draft = { id: spj.spj_id, stops: [...stops] };
      }
      for (; nextStop < draft.stops.length; nextStop++) {
        await apiPost(`/spj/${encodeURIComponent(draft.id)}/stops`, draft.stops[nextStop]);
      }
      setPendingDraft(null);
      setStops([]);
      setPick("");
      setForm(initialForm);
      onCreated();
    } catch (err) {
      setError({ cause: err, label: draft ? "stopFailed" : "createFailed", created: !!draft });
      if (draft) {
        setPendingDraft({ ...draft, nextStop });
        onCreated();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="spj-form">
      <h4>{words.create}</h4>
      <div className="spj-form-grid">
        <select
          value={form.truck_code}
          aria-label={words.vehicle}
          disabled={!!pendingDraft}
          onChange={(e) => setForm({ ...form, truck_code: e.target.value })}
        >
          <option value="">{loadingFleet ? words.loadingVehicles : words.selectVehicle}</option>
          {trucks.map((truck) => (
            <option key={truck.truck_code} value={truck.truck_code}>
              {truck.truck_code} — {formatDriverName(truck.driver_name, t).label}
            </option>
          ))}
        </select>
        <select
          value={form.destination}
          aria-label={words.destination}
          disabled={!!pendingDraft}
          onChange={(e) => setForm({ ...form, destination: e.target.value })}
        >
          {["TPST Bantargebang", "JRC Pesanggrahan", "RDF Plant Jakarta"].map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select
          value={form.priority}
          aria-label={words.priority}
          disabled={!!pendingDraft}
          onChange={(e) => setForm({ ...form, priority: e.target.value })}
        >
          <option value="normal">{words.normal}</option>
          <option value="vip">{words.vip}</option>
        </select>
        <label className="spj-weigh">
          <input
            type="checkbox"
            checked={form.weigh_on_site}
            disabled={!!pendingDraft}
            onChange={(e) => setForm({ ...form, weigh_on_site: e.target.checked })}
          />
          {words.weighOnSite}
        </label>
        <input
          type="text"
          aria-label={words.note}
          placeholder={words.note}
          value={form.note}
          disabled={!!pendingDraft}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />
      </div>
      <div className="spj-stop-picker">
        <input
          list="spj-sites"
          aria-label={words.searchSite}
          placeholder={loadingSites ? words.loadingSites : words.searchSite}
          value={pick}
          disabled={!!pendingDraft}
          onChange={(e) => setPick(e.target.value)}
        />
        <datalist id="spj-sites">
          {sites.map((s, i) => (
            <option key={i} value={s.name} />
          ))}
        </datalist>
        <button
          type="button"
          className="compact-enforce-btn"
          onClick={addStop}
          disabled={loadingSites || !!pendingDraft}
        >
          {words.addStop}
        </button>
      </div>
      <div className="spj-demo-stop">
        <button
          type="button"
          className="compact-enforce-btn"
          data-testid="spj-demo-stop"
          onClick={addDemoStop}
          disabled={locating || !!pendingDraft}
        >
          <LocateFixed size={16} aria-hidden="true" />
          {locating ? t("spj_demo_locating") : t("spj_demo_stop")}
        </button>
        <p className="spj-hint">{t("spj_demo_hint")}</p>
      </div>
      {stops.length > 0 && (
        <ul className="spj-stop-list">
          {stops.map((s, i) => (
            <li key={i}>
              {i + 1}. {s.name} ({s.kecamatan})
              {s.demo && (
                <span className="pill provenance-sim" data-testid="spj-demo-badge">
                  {t("spj_demo_badge")}
                </span>
              )}
              <button
                type="button"
                aria-label={`${words.removeStop}: ${s.name}`}
                disabled={!!pendingDraft}
                onClick={() => setStops(stops.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {fleetError && (
        <p className="spj-form-error" role="alert">
          {errorMessage(fleetError, words.fleetFailed, words)}
        </p>
      )}
      {sitesError && (
        <p className="spj-form-error" role="alert">
          {errorMessage(sitesError, words.sitesFailed, words)}
        </p>
      )}
      {error && (
        <p className="spj-form-error" role="alert">
          {error.key
            ? words[error.key]
            : error.demoKey
              ? t(error.demoKey)
              : `${errorMessage(error.cause, words[error.label], words)}${error.created ? ` ${words.retryStops}` : ""}`}
        </p>
      )}
      <button type="button" className="compact-enforce-btn" disabled={saving} onClick={save}>
        {saving ? words.saving : pendingDraft ? words.continueStops : words.saveDraft}
      </button>
    </div>
  );
}

export function SpjPanel() {
  const { lang, t } = useLanguage();
  const words = copy[lang] || copy.id;
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [pendingAction, setPendingAction] = useState("");
  const [open, setOpen] = useState(null);
  const [evidence, setEvidence] = useState(null);
  const [evidenceError, setEvidenceError] = useState(null);
  const [evidenceLoading, setEvidenceLoading] = useState(null);
  const [overrideFor, setOverrideFor] = useState(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideError, setOverrideError] = useState("");

  const load = useCallback(async () => {
    try {
      const body = await apiGet("/spj");
      setItems(body.spj || []);
      setListError(null);
    } catch (err) {
      setListError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  const toggleOpen = (spjId) => {
    if (open === spjId) {
      setOpen(null);
      return;
    }
    setOpen(spjId);
    setEvidence(null);
    setEvidenceError(null);
    setEvidenceLoading(spjId);
    apiGet(`/spj/${encodeURIComponent(spjId)}/evidence-summary`)
      .then((body) => setEvidence({ spjId, body }))
      .catch((err) => setEvidenceError({ spjId, error: err }))
      .finally(() => setEvidenceLoading((current) => (current === spjId ? null : current)));
  };

  const act = async (path, payload) => {
    if (pendingAction) return false;
    setPendingAction(path);
    setActionError(null);
    try {
      await apiPost(path, payload);
    } catch (err) {
      setActionError(err);
      setPendingAction("");
      return false;
    }
    await load();
    if (open) {
      try {
        const body = await apiGet(`/spj/${encodeURIComponent(open)}/evidence-summary`);
        setEvidence({ spjId: open, body });
        setEvidenceError(null);
      } catch (err) {
        setEvidenceError({ spjId: open, error: err });
      }
    }
    setPendingAction("");
    return true;
  };

  const statusPill = {
    draft: "pill",
    aktif: "pill success",
    selesai: "pill live",
    batal: "pill danger",
  };

  return (
    <div className="panel-card spj-panel">
      <div className="panel-head">
        <h3>{words.title}</h3>
        <span className="pill">{words.count.replace("{n}", items.length)}</span>
      </div>
      <SpjCreateForm onCreated={load} />
      {actionError && (
        <p className="spj-form-error" role="alert">
          {errorMessage(actionError, words.actionFailed, words)}
        </p>
      )}
      {listError && (
        <p className="spj-form-error" role="alert">
          {errorMessage(listError, words.listFailed, words)}{" "}
          <button type="button" onClick={load}>
            {words.retry}
          </button>
        </p>
      )}
      {loading ? (
        <p role="status">{words.loading}</p>
      ) : items.length === 0 && !listError ? (
        <p>{words.empty}</p>
      ) : (
        <div className="table-wrap" role="region" aria-label={words.tableLabel} tabIndex={0}>
          <table className="spj-table">
            <thead>
              <tr>
                <th>{words.number}</th>
                <th>{words.driver}</th>
                <th>{words.truck}</th>
                <th>{words.destinationColumn}</th>
                <th>{words.progress}</th>
                <th>{words.status}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => {
                const stops = s.stops || [];
                const done = stops.filter((x) => x.status === "completed").length;
                const expanded = open === s.spj_id;
                const base = `/spj/${encodeURIComponent(s.spj_id)}`;
                return (
                  <Fragment key={s.spj_id}>
                    <tr className="spj-row">
                      <td>
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={`spj-detail-${s.spj_id}`}
                          aria-label={`${expanded ? words.hideDetails : words.showDetails} ${s.spj_number}`}
                          onClick={() => toggleOpen(s.spj_id)}
                        >
                          {s.spj_number}
                        </button>
                        {s.priority === "vip" && <> · {words.vip}</>}
                      </td>
                      <td>{formatDriverName(s.driver_name, t).label}</td>
                      <td>{s.truck_code}</td>
                      <td>{s.destination}</td>
                      <td>
                        {done}/{stops.length}
                      </td>
                      <td>
                        <span className={statusPill[s.status] || "pill"}>
                          {words[s.status] || words.unknown}
                        </span>
                        {receiptNeedsReview(s.receipt) && (
                          <span className="pill info" data-testid="spj-receipt-needs-review">
                            {t("spj7_receipt_needs_review")}
                          </span>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="spj-detail" id={`spj-detail-${s.spj_id}`}>
                        <td colSpan={6}>
                          <ol>
                            {stops.map((stop, i) => (
                              <li key={i}>
                                {stop.name} — {stop.kecamatan} · {words[stop.status] || words.unknown}
                                {stop.override && (
                                  <em className="spj-override-note">
                                    {" "}
                                    · {words.override}: {stop.override.reason} ({stop.override.actor})
                                  </em>
                                )}
                              </li>
                            ))}
                          </ol>
                          {s.status === "aktif" && <p className="spj-hint">{words.evidenceRequired}</p>}
                          {evidenceLoading === s.spj_id && <p role="status">{words.evidenceLoading}</p>}
                          {evidenceError?.spjId === s.spj_id && (
                            <p className="spj-form-error" role="alert">
                              {errorMessage(evidenceError.error, words.evidenceFailed, words)}
                            </p>
                          )}
                          {evidence?.spjId === s.spj_id &&
                            (evidence.body.stops.some(
                              (st) => st.has_arrival || st.weighing_count > 0 || st.officer_name,
                            ) ? (
                              <ul className="spj-evidence">
                                {evidence.body.stops.map(
                                  (st) =>
                                    (st.has_arrival || st.weighing_count > 0 || st.officer_name) && (
                                      <li key={st.index}>
                                        <strong>{st.name}:</strong> {st.has_arrival && `${words.arrival}; `}
                                        {st.weighing_count > 0 &&
                                          `${words.weighing}: ${st.weighing_count} ${words.photos}, ${st.total_weight_kg} kg (${Object.entries(
                                            st.fractions || {},
                                          )
                                            .map(
                                              ([f, kg]) =>
                                                `${t(`s4_wo_fraction_${f.toLowerCase()}`)} ${kg} kg`,
                                            )
                                            .join(", ")}); `}
                                        {st.officer_name && `${words.officer}: ${st.officer_name}`}{" "}
                                        <GeotagNote geotag={st.geotag} />
                                        {st.photos?.length > 0 && (
                                          <div
                                            role="group"
                                            aria-label={`${t("spj6_photos_label")}: ${st.name}`}
                                            style={{
                                              display: "flex",
                                              flexWrap: "wrap",
                                              gap: "var(--space-2)",
                                              marginTop: "var(--space-2)",
                                            }}
                                          >
                                            {st.photos.map((photo) => (
                                              <EvidencePhoto
                                                key={photo.n}
                                                spjId={s.spj_id}
                                                photo={photo}
                                                stopName={st.name}
                                              />
                                            ))}
                                          </div>
                                        )}
                                      </li>
                                    ),
                                )}
                              </ul>
                            ) : (
                              <p>{words.evidenceEmpty}</p>
                            ))}
                          {s.receipt && (
                            <ReceiptReview spj={s} act={act} pendingAction={pendingAction} words={words} />
                          )}
                          {s.status === "draft" && (
                            <button
                              type="button"
                              className="compact-enforce-btn"
                              disabled={!!pendingAction}
                              onClick={() => act(`${base}/activate`)}
                            >
                              {words.activate}
                            </button>
                          )}
                          {s.status === "aktif" &&
                            (overrideFor === s.spj_id ? (
                              <form
                                className="spj-override-form"
                                onSubmit={async (event) => {
                                  event.preventDefault();
                                  if (overrideReason.trim().length < 10) {
                                    setOverrideError(words.overrideReason);
                                    return;
                                  }
                                  setOverrideError("");
                                  const done = await act(`${base}/complete`, {
                                    override: true,
                                    reason: overrideReason.trim(),
                                  });
                                  // A refused override (e.g. a role without the
                                  // permission) keeps the form open with its reason
                                  // so the operator can retry, not retype.
                                  if (done) {
                                    setOverrideFor(null);
                                    setOverrideReason("");
                                  }
                                }}
                              >
                                <label>
                                  {words.overrideReason}
                                  <input
                                    type="text"
                                    value={overrideReason}
                                    onChange={(event) => setOverrideReason(event.target.value)}
                                    aria-label={words.overrideReason}
                                  />
                                </label>
                                {overrideError && (
                                  <p className="spj-form-error" role="alert">
                                    {overrideError}
                                  </p>
                                )}
                                <p className="spj-hint">{words.overrideHint}</p>
                                <button
                                  type="submit"
                                  className="compact-enforce-btn"
                                  disabled={!!pendingAction}
                                >
                                  {words.overrideSubmit}
                                </button>
                                <button
                                  type="button"
                                  className="compact-enforce-btn"
                                  onClick={() => {
                                    setOverrideFor(null);
                                    setOverrideReason("");
                                    setOverrideError("");
                                  }}
                                >
                                  {words.close}
                                </button>
                              </form>
                            ) : (
                              <button
                                type="button"
                                className="compact-enforce-btn"
                                disabled={!!pendingAction}
                                onClick={() => {
                                  setOverrideFor(s.spj_id);
                                  setOverrideReason("");
                                  setOverrideError("");
                                }}
                              >
                                {words.override}
                              </button>
                            ))}
                          {["draft", "aktif"].includes(s.status) && (
                            <button
                              type="button"
                              className="compact-enforce-btn"
                              disabled={!!pendingAction}
                              onClick={() => act(`${base}/cancel`)}
                            >
                              {words.cancel}
                            </button>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
