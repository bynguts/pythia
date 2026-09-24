import React, { createContext, useContext, useState } from "react";

const translations = {
  en: {
    // Login
    login_kicker: "DLH Command Access",
    login_title: "JWIS Control Center",
    login_copy: "Secure operator entry for fleet monitoring, predictive waste planning, and dispatch supervision.",
    login_username: "Username",
    login_password: "Password",
    login_password_placeholder: "Enter password",
    login_show_password: "Show password",
    login_hide_password: "Hide password",
    login_submit: "Sign in",
    login_error: "Invalid username or password.",
    login_username_placeholder: "e.g. dispatcher",
    login_submitting: "Checking…",
    login_help: "Access issues? Contact the JWIS administrator.",
    login_card_title: "Sign in to command center",
    login_card_sub: "Use your registered agency account.",
    login_eyebrow: "Operator access",
    login_story_kicker: "Operations command center",
    login_story_headline_1: "One decision.",
    login_story_headline_2: "The entire operation moves.",
    login_story_copy: "Forecast service load, compose the fleet, and act on field disruptions in one auditable workflow.",
    login_proof1_title: "Live operations", login_proof1_sub: "Fleet, drivers, and TPA queues",
    login_proof2_title: "Measured forecasts", login_proof2_sub: "Data evidence accompanies every recommendation",
    login_proof3_title: "Protected access", login_proof3_sub: "Action rights follow the user role",
    login_story_footer: "Jakarta Environmental Agency (DLH)",
    // Navigation
    nav_fleet: "Fleet Operations",
    nav_forecast: "Waste Forecast",
    nav_planning: "Integrated Planning",
    nav_surveillance: "Gate Surveillance",
    nav_drivers: "Driver Analytics",
    nav_weighbridge: "Weighbridge Logs",
    nav_wa: "WhatsApp Gateway",
    nav_iot: "IoT Bin Sensors",
    nav_audit: "Data & ML Audit",
    nav_armada: "Fleet",
    nav_prediksi: "Forecast",
    nav_rencana: "Planning",
    nav_sopir: "Drivers",

    // Action card
    ac_no_alerts: "No active alerts",
    ac_send_route: "Send route to driver",
    ac_handle_alert: "Handle alert",
    ac_wa_offline: "WhatsApp gateway not connected — instruction is still recorded, message not sent",
    ac_sent_waiting: "Sent to {driver} ({truck}). Waiting for driver confirmation.",
    ac_confirmed: "Confirmed",
    ac_send_failed: "Failed to send instruction. Try again.",
    ac_instruction_route: "Use route",
    ac_instruction_confirm: "Confirm when accepted.",
    ac_instruction_handle: "Handle alert",
    ac_minutes: "min",
    ac_unknown_driver: "Unknown driver",
    ac_all_alerts: "All alerts ({n})",
    sv_open_map: "Open map",
    nav_pengawas: "Supervisor",
    sv_loading: "Loading operational data...",

    // Sections
    sec_operations: "Operations",
    sec_logistics: "Field Logistics",
    sec_admin: "Command Systems",

    // Topbar
    top_search_placeholder: "Search operations, fleet...",
    top_ai_assistant: "AI Assistant",
    top_connected: "Connected",
    top_offline: "Offline demo",
    top_logout: "Logout",
    top_status: "System status",
    top_operator_role: "DLH Operator",

    // Waste Forecast workspace (#68)
    fc_kicker: "Demand intelligence",
    fc_horizon_label: "Analysis range",
    fc_priority_kicker: "Regional priority",
    fc_priority_title: "Service demand map",
    fc_priority_sub: "Rank districts by predicted load and resource readiness.",
    fc_context_label: "Forecast drivers",
    fc_context_kicker: "Decision context",
    fc_context_title: "Trigger factors",
    fc_evidence_kicker: "Model evidence",
    fc_evidence_title: "Forecast detail",
    fc_evidence_sub: "Use this detail to validate districts before composing the plan.",
    fc_days: "days",
    // App shell (#15)
    shell_sidebar_label: "JWIS main navigation",
    shell_brand_sub: "DLH command center",
    shell_workspaces: "Workspaces",
    shell_connected_title: "System connected",
    shell_connected_sub: "Data refreshes automatically",
    shell_offline_title: "Limited mode",
    shell_offline_sub: "Using backup data",
    shell_logout: "Log out",
    shell_context_eyebrow: "Jakarta operations",
    shell_lang_label: "Select language",
    shell_assistant: "Operations assistant",
    shell_assistant_label: "Operations assistant",
    shell_close_assistant: "Close assistant",
    shell_profile_label: "Operator profile",
    shell_profile_name: "JWIS Team",
    shell_profile_role: "DLH Operator",
    shell_mobile_nav_label: "Mobile workspace navigation",
    desc_fleet: "Monitor and act on today's operations",
    desc_forecast: "Anticipate the next service load",
    desc_planning: "Compose and approve operations plans",
    desc_drivers: "Manage driver compliance and performance",
    desc_audit: "Audit data and model quality",

    // Common Buttons
    btn_approve_dispatch: "Approve & Dispatch",
    btn_wa_alert: "WA Alert",
    btn_mark_resolved: "Mark Resolved",
    btn_resolve_placeholder: "Add resolution note (e.g. T-012 handled)...",
    btn_export_pdf: "Export Executive Summary PDF",
    btn_rerun_optimizer: "Re-run Optimizer",
    btn_run_scenario: "Run Scenario Simulator",
    btn_generate_plan: "Generate Constraint Dispatch Plan (CP-SAT)",
    btn_dispatch_patrol: "Dispatch Patrol",
    btn_patrol_sent: "Patrol Sent",
    btn_simulate_jam: "Simulate Corridor Jam",
    btn_restore_flow: "Restore Normal Flow",
    btn_trip_history: "History",

    // Stages
    stage_1_title: "1. Scenario inputs",
    stage_2_title: "2. Recommended plan",
    stage_3_title: "3. Evidence and approval",
    stage_ready_approval: "Ready for approval",

    // Tabs
    tab_fleet: "Fleet State",
    tab_unlicensed: "Unlicensed Collectors",
    tab_history: "Trip History",
    tab_queue: "TPA Queue & Optimization",
    tab_evidence: "Route Evidence",
    tab_impact: "Carbon Footprint",
    tab_spj: "Dispatch orders",
    tab_damage: "Damage reports",
    // Fleet KPIs
    kpi_active_trucks: "Active Trucks",
    kpi_active_trucks_sub: "live fleet in operation",
    kpi_operational_issues: "Operational Issues",
    kpi_operational_issues_sub: "deviation or damage",
    kpi_landfill_queue: "Landfill Queue",
    kpi_landfill_queue_sub: "trucks waiting",
    kpi_waste_spike: "Largest Waste Spike",
    kpi_waste_spike_sub: "next 7 days",

    // Action Queue & Rerouting
    aq_title: "Action Queue",
    aq_subtitle: "Alerts linked to route recommendations and field instructions.",
    aq_awaiting_rec: "Awaiting route recommendation",
    aq_awaiting_sub: "Dispatch can proceed after operator review.",
    astar_title: "A* Dynamic Rerouting",
    astar_subtitle: "Real-time A* route recovery when logistics corridors experience heavy congestion.",
    astar_status_jam: "Jam Active",
    astar_status_clear: "Corridor Clear",
    astar_dist: "Distance",
    astar_eta: "Estimated Time",
    astar_status: "Route Status",
    astar_compliant: "Compliant",
    astar_diverted: "Diverted (A*)",
    astar_unchanged: "Unchanged",

    // Unlicensed Panel
    unlicensed_title: "Unlicensed Waste Collector Detection & Enforcement",
    unlicensed_subtitle: "Commercial vehicles operating without registered DLH permits inside Jakarta jurisdiction.",
    unlicensed_th_plate: "Vehicle Plate",
    unlicensed_th_loc: "Detected Location",
    unlicensed_th_coords: "GPS Coordinates",
    unlicensed_th_status: "Registry Status",
    unlicensed_th_action: "Enforcement Action",
    unlicensed_unauth: "Unauthorized",
    unlicensed_dispatched: "Patrol Dispatched",

    // Fleet Table
    ft_title: "Fleet Operational State",
    ft_search: "Search truck, driver...",
    ft_th_truck: "Truck & Plate",
    ft_th_driver: "Driver",
    ft_th_zone: "Assigned Zone",
    ft_th_comp: "Compliance",
    ft_th_activity: "Activity State",
    ft_th_speed: "Speed",
    ft_th_action: "Action",

    // TPA Queue & Stagger
    tpa_title: "Bantargebang Landfill Queue Status",
    tpa_subtitle: "Real-time visualization of weighbridge throughput and final-disposal truck queues.",
    stagger_title: "Bantargebang Queue Optimization (Staggered Dispatch)",
    stagger_subtitle: "Simulation model reducing landfill peak bottlenecks by spacing departures at 15-minute intervals.",
    stagger_uncoord: "Uncoordinated Dispatch",
    stagger_jwis: "JWIS Staggered Dispatch",
    stagger_delay_badge: "Queue Delay",

    // Forecast
    fc_title: "Waste Forecast",
    fc_subtitle: "Multi-district demand forecasting with spatial risk analytics and explainable drivers.",
    fc_pred_title: "Predictive Waste Demand & Resource Allocation",
    fc_pred_sub: "Multi-district 7-day spatial demand forecast driven by meteorological and population event models.",
    fc_hr_districts: "High-Risk Districts",
    fc_peak_spike: "Peak Volume Spike",
    fc_extra_cap: "Extra Required Capacity",
    fc_th_district: "District / Kecamatan",
    fc_th_date: "Target Date",
    fc_th_volume: "Predicted Volume",
    fc_th_spike: "Volume Spike (%)",
    fc_th_backup: "Recommended Backup",

    // Planning
    plan_sim_title: "Event Scenario Simulator",
    plan_sim_sub: "Weather and crowd scenarios run through the live 42-district hybrid model with instant resource forecasting.",
    plan_att: "Event Attendance",
    plan_rain: "Rainfall Intensity",
    plan_opt_title: "Operations Optimizer (Constraint Satisfaction Problem — CP-SAT)",
    plan_demand: "Forecast demand",
    plan_fleet_need: "Fleet need",
    plan_tpa_queue: "TPA queue",
    plan_awaiting_title: "Awaiting Optimizer Generation",
    plan_awaiting_desc: "Click above to solve optimal vehicle allocations across all 42 districts using Google OR-Tools CP-SAT.",
  },
  id: {
    // Login
    login_kicker: "Akses Masuk Komando DLH",
    login_title: "Pusat Kendali JWIS",
    login_copy: "Akses resmi operator untuk pemantauan armada, prediksi timbulan sampah, dan pengawasan logistik.",
    login_username: "Nama pengguna",
    login_password: "Kata sandi",
    login_password_placeholder: "Masukkan kata sandi",
    login_show_password: "Tampilkan kata sandi",
    login_hide_password: "Sembunyikan kata sandi",
    login_submit: "Masuk",
    login_error: "Nama pengguna atau kata sandi tidak valid.",
    login_username_placeholder: "contoh: dispatcher",
    login_submitting: "Memeriksa…",
    login_help: "Masalah akses? Hubungi administrator JWIS.",
    login_card_title: "Masuk ke pusat kendali",
    login_card_sub: "Gunakan akun dinas yang telah terdaftar.",
    login_eyebrow: "Akses operator",
    login_story_kicker: "Pusat kendali operasional",
    login_story_headline_1: "Satu keputusan.",
    login_story_headline_2: "Seluruh operasi bergerak.",
    login_story_copy: "Prediksi beban, susun armada, dan tindak gangguan lapangan dalam satu alur kerja yang dapat diaudit.",
    login_proof1_title: "Operasi langsung", login_proof1_sub: "Armada, pengemudi, dan antrean TPA",
    login_proof2_title: "Prediksi terukur", login_proof2_sub: "Bukti data selalu menyertai rekomendasi",
    login_proof3_title: "Akses terlindungi", login_proof3_sub: "Hak tindakan mengikuti peran pengguna",
    login_story_footer: "Dinas Lingkungan Hidup Provinsi DKI Jakarta",
    // Waste Forecast workspace (#68)
    fc_kicker: "Intelijen permintaan",
    fc_horizon_label: "Rentang analisis",
    fc_priority_kicker: "Prioritas wilayah",
    fc_priority_title: "Peta kebutuhan layanan",
    fc_priority_sub: "Urutkan wilayah berdasarkan beban prediksi dan kesiapan sumber daya.",
    fc_context_label: "Faktor pemicu prediksi",
    fc_context_kicker: "Konteks keputusan",
    fc_context_title: "Faktor pemicu",
    fc_evidence_kicker: "Bukti model",
    fc_evidence_title: "Rincian prediksi",
    fc_evidence_sub: "Gunakan rincian ini untuk memvalidasi wilayah sebelum masuk ke penyusunan rencana.",
    fc_days: "hari",
    // Navigation
    nav_fleet: "Operasional Armada",
    nav_forecast: "Prediksi Timbulan Sampah",
    nav_planning: "Perencanaan Terpadu",
    nav_surveillance: "Pengawasan Gerbang ANPR",
    nav_drivers: "Analisis Kinerja Driver",
    nav_weighbridge: "Log Jembatan Timbang",
    nav_wa: "Gateway WhatsApp",
    nav_iot: "Sensor TPS IoT",
    nav_audit: "Audit Data & Model ML",
    nav_armada: "Armada",
    nav_prediksi: "Prediksi",
    nav_rencana: "Rencana",
    nav_sopir: "Sopir",

    // Kartu aksi
    ac_no_alerts: "Tidak ada peringatan aktif",
    ac_send_route: "Kirim rute ke sopir",
    ac_handle_alert: "Tangani peringatan",
    ac_wa_offline: "Gateway WhatsApp belum tersambung — instruksi tetap dicatat, pesan tidak terkirim",
    ac_sent_waiting: "Dikirim ke {driver} ({truck}). Menunggu konfirmasi sopir.",
    ac_confirmed: "Dikonfirmasi",
    ac_send_failed: "Gagal mengirim instruksi. Coba lagi.",
    ac_instruction_route: "Gunakan rute",
    ac_instruction_confirm: "Konfirmasi setelah diterima.",
    ac_instruction_handle: "Tangani peringatan",
    ac_minutes: "menit",
    ac_unknown_driver: "Sopir tidak dikenal",
    ac_all_alerts: "Semua peringatan ({n})",
    sv_open_map: "Buka peta",
    nav_pengawas: "Pengawas",
    sv_loading: "Memuat data operasional...",

    // Sections
    sec_operations: "Operasional",
    sec_logistics: "Logistik Lapangan",
    sec_admin: "Sistem Komando",

    // Topbar
    top_search_placeholder: "Cari operasional, armada...",
    top_ai_assistant: "Asisten AI",
    top_connected: "Terhubung",
    top_offline: "Demo Offline",
    top_logout: "Keluar",
    top_status: "Status Sistem",
    top_operator_role: "Operator DLH",

    // App shell (#15)
    shell_sidebar_label: "Navigasi utama JWIS",
    shell_brand_sub: "Pusat kendali DLH",
    shell_workspaces: "Ruang kerja",
    shell_connected_title: "Sistem terhubung",
    shell_connected_sub: "Data diperbarui otomatis",
    shell_offline_title: "Mode terbatas",
    shell_offline_sub: "Menggunakan data cadangan",
    shell_logout: "Keluar",
    shell_context_eyebrow: "Operasi DKI Jakarta",
    shell_lang_label: "Pilih bahasa",
    shell_assistant: "Asisten operasi",
    shell_assistant_label: "Asisten operasi",
    shell_close_assistant: "Tutup asisten",
    shell_profile_label: "Profil operator",
    shell_profile_name: "Tim JWIS",
    shell_profile_role: "Operator DLH",
    shell_mobile_nav_label: "Navigasi ruang kerja seluler",
    desc_fleet: "Pantau dan tangani operasi hari ini",
    desc_forecast: "Antisipasi beban layanan berikutnya",
    desc_planning: "Susun dan setujui rencana operasi",
    desc_drivers: "Kelola kepatuhan dan kinerja pengemudi",
    desc_audit: "Periksa mutu data dan model",

    // Common Buttons
    btn_approve_dispatch: "Setujui & Kirim",
    btn_wa_alert: "Peringatan WA",
    btn_mark_resolved: "Tandai Selesai",
    btn_resolve_placeholder: "Tambah catatan (misal T-012 ditangani)...",
    btn_export_pdf: "Unduh Ringkasan Eksekutif PDF",
    btn_rerun_optimizer: "Hitung Ulang Optimasi",
    btn_run_scenario: "Jalankan Simulasi Skenario",
    btn_generate_plan: "Susun Alokasi Armada",
    btn_dispatch_patrol: "Kirim Patroli",
    btn_patrol_sent: "Patroli Terkirim",
    btn_simulate_jam: "Simulasikan Macet Koridor",
    btn_restore_flow: "Pulihkan Arus Normal",
    btn_trip_history: "Riwayat",

    // Stages
    stage_1_title: "1. Input Skenario Simulasi",
    stage_2_title: "2. Rekomendasi Rencana Optimasi",
    stage_3_title: "3. Bukti & Persetujuan Supervisor",
    stage_ready_approval: "Siap Disetujui",

    // Tabs
    tab_fleet: "Status Armada",
    tab_unlicensed: "Kolektor Liar",
    tab_history: "Riwayat Perjalanan",
    tab_queue: "Antrean TPA & Optimasi",
    tab_evidence: "Bukti Rute OSRM",
    tab_impact: "Jejak Karbon",
    tab_spj: "Surat Perintah Jalan",
    tab_damage: "Laporan Kerusakan",
    // Fleet KPIs
    kpi_active_trucks: "Armada Aktif",
    kpi_active_trucks_sub: "truk beroperasi di lapangan",
    kpi_operational_issues: "Masalah Operasional",
    kpi_operational_issues_sub: "deviasi rute atau kerusakan",
    kpi_landfill_queue: "Antrean TPA",
    kpi_landfill_queue_sub: "truk sedang mengantre",
    kpi_waste_spike: "Lonjakan Sampah Tertinggi",
    kpi_waste_spike_sub: "proyeksi 7 hari ke depan",

    // Action Queue & Rerouting
    aq_title: "Antrean Tindakan",
    aq_subtitle: "Peringatan terhubung ke rekomendasi rute dan instruksi lapangan.",
    aq_awaiting_rec: "Menunggu rekomendasi rute",
    aq_awaiting_sub: "Penugasan dapat dilanjutkan setelah tinjauan operator.",
    astar_title: "Rerouting Dinamis A*",
    astar_subtitle: "Pemulihan rute real-time A* saat koridor logistik mengalami kemacetan parah.",
    astar_status_jam: "Macet Aktif",
    astar_status_clear: "Koridor Lancar",
    astar_dist: "Jarak Tempuh",
    astar_eta: "Estimasi Waktu",
    astar_status: "Status Rute",
    astar_compliant: "Sesuai Koridor",
    astar_diverted: "Dialihkan (A*)",
    astar_unchanged: "Tetap",

    // Unlicensed Panel
    unlicensed_title: "Deteksi & Penindakan Kolektor Sampah Liar",
    unlicensed_subtitle: "Kendaraan komersial yang beroperasi tanpa izin resmi DLH di wilayah DKI Jakarta.",
    unlicensed_th_plate: "Plat Kendaraan",
    unlicensed_th_loc: "Lokasi Terdeteksi",
    unlicensed_th_coords: "Koordinat GPS",
    unlicensed_th_status: "Status Registrasi",
    unlicensed_th_action: "Aksi Penindakan",
    unlicensed_unauth: "Tanpa Izin",
    unlicensed_dispatched: "Patroli Dikirim",

    // Fleet Table
    ft_title: "Status Operasional Armada",
    ft_search: "Cari nomor truk, pengemudi...",
    ft_th_truck: "Truk & Plat",
    ft_th_driver: "Pengemudi",
    ft_th_zone: "Zona Wilayah",
    ft_th_comp: "Kepatuhan",
    ft_th_activity: "Aktivitas",
    ft_th_speed: "Kecepatan",
    ft_th_action: "Aksi",

    // TPA Queue & Stagger
    tpa_title: "Status Antrean TPA Bantargebang",
    tpa_subtitle: "Visualisasi real-time penimbangan dan antrean truk di TPA Bantargebang.",
    stagger_title: "Optimasi Antrean TPA Bantargebang (Keberangkatan Bertahap)",
    stagger_subtitle: "Model simulasi pengurangan antrean puncak dengan penjadwalan interval 15 menit.",
    stagger_uncoord: "Keberangkatan Tak Terkoordinasi",
    stagger_jwis: "Keberangkatan Bertahap JWIS",
    stagger_delay_badge: "Pengurangan Waktu Antre",

    // Forecast
    fc_title: "Prediksi Timbulan Sampah",
    fc_subtitle: "Prediksi timbulan multi-distrik dengan analitik risiko spasial dan faktor pemicu.",
    fc_pred_title: "Prediksi Timbulan Sampah & Alokasi Sumber Daya",
    fc_pred_sub: "Prakiraan kebutuhan 7 hari multi-distrik berdasarkan model meteorologi dan kalender keramaian.",
    fc_hr_districts: "Distrik Risiko Tinggi",
    fc_peak_spike: "Lonjakan Volume Puncak",
    fc_extra_cap: "Tambahan Kapasitas Dibutuhkan",
    fc_th_district: "Kecamatan / Distrik",
    fc_th_date: "Tanggal Target",
    fc_th_volume: "Prediksi Timbulan",
    fc_th_spike: "Lonjakan Volume (%)",
    fc_th_backup: "Rekomendasi Tambahan",

    // Planning
    plan_sim_title: "Skenario permintaan & cuaca",
    plan_sim_sub: "Sesuaikan perkiraan keramaian dan cuaca untuk melihat dampaknya pada 42 kecamatan.",
    plan_att: "Perkiraan pengunjung acara",
    plan_rain: "Intensitas curah hujan",
    plan_opt_title: "Rekomendasi alokasi armada",
    plan_demand: "Kebutuhan timbulan",
    plan_fleet_need: "Kebutuhan armada",
    plan_tpa_queue: "Antrean TPA",
    plan_awaiting_title: "Rencana belum disusun",
    plan_awaiting_desc: "Susun alokasi untuk membagi armada dan kru ke 42 kecamatan berdasarkan kebutuhan skenario.",
  },
};

const LanguageContext = createContext({
  lang: "id",
  setLang: () => {},
  t: (key) => key,
});

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => document.documentElement.lang === "en" ? "en" : "id");

  function setLang(newLang) {
    if (newLang !== "id" && newLang !== "en") return;
    document.documentElement.lang = newLang;
    setLangState(newLang);
    try {
      localStorage.setItem("jwis_lang", newLang);
    } catch {
      // The selected language still applies when browser storage is unavailable.
    }
  }

  function t(key) {
    return translations[lang]?.[key] || translations.en?.[key] || key;
  }

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
