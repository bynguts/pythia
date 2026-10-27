import { useEffect, useState } from "react";
import { Check, ChevronDown, Database, ExternalLink, ShieldCheck, X } from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { MetricStrip } from "../../shared/ui/MetricStrip.jsx";
import { ModelCard } from "./ModelCard.jsx";

const COPY = {
  id: {
    loading: "Memuat registri data…",
    error: "Data audit tidak dapat dimuat. Periksa koneksi lalu coba lagi.",
    retry: "Coba lagi",
    title: "Sumber data & model",
    description:
      "Periksa asal, tahun data, keterbatasan, dan kelayakan data yang digunakan dalam keputusan Pythia.",
    datasets: "Dataset terdaftar",
    documented: "sumber terdokumentasi",
    real: "Dataset berlabel riil",
    realHint: "menurut klasifikasi sumber",
    fresh: "Terkini atau baru",
    freshHint: "berdasarkan tahun data",
    fleetUnits: "Unit armada",
    census: "sensus truk 2025",
    sourceRegistry: "Registri sumber",
    provenance: "Asal dan keterbatasan data",
    dataset: "Dataset",
    datasetCount: (count) => `${count.toLocaleString("id-ID")} dataset`,
    unmapped: "Tidak dipetakan",
    status: "Status",
    rows: "Baris",
    granularity: "Resolusi",
    classification: "Klasifikasi",
    source: "Sumber",
    openSource: (name) => `Buka sumber ${name}`,
    internal: "Tautan tidak tersedia",
    emptyRegistry: "Belum ada dataset yang tercatat.",
    scentinel: {
      title: "Scentinel — penempatan sensor",
      empty: "Belum ada evidence Scentinel yang diimpor.",
      evidenceClass: "Simulasi eksternal",
      provenance: "Provenansi",
      digest: "Input digest",
      rows: "Baris CSV",
      boundaryTitle: "Batas model: ",
      boundary:
        "Hasil Scentinel adalah estimasi simulasi CFD untuk penapisan penempatan sensor — bukan pengukuran sensor kendaraan langsung. Gate validasi eksperimental menunjukkan status verifikasi lapangan saat ini.",
      gates: {
        pipeline_success: "Pipeline sukses",
        numerical_convergence: "Konvergensi numerik",
        mesh_independence: "Independensi mesh",
        mass_balance: "Keseimbangan massa",
        experimental_validation: "Validasi eksperimental",
      },
    },
    supportedResolution: "Resolusi yang didukung",
    emptyResolutions: "Belum ada penilaian resolusi.",
    modelNote: "Catatan model",
    unavailable: "Belum tersedia.",
    originalNote: "Catatan sumber (teks asli)",
    fleetComposition: "Komposisi armada",
    vehicleCensus: "Sensus truk 2025",
    emptyFleet: "Data komposisi armada belum tersedia.",
    sourcePrefix: "Sumber",
    freshness: { current: "Terkini", recent: "Baru", stale: "Lama", unknown: "Tidak diketahui" },
    classes: {
      real: "Riil",
      proxy: "Proksi",
      derived: "Turunan",
      calibrated_synthetic: "Sintetis terkalibrasi",
    },
    suitability: { high: "Tinggi", reliable: "Andal", low: "Rendah", not_supported: "Tidak didukung" },
    granularities: {
      "city-year": "kota/tahun",
      "landfill-month": "TPA/bulan",
      "fleet-census": "sensus armada",
      "tps-location": "lokasi TPS",
      "kecamatan-year": "kecamatan/tahun",
      "kelurahan-age-gender": "kelurahan/usia/jenis kelamin",
      event: "acara",
      "national-holiday": "libur nasional",
      "kelurahan-polygon": "poligon kelurahan",
      "wr-location": "lokasi wajib retribusi",
    },
    resolutions: {
      hotspot_rank: "Peringkat titik rawan",
      city_day: "Kota/hari",
      district_month: "Kecamatan/bulan",
      district_week: "Kecamatan/minggu",
      district_day: "Kecamatan/hari",
    },
    vehicleTypes: {
      "Arm Roll Besar": "Arm roll besar",
      "Arm Roll Kecil": "Arm roll kecil",
      "Compactor Besar": "Pemadat besar",
      "Compactor Kecil": "Pemadat kecil",
      "Compactor Listrik Kecil": "Pemadat listrik kecil",
      "Dump Truck Besar": "Truk bak besar",
      "Dump Truck Kecil": "Truk bak kecil",
      "Gerobak Motor": "Gerobak motor",
      Tronton: "Tronton",
      "Truk Arm Roll Besar": "Truk arm roll besar",
      "Truk Arm Roll Kecil": "Truk arm roll kecil",
      "Truk Compactor Besar": "Truk pemadat besar",
      "Truk Compactor Kecil": "Truk pemadat kecil",
      "Truk Compactor Listrik Besar": "Truk pemadat listrik besar",
      "Truk Compactor Listrik Kecil": "Truk pemadat listrik kecil",
      "Truk Dump Truk Besar": "Truk bak besar",
      "Truk Dump Truk Kecil": "Truk bak kecil",
      "Truk Tronton": "Truk tronton",
    },
    fleetSource: "Sensus truk DKI 2025 (data.go.id)",
    modelSourceNote:
      "Resolusi harian per kecamatan menggunakan data sintetis terkalibrasi dan tidak boleh disajikan sebagai akurasi teramati.",
  },
  en: {
    loading: "Loading data registry…",
    error: "Audit data could not be loaded. Check your connection and try again.",
    retry: "Try again",
    title: "Data sources & model",
    description:
      "Review the origin, data year, limitations, and suitability of data used in Pythia decisions.",
    datasets: "Registered datasets",
    documented: "documented sources",
    real: "Datasets labeled real",
    realHint: "per source classification",
    fresh: "Current or recent",
    freshHint: "based on data year",
    fleetUnits: "Fleet units",
    census: "2025 truck census",
    sourceRegistry: "Source registry",
    provenance: "Data origins and limitations",
    dataset: "Dataset",
    datasetCount: (count) => `${count.toLocaleString("en-US")} ${count === 1 ? "dataset" : "datasets"}`,
    unmapped: "Unmapped",
    status: "Status",
    rows: "Rows",
    granularity: "Resolution",
    classification: "Classification",
    source: "Source",
    openSource: (name) => `Open source for ${name}`,
    internal: "Link unavailable",
    emptyRegistry: "No datasets recorded yet.",
    scentinel: {
      title: "Scentinel — sensor placement",
      empty: "No Scentinel evidence has been imported yet.",
      evidenceClass: "External simulation",
      provenance: "Provenance",
      digest: "Input digest",
      rows: "CSV rows",
      boundaryTitle: "Model boundary: ",
      boundary:
        "Scentinel results are CFD screening estimates for sensor placement — not live vehicle sensor measurements. The experimental-validation gate reflects the current field-verification status.",
      gates: {
        pipeline_success: "Pipeline success",
        numerical_convergence: "Numerical convergence",
        mesh_independence: "Mesh independence",
        mass_balance: "Mass balance",
        experimental_validation: "Experimental validation",
      },
    },
    supportedResolution: "Supported resolutions",
    emptyResolutions: "No resolution assessments available yet.",
    modelNote: "Model note",
    unavailable: "Not available yet.",
    originalNote: "Source note (original wording)",
    fleetComposition: "Fleet composition",
    vehicleCensus: "2025 truck census",
    emptyFleet: "Fleet composition data is not available yet.",
    sourcePrefix: "Source",
    freshness: { current: "Current", recent: "Recent", stale: "Stale", unknown: "Unknown" },
    classes: {
      real: "Real",
      proxy: "Proxy",
      derived: "Derived",
      calibrated_synthetic: "Calibrated synthetic",
    },
    suitability: { high: "High", reliable: "Reliable", low: "Low", not_supported: "Not supported" },
    granularities: {
      "city-year": "city/year",
      "landfill-month": "landfill/month",
      "fleet-census": "fleet census",
      "tps-location": "TPS location",
      "kecamatan-year": "district/year",
      "kelurahan-age-gender": "village/age/gender",
      event: "event",
      "national-holiday": "national holiday",
      "kelurahan-polygon": "village polygon",
      "wr-location": "retribution payer location",
    },
    resolutions: {
      hotspot_rank: "Hotspot ranking",
      city_day: "City/day",
      district_month: "District/month",
      district_week: "District/week",
      district_day: "District/day",
    },
    vehicleTypes: {
      "Arm Roll Besar": "Large arm roll",
      "Arm Roll Kecil": "Small arm roll",
      "Compactor Besar": "Large compactor",
      "Compactor Kecil": "Small compactor",
      "Compactor Listrik Kecil": "Small electric compactor",
      "Dump Truck Besar": "Large dump truck",
      "Dump Truck Kecil": "Small dump truck",
      "Gerobak Motor": "Motorized cart",
      Tronton: "Heavy truck",
      "Truk Arm Roll Besar": "Large arm-roll truck",
      "Truk Arm Roll Kecil": "Small arm-roll truck",
      "Truk Compactor Besar": "Large compactor truck",
      "Truk Compactor Kecil": "Small compactor truck",
      "Truk Compactor Listrik Besar": "Large electric compactor truck",
      "Truk Compactor Listrik Kecil": "Small electric compactor truck",
      "Truk Dump Truk Besar": "Large dump truck",
      "Truk Dump Truk Kecil": "Small dump truck",
      "Truk Tronton": "Heavy truck",
    },
    fleetSource: "DKI truck census 2025 (data.go.id)",
    modelSourceNote:
      "Daily per-district resolution is calibrated-synthetic and must not be presented as observed accuracy.",
  },
};

// Translate only exact notes supplied by the provenance endpoint. Unknown wording remains
// visibly attributed to the source rather than being silently rewritten as a new claim.
const LIMITATIONS_ID = {
  "Yearly per-city daily-average timbulan; no daily or per-kecamatan resolution.":
    "Rata-rata timbulan harian per kota untuk tiap tahun; tidak tersedia resolusi harian atau per kecamatan.",
  "Monthly landfill intake totals; inconsistent tonase formats normalized on load; two corrupted rows corrected (2024-01 fix inferred, pending DLH confirmation) and the missing month 2023-12 kept as a gap.":
    "Total sampah masuk TPA per bulan; format tonase yang tidak konsisten dinormalisasi saat dimuat; dua baris rusak dikoreksi (koreksi 2024-01 bersifat dugaan, menunggu konfirmasi DLH) dan bulan 2023-12 yang hilang tetap dicatat sebagai celah.",
  "Yearly vehicle counts per wilayah/type, 2023-2025; the fleet size is the latest year's trucks (motor carts listed in 2024 are not trucks); not live telematics.":
    "Jumlah kendaraan tahunan menurut wilayah dan jenis, 2023-2025; ukuran armada adalah truk tahun terakhir (gerobak motor yang tercatat pada 2024 bukan truk); bukan telemetri langsung.",
  "TPS registry; no operational throughput capacity.": "Registri TPS; tidak memuat kapasitas operasional.",
  "Per-kecamatan generation modeled by SILIKA population formula (real source, modeled values); lat/lng column labels swapped in source.":
    "Timbulan per kecamatan dimodelkan dengan rumus populasi SILIKA (sumber riil, nilai dimodelkan); label kolom lat/lng tertukar pada sumber.",
  "TPS capacity is a PROXY (not official operational capacity); demand side is real SILIKA.":
    "Kapasitas TPS adalah PROKSI (bukan kapasitas operasional resmi); sisi kebutuhan berasal dari data riil SILIKA.",
  "2013 census snapshot; used only as relative population weights.":
    "Cuplikan sensus 2013; hanya digunakan sebagai bobot populasi relatif.",
  "Officially-scraped event calendar; attendance present only where published.":
    "Kalender acara yang diambil dari sumber resmi; jumlah pengunjung hanya tersedia jika diterbitkan.",
  "2026 holidays; applied by month-day across years for fixed-date approximation.":
    "Hari libur 2026; tanggal dan bulan diterapkan lintas tahun sebagai pendekatan tanggal tetap.",
  "267 DKI village polygons; administrative boundaries only.":
    "267 poligon kelurahan DKI; hanya batas administratif.",
  "Official SILIKA TPS location coordinate layer.": "Lapisan koordinat lokasi TPS dari SILIKA resmi.",
  "Official SILIKA Wajib Retribusi commercial waste generator coordinate layer; names, addresses and coordinators removed — category and area only.":
    "Lapisan koordinat penghasil sampah komersial Wajib Retribusi dari SILIKA resmi; nama, alamat, dan koordinator dihapus — hanya kategori dan wilayah.",
};

const BACKEND_MODEL_NOTE = COPY.en.modelSourceNote;
// The backend names the latest census year ("DKI truck census 2025 (data.go.id)"),
// so match the shape, not one year: a 2026 row must still read as the real census.
const isFleetCensus = (source) => /^DKI truck census \d{4} \(data\.go\.id\)$/.test(source || "");
// Source classification -> provenance label tone (design-system.png).
const CLASS_KIND = {
  real: "real",
  proxy: "proxy",
  derived: "model",
  calibrated_synthetic: "sim",
  unknown: "proxy",
};

function sourceNote(note, lang, copy) {
  if (!note) return copy.unavailable;
  if (lang === "en") return note;
  if (note === BACKEND_MODEL_NOTE) return copy.modelSourceNote;
  return LIMITATIONS_ID[note] || `${copy.originalNote}: ${note}`;
}

// Rendered as the "Sumber data & model" section of Settings (?tab=data),
// condensed: the summary strip stays open, the model card and the registry are collapsed.
// A calm registry: one joined strip, then two disclosure rows in one box;
// the registry opens onto a table with the evidence columns below it, never a side rail.
export function DataAuditWorkspace() {
  const { lang, t } = useLanguage();
  const copy = COPY[lang] || COPY.id;
  const resolutionLabel = (key) => copy.resolutions[key] || t(`audit_mc_res_${key}`);
  const locale = lang === "en" ? "en-US" : "id-ID";
  const [audit, setAudit] = useState(null);
  const [scentinel, setScentinel] = useState([]);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setError(false);
      try {
        // #23: Scentinel evidence is optional external screening data — its
        // failure must never take the audit workspace down.
        apiFetch("/scentinel/evidence", { signal: controller.signal })
          .then((r) => (r.ok ? r.json() : { items: [] }))
          .then((body) => {
            if (!controller.signal.aborted) setScentinel(Array.isArray(body.items) ? body.items : []);
          })
          .catch(() => {
            if (!controller.signal.aborted) setScentinel([]);
          });
        const responses = await Promise.all([
          apiFetch("/data/provenance", { signal: controller.signal }),
          apiFetch("/fleet/composition", { signal: controller.signal }),
          apiFetch("/ml/suitability", { signal: controller.signal }),
        ]);
        if (responses.some((response) => !response.ok)) throw new Error("Audit request failed");
        const [provenance, fleet, suitability] = await Promise.all(
          responses.map((response) => response.json()),
        );
        if (!Array.isArray(provenance?.records) || !fleet || !suitability?.resolutions) {
          throw new Error("Incomplete audit response");
        }
        if (!controller.signal.aborted) setAudit({ provenance, fleet, suitability });
      } catch (cause) {
        if (!controller.signal.aborted) {
          console.error("Failed to load audit data", cause);
          setError(true);
        }
      }
    }
    load();
    return () => controller.abort();
  }, [retry]);

  const heading = (
    <header className="settings-panel-head">
      <h2>{copy.title}</h2>
      <p>{copy.description}</p>
    </header>
  );

  if (!audit && !error)
    return (
      <section className="audit-workspace settings-panel" data-testid="audit-workspace" aria-busy="true">
        {heading}
        <div className="settings-box">
          <p className="settings-row settings-row-text" role="status">
            {copy.loading}
          </p>
        </div>
      </section>
    );
  if (error)
    return (
      <section className="audit-workspace settings-panel" data-testid="audit-workspace">
        {heading}
        <div className="settings-box">
          <div className="settings-row is-bad" role="alert">
            <p className="settings-row-text">{copy.error}</p>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setAudit(null);
                setRetry((count) => count + 1);
              }}
            >
              {copy.retry}
            </button>
          </div>
        </div>
      </section>
    );

  const { provenance, fleet, suitability } = audit;
  const records = provenance.records;
  const fleetTypes = fleet.by_vehicle_type || {};
  const resolutions = suitability.resolutions;
  const currentRecords = records.filter(
    (record) => record.freshness === "current" || record.freshness === "recent",
  ).length;
  const realRecords = records.filter((record) => record.classification === "real").length;
  const number = (value) => (value == null ? "—" : Number(value).toLocaleString(locale));
  const summary = [
    { label: copy.datasets, value: number(records.length), source: copy.documented, sourceKind: "proxy" },
    { label: copy.real, value: number(realRecords), source: copy.realHint, sourceKind: "real" },
    { label: copy.fresh, value: number(currentRecords), source: copy.freshHint, sourceKind: "proxy" },
    {
      label: copy.fleetUnits,
      value: number(fleet.total_units),
      source: isFleetCensus(fleet.source)
        ? copy.census
        : fleet.source
          ? `${copy.sourcePrefix}: ${fleet.source}`
          : copy.unavailable,
      sourceKind: isFleetCensus(fleet.source) ? "real" : "proxy",
    },
  ];

  return (
    <section className="audit-workspace settings-panel" data-testid="audit-workspace">
      {heading}

      <MetricStrip metrics={summary} label={copy.title} />

      <div className="settings-box">
        <details className="settings-disclosure" data-testid="model-card-disclosure">
          <summary>
            <span className="settings-glyph" aria-hidden="true">
              <ShieldCheck size={18} />
            </span>
            <span className="settings-row-text">
              <strong>{t("set_data_model_card")}</strong>
              <small>{t("set11_data_model_meta")}</small>
            </span>
            <ChevronDown className="settings-chevron" size={18} aria-hidden="true" />
          </summary>
          <div className="settings-disclosure-body">
            <ModelCard suitability={suitability} resolutionLabel={resolutionLabel} />
          </div>
        </details>

        <details className="settings-disclosure" data-testid="source-registry-disclosure">
          <summary>
            <span className="settings-glyph" aria-hidden="true">
              <Database size={18} />
            </span>
            <span className="settings-row-text">
              <strong>{t("set_data_registry")}</strong>
              <small>{copy.datasetCount(records.length)}</small>
            </span>
            <ChevronDown className="settings-chevron" size={18} aria-hidden="true" />
          </summary>
          <div className="settings-disclosure-body">
            <h3 className="settings-subhead">{copy.provenance}</h3>
            <div className="settings-table-wrap">
              <table className="audit-table" aria-label={copy.sourceRegistry}>
                <thead>
                  <tr>
                    <th scope="col">{copy.dataset}</th>
                    <th scope="col">{copy.granularity}</th>
                    <th scope="col" className="settings-num">
                      {copy.rows}
                    </th>
                    <th scope="col">{copy.classification}</th>
                    <th scope="col">{copy.status}</th>
                    <th scope="col">
                      <span className="sr-only">{copy.source}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {records.length === 0 && (
                    <tr>
                      <td colSpan={6}>{copy.emptyRegistry}</td>
                    </tr>
                  )}
                  {records.map((record) => {
                    const fresh = Object.hasOwn(copy.freshness, record.freshness)
                      ? record.freshness
                      : "unknown";
                    const cls = Object.hasOwn(copy.classes, record.classification)
                      ? record.classification
                      : "unknown";
                    return (
                      <tr key={record.name}>
                        <td>
                          <strong>{record.name}</strong>
                          <small>{sourceNote(record.limitations, lang, copy)}</small>
                        </td>
                        <td>{copy.granularities[record.granularity] || copy.unmapped}</td>
                        <td className="settings-num">{number(record.row_count)}</td>
                        <td>
                          <span className={`prov prov-${CLASS_KIND[cls]}`}>
                            {copy.classes[record.classification] || copy.freshness.unknown}
                          </span>
                        </td>
                        <td>
                          <span className={`freshness-badge ${fresh}`}>
                            {copy.freshness[record.freshness] || copy.freshness.unknown}
                          </span>
                        </td>
                        <td>
                          {String(record.source_url || "").startsWith("https://") ? (
                            <a
                              className="settings-icon-link"
                              href={record.source_url}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={copy.openSource(record.name)}
                            >
                              <ExternalLink size={16} aria-hidden="true" />
                            </a>
                          ) : (
                            <small>{copy.internal}</small>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="settings-evidence">
              <section data-testid="scentinel-evidence-panel" aria-labelledby="settings-scentinel-title">
                <h3 id="settings-scentinel-title" className="settings-subhead">
                  {copy.scentinel.title}
                </h3>
                {scentinel.length === 0 && <p className="settings-muted">{copy.scentinel.empty}</p>}
                {scentinel.map((ev) => (
                  <div key={ev.run_id} className="scentinel-run">
                    <div className="scentinel-run-head">
                      <strong>{ev.run_id}</strong>
                      <span className="prov prov-sim" data-testid="scentinel-evidence-class">
                        {copy.scentinel.evidenceClass}
                      </span>
                    </div>
                    <small className="settings-muted">
                      {ev.truck_code ? `${ev.truck_code} · ` : ""}
                      {ev.scenario} · {ev.gas_set.join(", ")}
                    </small>
                    <ul className="scentinel-gates" data-testid={`scentinel-gates-${ev.run_id}`}>
                      {Object.entries(ev.quality_gates || {}).map(([gate, ok]) => (
                        <li key={gate} className={ok ? "good" : "limited"}>
                          {ok ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
                          {copy.scentinel.gates[gate] || gate}
                          <span className="sr-only"> ({t(ok ? "set11_gate_pass" : "set11_gate_fail")})</span>
                        </li>
                      ))}
                    </ul>
                    <dl className="scentinel-facts audit-source">
                      <div>
                        <dt>{copy.scentinel.provenance}</dt>
                        <dd>
                          {ev.source_repository}@{ev.source_version}
                        </dd>
                      </div>
                      <div>
                        <dt>{copy.scentinel.digest}</dt>
                        <dd>
                          <code>{ev.input_digest}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>{copy.scentinel.rows}</dt>
                        <dd>{number(ev.sensor_csv_rows)}</dd>
                      </div>
                    </dl>
                  </div>
                ))}
                <p className="model-honesty-note">
                  <strong>{copy.scentinel.boundaryTitle}</strong>
                  {copy.scentinel.boundary}
                </p>
              </section>

              <section aria-labelledby="settings-suitability-title">
                <h3 id="settings-suitability-title" className="settings-subhead">
                  {copy.supportedResolution}
                </h3>
                <ul className="settings-list">
                  {Object.keys(resolutions).length === 0 && (
                    <li className="settings-muted">{copy.emptyResolutions}</li>
                  )}
                  {Object.entries(resolutions).map(([resolution, status]) => (
                    <li key={resolution}>
                      <span>{resolutionLabel(resolution)}</span>
                      <span className={`prov ${status === "backtested_real" ? "prov-real" : "prov-sim"}`}>
                        {copy.suitability[status] || t(`audit_suit_${status}`)}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="model-honesty-note">
                  <strong>{copy.modelNote}</strong>
                  {sourceNote(suitability.note, lang, copy)}
                </p>
              </section>

              <section aria-labelledby="settings-fleet-title">
                <h3 id="settings-fleet-title" className="settings-subhead">
                  {isFleetCensus(fleet.source) ? copy.vehicleCensus : copy.fleetComposition}
                </h3>
                <ul className="settings-list">
                  {Object.keys(fleetTypes).length === 0 && (
                    <li className="settings-muted">{copy.emptyFleet}</li>
                  )}
                  {Object.entries(fleetTypes).map(([type, count]) => (
                    <li key={type}>
                      <span>{copy.vehicleTypes[type] || type}</span>
                      <strong className="settings-num">{number(count)}</strong>
                    </li>
                  ))}
                </ul>
                <p className="settings-muted audit-source">
                  {copy.sourcePrefix}:{" "}
                  {isFleetCensus(fleet.source)
                    ? copy.fleetSource
                    : fleet.source
                      ? `${copy.originalNote}: ${fleet.source}`
                      : "—"}
                </p>
              </section>
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}
