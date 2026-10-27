# 01. Logika Pengambilan Keputusan Pythia (Decision Logic)

Dokumen ini menjabarkan ambang batas dan alur yang dipakai sistem Pythia untuk mengambil
keputusan operasional. Ini adalah sumber jawaban utama Ana saat ditanya "kenapa rekomendasi ini?"
Produk Pythia punya dua permukaan: konsol dispatcher (`/app`: Operasi, Kesiapan pagi, Gerbang TPA,
Surat jalan, Besok, Armada & sopir, Laporan, Pengaturan) dan aplikasi sopir (`/driver`). Layar
briefing lama (twin `/twin`, XR `/xr`) masih ada di kode tetapi bukan bagian produk.

## A. Antrean TPA Bantargebang (Case 1)

- Status antrean (KPI dan halaman Gerbang TPA) = **jam puncak model** dari hari simulasi
  metrik harian (`queue_simulation.modelled_peak_hour`), dilabeli "modelled peak hour HH:00" —
  bukan jam dinding saat ini dan bukan pengukuran.
- Ambang batas KPI snapshot (`fleet.data.command_center_snapshot`): wait < 45 menit -> green
  (teks API `Green corridor clear. Normal dispatch speed approved.`); wait >= 45 -> yellow, dan >= 90 -> red;
  keduanya memakai rekomendasi API `Delay departures of non-essential trucks by 30-45 minutes to relieve
  Bantargebang gridlock.` Penjadwalan bertahap memakai slot 15 menit (`queue_simulation.STAGGER_SLOT_MINUTES`,
  lihat bagian D).
- Label panel TPA (`fleet.data.tpa_queue_status_payload`): < 30 menit NORMAL, 30–60 WARNING, > 60 CRITICAL.
- Asumsi jembatan timbang: 4 jalur x 30 truk/jam (siklus timbang 2 menit) = 120 truk/jam; asumsi model
  (`queue_simulation.WEIGHBRIDGE_ASSUMPTION`), bukan pengukuran fasilitas.

## B. Risiko / Spike Volume Sampah (Case 2)

- **Skala risiko yang dipakai semua layar konsol dan Ana** adalah
  `engine.spike_risk`. Spike satu hari = prakiraan kecamatan dibanding **hari normal**-nya:
  model yang sama, tanggal yang sama, tanpa hujan dan tanpa event (`engine.NORMAL_DAY_BASIS`).
  - >= 25% di atas hari normal -> `critical` (`engine.RISK_CRITICAL_RATIO` = 1,25).
  - >= 10% di atas hari normal -> `high` (`engine.RISK_HIGH_RATIO` = 1,10).
  - >= 3% di atas hari normal -> `elevated` (`engine.RISK_ELEVATED_RATIO` = 1,03).
  - Selain itu `normal`.
- "Berisiko" (at risk) = `high` atau `critical` (`engine.AT_RISK_LEVELS`). Itulah hitungan
  kecamatan berisiko di halaman Besok dan outlook (`kecamatan_at_risk`), dan syarat judul
  "{kecamatan} butuh tambahan kapasitas" di ringkasan eksekutif. Minggu tanpa hari hujan
  besar sering tidak punya kecamatan berisiko; layar lalu menampilkan keadaan kosong, bukan contoh.
  Contoh tetap (sample) hanya muncul saat backend tidak terjangkau, dengan label "offline sample".
- Efek hujan dan event adalah asumsi perencanaan yang ditetapkan tangan, bukan efek yang dipelajari
  dari data observasi (`engine.forecast_waste_risk`). Target latih model harian Prophet + XGBoost juga
  memakai pengali yang sama (`ml/data/processed/hybrid_forecaster_evaluation.md`), jadi model itu
  mereproduksi asumsi, bukan efek terukur:
  - Hujan >= 30 mm -> +16% (banjir & cuaca memperlambat pengumpulan).
  - Hujan >= 10 mm -> +8% (hujan memperlambat pengumpulan, sampah basah).
  - Event keramaian berizin >= 50.000 orang -> +18%. Event >= 10.000 orang -> +9%.
  - Akhir pekan -> +7% (aktivitas komersial dan ruang publik).
- Karena target latih memakai aturan bertangga (10 mm dan 30 mm), model tidak mempelajari efek
  tambahan di atas 30 mm. Jangan menafsirkan selisih antara, misalnya, hujan lebat dan ekstrem sebagai
  efek terukur (asumsi perencanaan).
- Efek hujan yang disajikan (`engine.rain_response_block`, field `rain_response` pada prakiraan per kecamatan)
  dibaca dari respons model pada grid 1 mm, dibuat tidak pernah turun saat hujan bertambah, dan tidak
  pernah di bawah hari normal kering. Respons mentah model sempat sedikit negatif pada hujan ringan
  (3–8 mm), yaitu derau di sekitar target yang tidak punya efek di bawah 10 mm; kini dibatasi pada
  hari normal. Di atas hujan harian terbesar data latih (`engine.TRAINING_RAIN_MAX_MM` = 96,7 mm)
  efeknya ditahan pada nilai itu (`held_at_mm`, `beyond_training_range`) dan respons menandainya.
- Hujan skenario (what-if) hanya dihitung pada harinya sendiri (`weather.carry_over.scenario` = false).
  Hujan **prakiraan** tetap masuk fitur `rain_3d`, jumlah hujan 3 hari bergulir seperti saat latih
  (`engine.rolling_rain_3d`, `engine.RAIN_3D_WINDOW_DAYS`), jadi ikut dihitung pada dua hari
  berikutnya. Payload scene briefing lama menyebut sisa hujan itu `weather.days[i].carried_rain_mm`.
- Kata hujan tanpa angka mm dibaca Ana sebagai kategori hujan harian BMKG
  (`scenario.RAIN_CATEGORIES`) dan dijalankan pada nilai wakil yang dinyatakan:
  - ringan 5–20 mm/hari -> 10 mm;
  - sedang 20–50 mm/hari -> 35 mm;
  - lebat 50–100 mm/hari -> 75 mm;
  - sangat lebat 100–150 mm/hari -> 125 mm;
  - ekstrem > 150 mm/hari -> 150 mm (batas bawah kategori).
- `predicted_tons = baseline_tons * (1 + spike)`.
- Output per kecamatan (42 model kecamatan) menyertakan kebutuhan: tim kru, jam-orang (person-hours),
  tong/bin, truk, dan fuel/CO2. Satuan baku ada di `app/core/units.py` dan disertakan sebagai `units`
  pada setiap respons.

### Endpoint lama `/api/predictions?event_scale=`

- Hanya endpoint lama ini yang masih memakai skala `risk_level` versi lama dari
  `engine.forecast_waste_risk` (spike aturan dibanding baseline, bukan hari normal): >= 30% critical,
  >= 20% high, >= 10% watch, selain itu normal. Tidak ada layar yang memakai skala ini.

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
  tersedia di `GET /api/tpa/queue-metric` dan dipakai halaman Besok serta nilai per 1.000 rit
  (`GET /api/reports/value-model`).
- `queue_reduction_percent` diturunkan dari metrik yang sama (baseline_wait vs optimized_wait).
- Tujuannya mereduksi antrean TPA pada jam sibuk dengan meratakan kedatangan.

## E. Deteksi Deviasi Rute (Case 1)

- Kuantifikasi jarak point-to-polyline: jarak titik GPS terkini ke lintasan yang ditetapkan
  (`engine.detect_route_deviation`).
- T-047 adalah truk demo deviasi (armada simulasi) dan menjadi subjek recovery rute. Jarak
  deviasinya dihitung ulang dari posisi simulasi saat itu; bacakan angka yang tampil di panel.

## F. Optimasi Alokasi Kendaraan (Case 2 -> Case 1)

- Rencana harian (`POST /api/operations/plan`, `operations_optimizer.build_operational_plan`):
  OR-Tools CP-SAT menentukan berapa rit truk 18 t yang dikirim tiap kecamatan per shift ke tiap
  fasilitas, untuk kecamatan dengan prakiraan tertinggi pada tanggal rencana (default 5, `top_n`).
  Armada = armada simulasi; demand = keluaran model.
- Batas keras dari file aturan bertanggal (`ml/data/config/operations_rules.json`, klasifikasi
  `EXAMPLE_CONFIG`: laporan berita dan asumsi yang dinyatakan, tiap nilai dengan sumbernya, wajib
  dikonfirmasi DLH): kuota rit per kecamatan (baru satu kecamatan yang punya contoh kuota),
  batas rit per shift dan per hari di gerbang Bantargebang, batas asupan dan syarat kendaraan
  RDF Rorotan, dan batas rit per truk per shift/hari.
- Demand yang tidak bisa dilayani batas itu dilaporkan sebagai ton tak teralokasi beserta batas
  yang mengikat, bukan disembunyikan. Rencana disetujui supervisor (`operations:approve`);
  persetujuan membuat instruksi dispatch per truk.
- Truk rusak (is_damaged) atau melanggar izin bukan objek alokasi kecuali `require_permit=False`.

## G. A* Dynamic Rerouting

- Simulasi ini tersedia lewat tool Ana (`simulate_astar_reroute`), bukan langkah alur harian konsol.
- Saat `traffic_jam_active`, sistem menyalakan simulasi kemacetan; A* mencari rute pemulihan
  dari posisi truk (ORIGIN) menuju TPA Bantargebang; output `active_route` + recovery route.

## H. Integritas Data & Batas Demo (Kejujuran)

- Fleet GPS, event, dan beberapa seed waste = SIMULATED untuk prototype.
- Real: baseline SILIKA 2023 DLH, Open-Meteo (cuaca), kalender libur Indonesia, OSRM public
  routing, event resmi hasil scrape.
- Angka dampak (CO2, fuel, reduksi antrean) berasal dari simulasi ter-seed dan berlabel "simulasi"
  pada laporan — tidak boleh diklaim sebagai pengukuran lapangan.

## I. Keselamatan Sopir (jam kerja dan tunggu gerbang)

- Ambang ada di `app/core/units.py`: `DUTY_WARN_MIN` = 600 menit (10 jam, peringatan),
  `DUTY_BLOCK_MIN` = 720 mnt (12 jam, blokir), `GATE_ALERT_MIN` = 180 menit (janji DLH:
  tunggu gerbang maksimal 3 jam).
- Jam kerja dihitung sejak cek pra-jalan atau aktivasi SPJ pertama pada hari WIB itu
  (`safety.observed_activity`). Mulai 720 mnt, membuat atau mengaktifkan SPJ baru untuk truk
  itu ditolak dengan alasan berbahasa Indonesia, kecuali supervisor/administrator (`spj:override`)
  mencatat override dengan alasan hari itu. Override (dengan username pemberinya), setiap SPJ
  yang diizinkannya, dan setiap penolakan tercatat di `/api/history`.
- Tunggu gerbang dihitung dari event `gate_arrival` SPJ sampai struk timbang. Mulai 180 menit,
  satu peringatan per kunjungan gerbang disimpan dan dikirim sekali ke grup WhatsApp supervisor
  bila diatur; pemeriksaan juga berjalan tiap 60 detik di latar belakang
  (`PYTHIA_SAFETY_GATE_TIMER`).
- Klasifikasi `OBSERVED_APP_EVENTS` bila server punya event aplikasi hari itu; bila tidak,
  skenario ber-seed berlabel SIMULATED yang tidak pernah memblokir SPJ atau mengirim peringatan.
  Keduanya tidak pernah dicampur.
