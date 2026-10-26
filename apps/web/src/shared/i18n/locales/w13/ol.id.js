// Outlook di halaman Besok (id): seminggu dan tiga bulan ke depan. Kunci berawalan "ol_";
// hanya lane outlook yang mengubah berkas ini.
export const olId = {
  ol_title: "Prakiraan ke depan",
  ol_aside: "Input terisi sendiri: cuaca, acara, hari libur",
  ol_model_title:
    "Keluaran model: minggu ini dari prakiraan Prophet + XGBoost per kecamatan yang dijumlahkan untuk kota; bulan-bulan dari model asupan Bantargebang",
  ol_week: "7 hari ke depan · se-kota, t/hari",
  ol_week_label: "Sampah se-kota per hari, 7 hari ke depan",
  ol_today: "Hari ini",
  ol_tomorrow: "Besok",
  ol_rain: "Hujan {mm} mm",
  ol_dry: "Kering",
  ol_no_weather: "Tanpa prakiraan cuaca",
  ol_no_weather_title: "Di luar jendela prakiraan Open-Meteo; model memakai hujan 0 mm",
  ol_weekend: "Akhir pekan",
  ol_event: "{name}",
  ol_event_title: "Di kalender kota atau izin yang diajukan",
  ol_months: "3 bulan ke depan · asupan Bantargebang, t/hari",
  ol_months_label: "Asupan Bantargebang per hari, 3 bulan ke depan",
  ol_within: "Dalam rentang backtest 1–{max} bulan",
  ol_beyond: "{h} bulan setelah data · di luar backtest 1–{max}",
  ol_evidence:
    "Galat {mape}% pada data timbangan nyata (backtest {period}) vs {naive}% untuk aturan sederhana terbaik",
  ol_evidence_none: "Galat backtest: —",
  ol_fitted: "Data s.d. {month}",
  ol_loading: "Memuat prakiraan ke depan",
  ol_error: "Prakiraan ke depan gagal dimuat.",
  ol_unavailable: "—",
};
