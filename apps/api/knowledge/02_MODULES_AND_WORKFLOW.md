# Modul & Workflow Pythia

Pythia adalah prototipe command center operasional yang dibangun untuk studi kasus DLH DKI Jakarta
(bukan produk resmi DLH). Pythia menghubungkan pengawasan armada (armada simulasi), forecast sampah,
perencanaan dispatch, konfirmasi lapangan, dan pelaporan audit dalam satu alur kerja.

## Alur Tertutup (Closed Loop)

`detect -> predict -> recommend -> approve -> dispatch -> confirm -> audit`

- **detect:** deviasi rute, kerusakan truk, pengumpul ilegal (collector_registry), antrean TPA,
  jam kerja sopir dan lama tunggu di gerbang TPA (`app/field/safety.py`).
- **predict:** Waste Forecast 7 hari (hybrid Prophet + XGBoost per kecamatan, 42 model; driver
  cuaca/event/weekend/libur adalah asumsi perencanaan, target latihnya kalibrasi-sintetik) dan prakiraan
  bulanan sampah masuk Bantargebang (satu-satunya yang diuji mundur pada data riil).
- **recommend:** rekomendasi rute (skor ETA/traffic/flood), tambahan truk/kru/bin kebersihan,
  staggered dispatch.
- **approve:** supervisor menyetujui rencana harian (output CP-SAT optimizer) di dashboard;
  persetujuan membuat instruksi dispatch per truk.
- **dispatch:** instruksi dikirim ke sopir melalui FieldApp dan/atau WhatsApp Gateway (Baileys,
  klien WhatsApp Web tidak resmi yang hanya cocok untuk prototipe; pilot memakai WhatsApp
  Business Platform).
- **confirm:** status diubah (dispatch/selesai) dan tersimpan di HistoryStore.
- **audit:** riwayat semua event (`dispatch_created`, `dispatch_confirmed`, `assistant_query`,
  `executive_summary`) di `/api/history`; executive summary otomatis per tanggal.

## 9 Modul

1. **Command Center** — KPI (truk aktif, isu, antrean TPA), alert aktif, headline eksekutif, snapshot.
2. **Fleet Operations** — peta MapLibre (armada simulasi), status koridor, T-047 demo deviasi, route recovery.
3. **Waste Forecast** — prediksi per kecamatan (heatmap kelurahan diturunkan dari angka kecamatan), spike%, jam-orang (person-hours), tong/bin, truk, tim kru, tonase, CO2; plus strip prakiraan bulanan sampah masuk Bantargebang dengan tanda di dalam/di luar horizon uji mundur.
4. **Rencana harian** — CP-SAT optimizer: rit truk 18 t per shift dan fasilitas untuk kecamatan
   dengan prakiraan tertinggi (default 5), armada simulasi. Kuota rit kecamatan, batas gerbang
   Bantargebang, aturan RDF Rorotan dan batas rit per truk adalah batas keras dari file aturan
   contoh (`EXAMPLE_CONFIG`, tiap nilai dengan sumbernya, wajib dikonfirmasi DLH); demand yang
   tidak terlayani tampil sebagai ton tak teralokasi. Approve oleh supervisor.
5. **Dispatch & WhatsApp** — instruksi ke FieldApp + gateway Baileys; status koneksi gateway Baileys di `/api/whatsapp/status`.
6. **Field App** — halaman `/field` (login sopir): driver melihat misi, konfirmasi status.
7. **Model Audit** — `/api/ml/models`, suitability, dan kartu model: galat prakiraan bulanan sampah masuk TPA vs baseline sederhana terkuat pada data riil (uji mundur bergulir); resolusi harian/kecamatan berlabel kalibrasi-sintetik tanpa klaim akurasi.
8. **History & Reports** — executive summary, export, replay event.
9. **Keselamatan Sopir** — batas jam kerja (peringatan 600 menit, SPJ baru diblokir mulai
   720 mnt kecuali override supervisor beralasan yang diaudit) dan peringatan tunggu gerbang
   180 menit (`app/core/units.py`); panel di Fleet, `/pengawas` dan PWA sopir. Angka dari event
   aplikasi di server ini (`OBSERVED_APP_EVENTS`); tanpa event hari itu tampil skenario
   berlabel SIMULATED yang tidak pernah memblokir atau mengirim peringatan.

## Layout Frontend

- Frontend: rute di `apps/web/src/app/App.jsx`; workspace command center di
  `src/features/` (peta: `features/fleet/LiveFleetMap.jsx`); FieldApp terpisah di
  `src/surfaces/field/FieldApp.jsx`.
- Backend: `app/main.py` hanya merangkai router; setiap area punya modul di
  `app/api/routers/`, logika di `app/forecast/`, `app/fleet/`, `app/field/`,
  `app/assistant/` (engine, data, tools, astar_routing, osrm, dsb).