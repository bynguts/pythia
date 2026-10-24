# Narasi Demo & Batas Data Pythia

Dokumen ini menjelaskan alur demo yang direkomendasikan dan klasifikasi data jujur
(real vs simulasi) yang wajib disampaikan setiap kali Pythia dipresentasikan.

## Demo Utama (Alur Cerita)

1. **Buka Command Center** — perlihatkan KPI dan alert. Narasi: "Pythia mendeteksi
   2 kendala operasional di lapangan dan proyeksi lonjakan volume 41% di Jakarta Barat."
2. **Kasus rute (Case 1):** buka Fleet Operations, perlihatkan T-047 keluar koridor
   (>2 km), dan jelaskan sistem menjatuhkan recovery berupa Route B - Daan Mogot Recovery
   via OSRM/A* dynamic rerouting.
3. **Forecast:** buka Waste Forecast; jelaskan skenario "hujan ekstrem (>=30mm) +
   event 50jt + akhir pekan" menaikkan tonase; gunakan tool prediksi di sana.
4. **Optimasi armada:** buka Integrated Planning; jelaskan CP-SAT menugaskan truk yang
   tersedia & berizin ke area paling terdampak; tampilkan plan yang dihasilkan dan approve.
5. **Loop tertutup:** dispatch ke WhatsApp / FieldApp, konfirmasi kembali, tinjau
   history + executive summary di akhir sesi.

## Klasifikasi Data (WAJIB Jujur)

- **REAL**: baseline SILIKA 2023 DLH (TPS & wajib retribusi), Open-Meteo forecast/cuaca
  historis, kalender libur Indonesia, batas admin Jakarta, OSRM public routing, event resmi.
- **SIMULATED untuk prototype**: fleet GPS positions, breadcrumbs, keramaian event,
  pengumpul ilegal, sebagian sampah seed. Setiap kali data ini ditampilkan, tandai sumbernya.
- **Model prakiraan bulanan (satu-satunya yang divalidasi pada data riil)**: sampah masuk
  TPST Bantargebang (t/hari per bulan, data.go.id, Des 2022 s.d. Apr 2026) diprakirakan
  dengan rata-rata 12 bulan plus penyesuaian kalender Ramadan dan arus mudik Lebaran.
  Uji mundur titik awal bergulir (rolling-origin), 1–3 bulan ke depan: galat sekitar 13%
  lebih kecil daripada baseline sederhana terkuat (rata-rata 12 bulan); MAPE 4,3% vs 5,0%;
  interval 90% keunggulan +4% s.d. +23%. Hampir seluruh keunggulan datang dari bulan
  Lebaran (galat turun sekitar 40%); di bulan biasa model setara rata-rata 12 bulan.
  Angka resminya ada di `apps/api/data/models/forecast_evaluation.json` dan di kartu model
  pada workspace Audit Data & ML.
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
