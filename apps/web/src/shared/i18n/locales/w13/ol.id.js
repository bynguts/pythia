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
  ol_months: "Asupan Bantargebang · tertimbang vs model, t/hari",
  ol_months_label: "Asupan Bantargebang per bulan: tertimbang vs model satu bulan ke depan, t/hari",
  ol_within: "Dalam rentang backtest 1–{max} bulan",
  ol_beyond:
    "Tanpa angka untuk {months}: {h} bulan setelah data timbangan terakhir ({through}), di luar backtest 1–{max} bulan",
  ol_evidence:
    "Model rata-rata 12 bulan yang disesuaikan kalender, diuji balik (backtest) pada {n} bulan data timbangan nyata TPST Bantargebang ({period}): galat {mape}% vs {naive}% untuk aturan sederhana terbaik, 1–{max} bulan ke depan",
  ol_evidence_none: "Galat backtest: —",
  ol_lebaran:
    "Keunggulannya dari bulan Lebaran (Ramadan dan mudik, diarsir): galat {lebaran}% lebih kecil dari aturan sederhana di sana, {normal}% di bulan biasa",
  ol_next: "Bulan berikutnya · dalam horizon backtest, t/hari",
  ol_bt_actual: "Tertimbang",
  ol_bt_model: "Model, 1 bulan ke depan",
  ol_bt_lebaran: "Lebaran",
  ol_bt_month: "Bulan",
  ol_bt_readout: "{month} · tertimbang {actual} · model {model} t/hari",
  ol_loading: "Memuat prakiraan ke depan",
  ol_error: "Prakiraan ke depan gagal dimuat.",
  ol_unavailable: "—",
  ol_learning: "Belajar dari {n} hari tertimbang · koreksi {pct}",
  ol_learning_off: "Mulai menyesuaikan setelah {min} hari tertimbang",
  ol_learning_so_far: "baru {n}",
  ol_learning_title:
    "Tonase jembatan timbang pada hari SPJ yang sudah ditutup dibanding prakiraan rencana; rata-rata berbobot hari terbaru, dibatasi ±{cap}%. Nilai model tetap ditampilkan.",
  ol_corrected: "Disesuaikan {t} t",
};
