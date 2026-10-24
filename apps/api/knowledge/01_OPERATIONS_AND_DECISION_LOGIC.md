# 01. Logika Pengambilan Keputusan Pythia (Decision Logic)

Dokumen ini menjabarkan ambang batas dan alur yang dipakai sistem Pythia untuk mengambil
keputusan operasional. Ini adalah sumber jawaban utama Ana saat ditanya "kenapa rekomendasi ini?"

## A. Antrean TPA Bantargebang (Case 1)

- Status antrean (KPI, panel TPA, beacon peta & twin) = **jam puncak model** dari hari simulasi
  metrik harian (`queue_simulation.modelled_peak_hour`), dilabeli "modelled peak hour HH:00" —
  bukan jam dinding saat ini dan bukan pengukuran. Di twin, harinya = hari skenario yang dipilih.
- Ambang batas: wait < 45 menit -> green ("Green corridor clear. Normal dispatch speed approved.");
  45 <= wait < 90 -> yellow ("Stagger dispatch cycles by 20 minutes to flatten landfill load spike.");
  wait >= 90 -> red ("Delay departures of non-essential trucks by 30-45 minutes to relieve Bantargebang gridlock.").
- Asumsi jembatan timbang: 4 jalur x 30 truk/jam (siklus timbang 2 menit) = 120 truk/jam; asumsi model,
  bukan pengukuran fasilitas.

## B. Risiko / Spike Volume Sampah (Case 2)

- Hujan >= 30 mm -> spike +16% (banjir & cuaca memperlambat pengumpulan).
- Hujan >= 10 mm -> spike +8% (hujan memperlambat pengumpulan, sampah basah).
- Event keramaian berizin >= 50.000 orang -> +18%. Event >= 10.000 orang -> +9%.
- Akhir pekan -> +7% (aktivitas komersial dan ruang publik).
- `predicted_tons = baseline_tons * (1 + spike)`.
- `risk_level`: >=30% critical, >=20% high, >=10% watch, selain itu normal.
- Output per kelurahan menyertakan kebutuhan: tim kru, jam-orang (person-hours), tong/bin, truk, dan fuel/CO2. Satuan baku ada di `app/units.py` dan disertakan sebagai `units` pada setiap respons.

## C. Skor Rekomendasi Rute

- `score = eta_minutes * 0.55 + traffic_level * 35 + flood_risk * 45`.
- Hanya rute yang memenuhi izin (permit_compliant) yang dinilai. Pilih rute dengan skor terendah.
- Contoh: rute "Route B - Daan Mogot Recovery" adalah rute pemulihan yang direkomendasikan saat
  T-047 menyimpang dari koridor dan menggunakan OSRM.

## D. Simulasi Staggered Dispatch

- Simulasi ber-seed satu hari operasi di jembatan timbang Bantargebang (`queue_simulation.queue_minutes_per_truck`):
  baseline = "praktik saat ini": truk tiap shift berangkat sekitar awal shift dengan sebaran normal
  SD 30 menit (dipotong di +/-2 SD), asumsi yang dinyatakan; bertahap = keberangkatan dibagi ke slot 15 menit.
- Pita sensitivitas: baseline yang sama dihitung ulang untuk SD keberangkatan 10 / 30 / 60 menit
  (`sensitivity.baseline_band`), sehingga klaim berupa rentang, bukan satu titik.
- Jumlah kedatangan truk per hari = median ritasi harian dari data penimbangan Bantargebang (data.go.id);
  jumlah jalur timbang, durasi timbang dan durasi ritase adalah asumsi model, bukan pengukuran fasilitas.
- Metrik utama: "menit antre TPA per truk" (rata-rata, P95, CI 95% dari replikasi ber-seed), berlabel SIMULATED,
  tersedia di `GET /api/tpa/queue-metric` dan `landfill_queue.minutes_per_truck` pada scene twin Jakarta.
- `queue_reduction_percent` diturunkan dari metrik yang sama (baseline_wait vs optimized_wait).
- Tujuannya mereduksi antrean TPA pada jam sibuk dengan meratakan kedatangan.

## E. Deteksi Deviasi Rute (Case 1)

- Kuantifikasi jarak point-to-polyline: jarak titik GPS terkini ke lintasan yang ditetapkan
  (`engine.detect_route_deviation`).
- T-047 adalah truk demo deviasi kritis (.2.373 m dari koridor) dan menjadi subjek recovery rute.

## F. Optimasi Alokasi Kendaraan (Case 2 -> Case 1)

- OR-Tools CP-SAT: truk yang tersedia (available) dan memenuhi izin (permit_compliant)
  dialokasikan ke area dengan demand terbesar; tiap truk melayani satu area; demand teratasi
  jika kapasitas tersedia; setiap assignment disertai evidence (kapasitas, izin).
- Truk rusak (is_damaged) atau melanggar izin bukan objek alokasi kecuali `require_permit=False`.

## G. A* Dynamic Rerouting

- Saat `traffic_jam_active`, sistem menyalakan simulasi kemacetan; A* mencari rute pemulihan
  dari posisi truk (ORIGIN) menuju TPA Bantargebang; output `active_route` + recovery route.

## H. Integritas Data & Batas Demo (Kejujuran)

- Fleet GPS, event, dan beberapa seed waste = SIMULATED untuk prototype.
- Real: baseline SILIKA 2023 DLH, Open-Meteo (cuaca), kalender libur Indonesia, OSRM public
  routing, event resmi hasil scrape.
- Angka dampak (CO2, fuel, reduksi antrean) berasal dari simulasi ter-seed dan berlabel "simulasi"
  pada laporan — tidak boleh diklaim sebagai pengukuran lapangan.