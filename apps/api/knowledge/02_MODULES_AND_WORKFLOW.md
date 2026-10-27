# Modul & Workflow Pythia

Pythia adalah perangkat lunak operasional untuk armada sampah kota, dibangun dan diuji pada data
sampah publik DKI Jakarta (bukan produk resmi DLH). Pythia punya dua permukaan kerja: **konsol
dispatcher** (`/app/<halaman>`) dan **aplikasi sopir** (`/driver`). Keduanya menjalankan satu alur
harian: prakiraan, rencana, SPJ, gerbang TPA, struk timbang, rekap, lalu prakiraan belajar dari
hasil timbang. Armada di demo adalah armada simulasi dan diberi label begitu.

## Alur Tertutup (Closed Loop)

prakiraan → rencana → setujui → instruksi → jalankan hari → tutup hari → belajar

- **prakiraan:** prakiraan besok per kecamatan (hybrid Prophet + XGBoost per kecamatan, 42 model;
  pendorong cuaca/acara/akhir pekan/libur adalah asumsi perencanaan, target latihnya kalibrasi-sintetik)
  dan outlook kota 7, 14 atau 30 hari (`GET /api/forecast/outlook?days=`). Cuaca Open-Meteo diambil
  16 hari ke depan, jadi outlook 7 dan 14 hari memakai cuaca prakiraan nyata; hari 17–30 memakai
  baseline hari kering dan ditandai `beyond_weather_forecast`. Ditambah prakiraan bulanan sampah
  masuk Bantargebang yang divalidasi dengan uji mundur pada data timbang riil.
- **rencana:** rencana harian (Rencana harian) dari optimizer OR-Tools CP-SAT di halaman Besok.
- **setujui:** supervisor menyalakan Mode pengawas di sidebar konsol dan menyetujui rencana;
  persetujuan membuat satu draf SPJ per truk dengan stop TPS, slot gerbang 15 menit dan jam berangkat.
- **instruksi:** instruksi sampai ke aplikasi sopir; pesan WhatsApp lewat gateway Baileys (klien
  WhatsApp Web tidak resmi untuk prototipe; deployment dinas memakai WhatsApp Business Platform),
  dalam satu bahasa yang dipilih di Pengaturan (bawaan bahasa Indonesia).
- **jalankan hari:** kesiapan pagi per truk, peta Operasi dengan daftar "Perlu Anda", rekomendasi
  tahan slot gerbang, deviasi rute, jam kerja sopir dan lama tunggu gerbang (`app/field/safety.py`).
- **tutup hari:** struk timbang difoto sopir dan dibaca OCR, dicek dengan aturan dan disegel (rantai
  SHA-256); rekap harian membandingkan aktual dengan prakiraan (`GET /api/recap/daily`).
- **belajar:** setiap hari yang ditimbang mengoreksi prakiraan; koreksi aktif mulai hari timbang ketiga
  dan dibatasi +/-25 % (`app/forecast/learning.py`), ditampilkan di samping nilai model mentah.
- **audit:** riwayat semua event di `/api/history`; setiap SPJ punya jejak audit tersegel.

## Konsol dispatcher (`/app`)

1. **Operasi** (`/app/operations`) — peta dulu (armada simulasi), daftar "Perlu Anda" (instruksi
   belum diterima, truk keluar koridor, peringatan jam kerja, tunggu gerbang lama, struk yang gagal
   cek), kirim instruksi ke satu truk atau pesan ke grup WhatsApp.
2. **Kesiapan pagi** (`/app/readiness`) — per truk: cek pra-jalan, status jam kerja, instruksi
   diterima, status SPJ, kerusakan terbuka, servis jatuh tempo; aktivasi SPJ hari ini.
3. **Gerbang TPA** (`/app/gate`) — slot 15 menit Bantargebang (maks. 30 truk per slot), antrean,
   rekomendasi tahan slot yang bisa diterima, dan peringatan tunggu gerbang 180 menit.
4. **Surat jalan** (`/app/work-orders`) — daftar dan detail SPJ: stop, rute, slot, struk timbang dengan
   foto dan cek aturan, status segel, jejak audit.
5. **Besok** (`/app/tomorrow`) — prakiraan besok dan alasannya, outlook 7/14/30 hari, strip
   prakiraan bulanan Bantargebang dengan uji mundurnya, rencana harian dan persetujuannya. Kuota
   rit kecamatan, batas gerbang Bantargebang, aturan RDF Rorotan dan batas rit per truk adalah
   batas keras dari file aturan contoh (`EXAMPLE_CONFIG`, tiap nilai dengan sumbernya, wajib
   dikonfirmasi DLH); demand di atas batas tampil sebagai ton tak teralokasi.
6. **Armada & sopir** (`/app/fleet`) — truk, minggu sopir (rit, bukti, ketepatan gerbang, jam
   kerja) dan riwayat servis.
7. **Laporan** (`/app/reports`) — rekap tutup hari dan nilai per 1.000 rit gerbang.
8. **Pengaturan** (`/app/settings`) — akun dan tim, notifikasi, pairing WhatsApp lewat QR, data dan
   provenance beserta kartu model (galat prakiraan bulanan vs baseline sederhana terkuat pada data
   riil; resolusi harian/kecamatan berlabel kalibrasi-sintetik tanpa klaim akurasi), log audit, bahasa.

**Ana** bisa dibuka dari setiap halaman: menjawab dengan tool baca-saja, memberi rekomendasi, tidak
pernah men-dispatch atau menyetujui.

## Aplikasi sopir (`/driver`)

PWA untuk HP Android murah, login sopir, tetap jalan saat offline (outbox dengan operation id).
Instruksi rencana, stop berurutan di peta, "Ke TPA" dengan slot gerbang, tombol "Saya di gerbang", foto struk timbang dengan OCR yang dikonfirmasi sopir, cek pra-jalan, laporan kerusakan
dan kendala, serta navigasi AR ke stop untuk kru yang berjalan kaki.

## Keselamatan Sopir

Batas jam kerja (peringatan 600 menit, SPJ baru diblokir mulai 720 mnt kecuali override supervisor
beralasan yang diaudit) dan peringatan tunggu gerbang 180 menit (`app/core/units.py`); tampil di
Kesiapan pagi, Operasi, Gerbang TPA dan aplikasi sopir. Angka dari event aplikasi di server ini
(`OBSERVED_APP_EVENTS`); tanpa event hari itu tampil skenario berlabel SIMULATED yang tidak pernah
memblokir atau mengirim peringatan.

## Layout Kode

- Frontend: rute di `apps/web/src/app/App.jsx`; registry halaman konsol di
  `src/app/workspaces.js` dan `src/app/console/pages.js`; halaman di `src/pages/`, isinya di
  `src/features/`; aplikasi sopir di `src/surfaces/driver/`. Layar briefing lama (`/twin`, `/xr`)
  masih ada di kode tetapi bukan bagian produk.
- Backend: `app/main.py` hanya merangkai router; setiap area punya modul di
  `app/api/routers/`, logika di `app/forecast/`, `app/fleet/`, `app/field/`, `app/assistant/`.
