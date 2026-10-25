# Narasi Demo & Batas Data Pythia

Dokumen ini menjelaskan alur demo yang direkomendasikan dan klasifikasi data jujur
(real vs simulasi) yang wajib disampaikan setiap kali Pythia dipresentasikan.

## Demo Utama (Alur Cerita)

1. **Buka Command Center** — perlihatkan KPI dan alert. Narasi: bacakan angka dari strip KPI
   saat itu (jumlah truk berkendala, lonjakan prediksi tertinggi dan kecamatannya). Dokumen ini
   sengaja tidak menyebut angka: snapshot menghitungnya ulang, dan armadanya simulasi.
2. **Kasus rute (Case 1):** buka Fleet Operations, perlihatkan T-047 keluar koridor
   (jarak deviasi dihitung dari posisi simulasi dan tampil di panel), dan jelaskan sistem
   menjatuhkan recovery berupa Route B - Daan Mogot Recovery via OSRM/A* dynamic rerouting.
3. **Forecast:** buka Waste Forecast; jelaskan skenario "hujan >= 30 mm +
   event 50 ribu orang + akhir pekan" menaikkan tonase (aturan asumsi perencanaan, lihat
   dokumen 01 bagian B); gunakan tool prediksi di sana. Strip "sampah masuk Bantargebang"
   di workspace yang sama adalah satu-satunya prakiraan yang diuji mundur pada data riil.
4. **Rencana harian:** buka Planning; jelaskan CP-SAT membagi rit truk per shift dari armada
   simulasi yang tersedia & berizin ke kecamatan dengan prakiraan tertinggi, di bawah kuota,
   batas gerbang dan aturan fasilitas dari file aturan contoh (`EXAMPLE_CONFIG`, belum
   dikonfirmasi DLH); tampilkan rencana dan ton tak teralokasi, lalu supervisor menyetujuinya.
5. **Loop tertutup:** dispatch ke WhatsApp / FieldApp, konfirmasi kembali, tinjau
   history + executive summary di akhir sesi.

## Klasifikasi Data (WAJIB Jujur)

- **REAL**: baseline SILIKA 2023 DLH (TPS & wajib retribusi), Open-Meteo forecast/cuaca
  historis, kalender libur Indonesia, batas admin Jakarta, OSRM public routing, event resmi.
- **SIMULATED untuk prototype**: fleet GPS positions, breadcrumbs, keramaian event,
  pengumpul ilegal, sebagian sampah seed. Setiap kali data ini ditampilkan, tandai sumbernya.
- **Antrean TPA (SIMULATED)**: simulasi ber-seed (`queue_simulation`) dengan 1.228 truk/hari,
  median 12 bulan terakhir data penimbangan Bantargebang (data.go.id); jalur dan durasi timbang
  adalah asumsi. Pada hari normal waktu antre turun dari 57,1 menjadi 5,6 menit per truk dengan
  keberangkatan bertahap: keluaran simulasi, bukan pengukuran lapangan.
- **Keselamatan sopir**: jam kerja dan tunggu gerbang berlabel `OBSERVED_APP_EVENTS` bila
  dihitung dari event aplikasi di server ini (cek pra-jalan, aktivasi SPJ, tiba di gerbang,
  struk timbang); tanpa event hari itu tampil skenario berlabel SIMULATED. Ambang 600/720 mnt
  dan 180 menit adalah batas kebijakan di `app/core/units.py`, bukan hasil model.
- **Rencana harian dan kuota**: rit per shift adalah keluaran optimizer di atas armada simulasi
  dan demand keluaran model; kuota dan batas gerbang berasal dari file aturan contoh
  (`EXAMPLE_CONFIG`), bukan aturan resmi DLH yang sudah dikonfirmasi.
- **Model prakiraan bulanan (satu-satunya yang divalidasi pada data riil)**: sampah masuk
  TPST Bantargebang (t/hari per bulan, data.go.id, Des 2022 s.d. Apr 2026) diprakirakan
  dengan rata-rata 12 bulan plus penyesuaian kalender Ramadan dan arus mudik Lebaran.
  Uji mundur titik awal bergulir (rolling-origin), 1–3 bulan ke depan: galat sekitar 13%
  lebih kecil daripada baseline sederhana terkuat (rata-rata 12 bulan); MAPE 4,3% vs 5,0%;
  interval 90% keunggulan +4% s.d. +23%. Hampir seluruh keunggulan datang dari bulan
  Lebaran (galat turun sekitar 40%); di bulan biasa model setara rata-rata 12 bulan.
  Angka resminya ada di `apps/api/data/models/forecast_evaluation.json` dan di kartu model
  pada workspace Audit Data & ML.
- **Horizon tervalidasi**: data bulanan berakhir April 2026 (data.go.id) dan uji mundur hanya
  mencakup 1–3 bulan ke depan (Mei–Juli 2026). Bulan setelah itu adalah keluaran model di luar
  horizon yang diuji; workspace Waste Forecast menandai setiap bulan "di dalam" atau "di luar
  horizon uji mundur".
- **Batas klaim**: sedikit peristiwa Lebaran dalam uji mundur (satu tahun yang tidak biasa
  bisa menghapus keunggulan); koreksi sumber Jakarta Timur 2024-01 bersifat dugaan dan
  menunggu konfirmasi DLH.
- **Model harian per kecamatan** (Prophet + XGBoost): targetnya kalibrasi-sintetik (dibangkitkan
  pipeline sendiri), jadi TIDAK ada klaim akurasi harian/kecamatan, tidak ada klaim "kota/hari
  andal", dan skor lama (Spearman 0,998, R² 0,95–0,98, tabel multi-resolusi) BUKAN validasi.
  Angka lama 516,6 vs 423,1 sudah tidak berlaku: berasal dari baris sumber yang rusak dan
  konfigurasi Prophet yang overfit.

## Peran Asisten (Ana)

- Ana tegas soal batas demo, tidak mengarang angka, dan selalu menyarankan operator
  bertindak di dashboard.

## Demo yang Perlu Dihindari

- Jangan klaim WhatsApp terkirim bila gateway `connected=false`.
- Jangan presentasikan angka simulasi sebagai angka lapangan.
- Jangan terlalu banyak menjelaskan field teknis mentah (snake_case, koordinat) kepada
  audiens umum; gunakan bahasa manusia.
