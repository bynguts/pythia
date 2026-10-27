// Horizon prakiraan di halaman Besok (id): pilihan 7 / 14 / 30 hari, ringkasan rentang, strip
// dan grafik harian, panel belajar dari jembatan timbang dan baris bukti bulanan. Kunci
// berawalan "fh_"; hanya berkas ini yang memakainya.
export const fhId = {
  fh_days_heading: "{n} hari ke depan · se-kota, t/hari",
  fh_days_label: "Sampah se-kota per hari, {n} hari ke depan",
  fh_horizon_label: "Rentang prakiraan",
  fh_horizon_option: "{n} hari",
  fh_loading_days: "Memuat {n} hari ke depan",
  fh_error_days: "Prakiraan {n} hari gagal dimuat.",
  fh_total: "Total, {n} hari",
  fh_avg: "Rata-rata per hari",
  fh_peak: "Hari puncak",
  fh_peak_trucks: "Truk saat puncak",
  fh_peak_trucks_title:
    "Tonase tiap kecamatan pada hari puncak dibagi {cap} t per truk per sif, dibulatkan ke atas lalu dijumlahkan",
  fh_trucks_unit: "truk",
  fh_adjusted: "Disesuaikan {t} t",
  fh_dry_baseline: "Basis hari kering",
  fh_dry_baseline_title:
    "Di luar jendela Open-Meteo, model diberi hari kering: hujan 0 mm, 31 °C, angin 10 km/jam",
  fh_weather_window:
    "Cuaca Open-Meteo menggerakkan {with} hari pertama. Mulai {from}, tiap hari memakai basis hari kering (hujan 0 mm, 31 °C, angin 10 km/jam) dan makin tajam begitu masuk jendela cuaca.",
  fh_weather_all: "Cuaca Open-Meteo menggerakkan setiap hari dalam rentang ini.",
  fh_chart_hint: "Grafik prakiraan harian. Gunakan tombol panah kiri dan kanan untuk membaca tiap hari.",
  fh_chart_avg: "Rata-rata {t}",
  fh_key_forecast: "Dengan cuaca Open-Meteo",
  fh_key_beyond: "Basis hari kering",
  fh_axis_beyond: "Basis hari kering mulai {date}",
  fh_col_date: "Hari",
  fh_col_tons: "Prakiraan, t",
  fh_col_adjusted: "Disesuaikan, t",
  fh_col_weather: "Masukan cuaca",
  fh_weather_yes: "Prakiraan Open-Meteo",
  fh_weather_no: "Basis hari kering",
  fh_learn_title: "Belajar dari jembatan timbang",
  fh_learn_status: "Status",
  fh_learn_active: "Mengoreksi diri · {n} hari tertimbang",
  fh_learn_waiting: "Mengoreksi diri mulai hari ke‑{min} · {n} hari tertimbang",
  fh_learn_correction: "Koreksi",
  fh_learn_correction_from: "Mulai hari ke‑{min}",
  fh_learn_days: "Hari tertimbang dipakai",
  fh_learn_days_value: "{n} dari {window} terakhir",
  fh_learn_cap: "Batas",
  fh_learn_cap_value: "±{cap}%",
  fh_learn_since: "{from} – {to}",
  fh_learn_basis:
    "Tonase tertimbang setiap hari surat jalan yang ditutup dibandingkan dengan prakiraan rencana yang disetujui. {window} hari tertimbang terakhir, yang terbaru paling berbobot, menentukan koreksi (dibatasi ±{cap}%), dipelajari dari armada uji coba dan diterapkan ke prakiraan se-kota di samping angka model.",
  fh_learn_waiting_basis:
    "Setiap hari surat jalan yang ditutup dengan tiket timbang memberi masukan ke prakiraan. Mulai hari ke‑{min}, angka yang disesuaikan muncul di samping setiap prakiraan.",
  fh_learn_clamped: "Ditahan di batas ±{cap}%; hari tertimbang menunjuk {raw}.",
  fh_months_proof:
    "Teruji pada {n} bulan data timbangan nyata Bantargebang ({period}): galat {mape}% vs {naive}% untuk aturan sederhana terbaik, 1–{max} bulan ke depan.",
  fh_months_lebaran:
    "Paling tajam di bulan Lebaran (diarsir): galat {lebaran}% lebih kecil dari aturan sederhana, {normal}% di bulan biasa.",
  fh_months_more: "{months} terbuka begitu data timbangan Bantargebang terbaru masuk.",
  fh_months_pending: "Angka akurasi muncul di sini setelah uji mundur dijalankan.",
  fh_months_unavailable: "Angka asupan bulanan muncul di sini setelah model asupan dimuat.",
};
