# Panduan Operator Dashboard Pythia

Panduan ini menjelaskan cara membaca KPI, menginterpretasi alert, dan mengambil tindakan
operasional yang tepat di dashboard Pythia. Berlaku untuk semua peran: eksekutif, dispatcher,
pengawas, sopir, auditor, dan administrator.

## Login & Role

- Login muncul saat membuka konsol (`/app`) atau aplikasi sopir (`/driver`); `/` adalah
  halaman depan. Username = role (misal `dispatcher`). Di demo publik pythia.web.id password
  berpola `<role>pw` (misal `dispatcherpw`); saat dijalankan lokal, password bawaan
  `<role>-demo-pass`. Keduanya dapat dioverride via env `PYTHIA_PW_<ROLE>`.
- Username per peran: `executive`, `dispatcher`, `supervisor`, `driver`, `auditor`, `administrator`.
- `/driver` (dan `/field`, yang dialihkan ke tab instruksi `/driver`) meminta login sopir di tempat sebelum menulis apa pun. Akun sopir bersama
  (`driver`) adalah akun demo yang boleh bertindak untuk truk mana pun; akun pribadi dari
  `PYTHIA_USERS_FILE` mengikat satu sopir ke satu truk, dan API menolak (403) permintaan
  sopir itu untuk truk lain.
- Permission (`app/core/auth.py`): eksekutif (dashboard:read, reports:read, history:read);
  dispatcher (dashboard:read, operations:plan, dispatch:create, history:read);
  pengawas (dashboard:read, dispatch:create, dispatch:confirm, operations:approve, history:read,
  spj:override); sopir (dispatch:confirm); auditor (history:read, reports:read, provenance:read);
  administrator (semua permission di atas + admin:manage).

## Halaman konsol

- **Operasi**: peta armada, strip KPI (truk di rute, rit selesai, ton terkirim, antrean
  gerbang) dan "Perlu Anda" berisi hal yang butuh keputusan beserta saran Pythia.
- **Kesiapan pagi**: per truk cek pra-jalan, status dinas, konfirmasi instruksi, surat jalan
  dan kerusakan. **Gerbang TPA**: slot 15 menit dan saran tahan keberangkatan.
  **Surat jalan**: jejak audit bersegel per truk. **Besok**: prakiraan, outlook 7/14/30 hari dan
  rencana harian. **Armada & sopir**, **Laporan** (tutup hari, nilai per 1.000 rit) dan
  **Pengaturan** (bahasa WhatsApp, Data dan asal-usul data).

## Indikator ringkasan (API `/api/command-center`)

- **active_trucks**: jumlah kendaraan berstatus aktif atau deviasi.
- **trucks_with_issues**: kendaraan yang melanggar koridor ATAU dilaporkan rusak -> prioritas tindakan.
- **tpa_wait_minutes**: waktu tunggu rata-rata pada jam puncak model di TPST Bantargebang (simulasi
  antrean ber-seed, berlabel SIMULATED; bukan pengukuran saat ini).
  - < 45 mnt: hijau, normal.
  - 45-90: kuning; >= 90: merah. Keduanya: tunda keberangkatan truk non-esensial 30-45 menit dan
    jadwalkan keberangkatan bertahap (slot 15 menit).
- **pending_dispatches**: jumlah instruksi yang belum dikonfirmasi lapangan; tindak lanjuti
  untuk menutup loop.
- **predicted_spike_percent**: lonjakan tertinggi di antara prediksi; hubungkan ke kecamatan hotspot.

## Membaca Alert

- Alert berasal dari `build_alerts()` pada snapshot: status kerusakan, deviasi koridor.
- Alert kritis ditandai di panel dan ana dapat menjelaskan alasannya (jarak point-to-polyline,
  posisi, rekomendasi rute recovery).
- Urutan tindakan: konfirmasi truk -> kirim instruksi recovery -> konfirmasi sopir di `/driver` -> audit.

## Aksi yang Disarankan per Skenario

1. **Alert deviasi T-047**: redirect ke Route B - Daan Mogot Recovery (OSRM atau A* recovery);
   lihat `/api/fleet/route-decision` untuk sinyal terpadu (ETA, kerusakan, antrean, izin).
2. **Antrean TPA merah**: aktifkan staggered dispatch (interval 15 menit) dan tunda
   keberangkatan non-prioritas.
3. **Kecamatan berisiko** (`high`/`critical`, >= 10% di atas hari normal, `engine.spike_risk`):
   tambah kru/truk/bin di hotspot (`/api/predictions/kecamatan`),
   prioritaskan dispatch pertama ke zona tersebut.
4. **Truk rusak**: alokasikan kapasitas cadangan; jangan masukkan truk rusak ke plan alokasi.

## Keselamatan Sopir

- Panel keselamatan di Kesiapan pagi, Operasi dan Gerbang TPA (`/api/safety/overview`) mengurutkan truk menurut
  risiko: jam kerja sejak cek pra-jalan atau aktivasi SPJ pertama hari itu (WIB), dan lama tunggu
  di gerbang TPA sejak sopir menekan "Saya tiba di gerbang TPA" sampai struk timbang.
- Jam kerja: peringatan mulai 600 menit (10 jam); mulai 720 mnt (12 jam) SPJ baru untuk truk
  itu ditolak. Supervisor atau administrator dapat memberi override dengan alasan minimal 10
  karakter; override dan setiap SPJ yang diizinkannya tercatat di `/api/history` dengan username
  pemberinya. Gunakan override hanya bila sopir pengganti benar-benar tidak tersedia.
- Tunggu gerbang: mulai 180 menit (janji DLH: maksimal 3 jam) satu peringatan per kunjungan
  gerbang disimpan dan, bila grup WhatsApp supervisor (`PYTHIA_WA_DEFAULT_GROUP_ID`) diatur,
  dikirim sekali ke grup itu. Pemeriksaan berjalan tiap 60 detik di latar belakang, jadi tidak
  bergantung pada panel yang terbuka. Tindakan: prioritaskan bongkar atau rotasi sopir.
- Label: `OBSERVED_APP_EVENTS` berarti angka dari event aplikasi di server ini. Tanpa event hari
  itu, panel menampilkan skenario ber-seed berlabel SIMULATED: jangan dibacakan sebagai kondisi
  sopir sebenarnya; skenario ini tidak pernah memblokir SPJ atau mengirim peringatan.

## Aplikasi sopir & WhatsApp

- Aplikasi sopir (`/driver`) menampilkan surat jalan, instruksi dan pesan pribadi; konfirmasi
  mengubah status dispatch. Pesan untuk satu truk dikirim pribadi ke sopirnya; grup WhatsApp
  dipakai untuk peringatan seluruh armada. Bahasa pesan WhatsApp dipilih di Pengaturan
  (bawaan Indonesia).
- WhatsApp Gateway (Baileys, klien WhatsApp Web tidak resmi untuk prototipe; pilot memakai
  WhatsApp Business Platform): status koneksi di `/api/whatsapp/status`; gunakan hanya saat
  gateway `connected=true`; jangan pernah mengklaim terkirim jika tidak.
- Ana (asisten) membaca data lewat alat read-only dan dapat menyiapkan usulan tindakan (pesan
  ke satu sopir, eskalasi ke supervisor). Ana tidak pernah mengirim sendiri: operator yang
  menekan Kirim, Ubah atau Abaikan.

## Batas Data (Kejujuran)

- Data yang berlabel SIMULATED: fleet breadcrumbs, event attendance, pengumpul ilegal,
  seed waste. Data resmi: baseline SILIKA DLH, Open-Meteo weather, kalender libur RI,
  OSRM public routing, event resmi. Jangan memaparkan data SIMULATED sebagai data terukur.