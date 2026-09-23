import React from "react";
import { ArrowDown, ArrowUpRight, Check, CircleAlert, FlaskConical, Radio, ScanSearch } from "lucide-react";
import { useLanguage } from "../i18n.jsx";

const copy = {
  id: {
    title: "Scentinel: dari muatan truk ke keputusan yang dapat diuji",
    intro: "DLH perlu mengenali muatan saat truk masuk, lalu memutuskan apakah material perlu diperiksa lagi, dipilah, atau berpotensi menjadi bahan RDF. Scentinel membantu merancang di mana sensor gas ditempatkan dan menilai skenario sampah—bukan mesin yang sudah membaca semua truk secara langsung.",
    scope: "Ruang penjelasan · bukan telemetri langsung",
    jump: ["Alur pemeriksaan", "Kemampuan", "Keputusan RDF", "Batas validasi", "Integrasi"],
    diagramTitle: "Satu bak, beberapa titik pengamatan",
    diagramCaption: "Skema penampang 2D dan titik kandidat S1–S3. Bukan peta konsentrasi dari run atau bukti posisi terbaik.",
    diagramWind: "arah angin",
    diagramWaste: "tumpukan sampah",
    journeyTitle: "Apa yang terjadi saat truk masuk?",
    journeyIntro: "Identitas kendaraan mengikat dua jalur bukti yang berbeda: perkiraan gas dari simulasi dan karakterisasi material dari sampel. Keduanya baru berguna untuk operasi bila asal dan keterbatasannya jelas.",
    journey: [
      { label: "Di gerbang", title: "Ikat truk ke satu muatan", body: "Catat ID truk, asal, waktu masuk, massa, umur muatan, dan identitas sampel. Scentinel tidak menyediakan deteksi identitas truk otomatis; tahap ini harus datang dari alur gerbang JWIS atau petugas." },
      { label: "Di sandbox", title: "Uji kondisi dan calon sensor", body: "Deskripsikan komposisi, kadar air, bentuk bak/tumpukan, angin, sumber gas, serta titik sensor. Simulasi CFD 2D menghitung estimasi konsentrasi per titik; Sensor Lab kemudian memodelkan respons perangkat virtual." },
      { label: "Sebelum pengolahan", title: "Bandingkan bukti material", body: "Scentinel menghitung skor rute dan proyeksi hasil dari komposisi serta kadar air, tanpa menunggu solver gas. Uji lab bahan bakar diperlukan sebelum menyatakan mutu RDF; petugas tetap memutuskan penanganannya." },
    ],
    capabilityTitle: "Yang sudah ada di aplikasi lokal",
    capabilityIntro: "Bukan satu tombol ‘deteksi RDF’. Ada dua mesin hitung yang saling melengkapi, dengan tingkat bukti berbeda.",
    capabilities: [
      { status: "Berjalan", title: "Simulasi gas", body: "PySide6 → gmsh → OpenFOAM dalam Podman → sampel sensor (ppmv) dan ekspor CSV. Geometri bak adalah penampang 2D; gas sampah segar dibatasi menurut fase." },
      { status: "Berjalan", title: "Sensor virtual", body: "Replay hasil CFD melalui model PID, MOX, elektrokimia, NDIR, atau pellistor. Respons, batas deteksi, noise, drift, dan sensitivitas silang disimulasikan—bukan dibaca dari perangkat nyata." },
      { status: "Heuristik", title: "Penilaian rute material", body: "Batch Panel menghitung pembagian material, hasil per jalur, skor RDF/daur ulang/kompos/digesti/landfill, dan rekomendasi beralasan dari input komposisi, tonase, umur, serta kadar air." },
      { status: "Belum terhubung", title: "Sensor fisik & JWIS", body: "Belum ada koneksi perangkat fisik atau feed sensor langsung ke JWIS. Kandidat lokasi hasil simulasi perlu lolos validasi numerik, lalu diuji pada truk nyata dengan kalibrasi dan pembanding lapangan." },
    ],
    rdfTitle: "RDF tidak diputuskan oleh gas saja",
    rdfIntro: "‘RDF suitability’ adalah skrining jalur pengolahan, bukan sertifikat bahwa muatan boleh langsung diolah sebagai bahan bakar.",
    rdfColumns: ["Bukti", "Yang bisa dikatakan", "Yang belum bisa diklaim"],
    rdfRows: [
      { name: "Komposisi + kadar air", supported: "Skor heuristik RDF dan perkiraan fraksi material untuk diproses; bahan kering seperti kertas, tekstil, dan kayu menaikkan skor.", blocked: "Bukan mutu bahan bakar, standar penerimaan pabrik, atau keputusan akhir tanpa pemeriksaan muatan." },
      { name: "Gas hasil simulasi", supported: "Perkiraan paparan di titik sensor dan indikasi klorin/sulfur fase gas dari rujukan AP-42.", blocked: "Bukan kadar klorin bahan RDF, nilai kalor, atau pembacaan gas dari truk nyata." },
      { name: "Sampel laboratorium", supported: "NCV, abu, dan klorin berbasis bahan yang terlacak dapat dipakai untuk meninjau kelayakan bahan bakar.", blocked: "Scentinel belum menetapkan kelas EN 15359 / ISO 21640; ambang kelas belum diacu dalam aplikasinya." },
    ],
    qualityTitle: "Selesaikan gerbang mutu sebelum keputusan perangkat",
    qualityIntro: "Run berhasil berarti pipeline selesai dan titik tersampel. Itu bukan sinonim konvergen, independen terhadap mesh, neraca massa lulus, atau tervalidasi eksperimen.",
    qualityMeasure: "266,29%",
    qualityMeasureLabel: "deviasi terburuk titik S3 saat mesh 0,50 → 0,25 m",
    qualityTarget: "Target independensi mesh: <10%",
    qualityRows: [
      { title: "Konsentrasi absolut", text: "Belum mesh-converged; gunakan sebagai perkiraan skrining, bukan angka pengukuran lapangan." },
      { title: "Peringkat lokasi sensor", text: "Belum terbukti stabil. Jangan langsung memilih lokasi pemasangan fisik dari urutan titik S1–S3." },
      { title: "Sampah segar", text: "Fase awal aerobik berbeda dari landfill matang. Sebagian kekuatan gas referensi AP-42 masih ekstrapolasi; asal dan ketidakpastiannya harus dibawa bersama hasil." },
    ],
    integrationTitle: "Kalau dihubungkan ke JWIS, apa yang harus ikut?",
    integrationIntro: "Scentinel menyimpan setiap percobaan sebagai manifest run.json yang dapat diaudit. Integrasi bukti bukan menyalin solver ke backend JWIS.",
    integrationFields: [
      { key: "Identitas", value: "ID truk, muatan, sampel, run ID, versi aplikasi, waktu, dan skenario yang sama." },
      { key: "Asal perhitungan", value: "Manifest format 10, sumber tiap gas, parameter yang diterapkan, serta SHA-256 dari input kasus." },
      { key: "Mutu hasil", value: "Status eksekusi dan gerbang konvergensi, mesh, neraca massa, validasi eksperimen ditampilkan terpisah." },
      { key: "Jenis bukti", value: "Label external_simulation untuk CFD; hasil lab dan sensor fisik memakai rekam sumber terpisah. Manifest lama tidak boleh diam-diam diterima." },
    ],
    integrationNote: "Saat ini halaman ini hanya menjelaskan batas integrasi. Belum ada impor manifest, feed perangkat, atau keputusan otomatis di JWIS.",
    source: "Buka kode Scentinel",
    issue: "Lihat rencana integrasi #23",
  },
  en: {
    title: "Scentinel: from truck load to testable decision",
    intro: "DLH needs to identify a load as a truck enters, then decide whether material needs further inspection, sorting, or could become RDF feedstock. Scentinel helps design gas-sensor positions and assess waste scenarios—not a system already reading every truck live.",
    scope: "Explanation workspace · not live telemetry",
    jump: ["Inspection flow", "Capabilities", "RDF decision", "Validation limits", "Integration"],
    diagramTitle: "One bin, several observation points",
    diagramCaption: "Schematic 2D section and candidate points S1–S3. Not a run's concentration field or proof of the best position.",
    diagramWind: "wind direction",
    diagramWaste: "waste mound",
    journeyTitle: "What happens when a truck enters?",
    journeyIntro: "The vehicle identity links two distinct evidence paths: simulated gas estimates and material characterization from a sample. Neither supports operations without provenance and limits.",
    journey: [
      { label: "At the gate", title: "Bind truck to one load", body: "Record truck ID, origin, arrival time, mass, load age, and sample ID. Scentinel does not automatically identify trucks; this stage must come from the JWIS gate workflow or an operator." },
      { label: "In the sandbox", title: "Test conditions and candidate sensors", body: "Describe composition, moisture, bin/mound shape, wind, gas sources, and sensor points. 2D CFD estimates concentration at each point; Sensor Lab then models virtual device response." },
      { label: "Before treatment", title: "Compare material evidence", body: "Scentinel computes route scores and projected yields from composition and moisture without waiting for the gas solver. Fuel-grade lab tests are required before claiming RDF quality; an operator still decides treatment." },
    ],
    capabilityTitle: "What the local app actually does",
    capabilityIntro: "There is no single ‘detect RDF’ button. Two complementary computation paths carry different levels of evidence.",
    capabilities: [
      { status: "Working", title: "Gas simulation", body: "PySide6 → gmsh → OpenFOAM in Podman → sampled sensors (ppmv) and CSV export. The bin is a 2D section; fresh-waste gas options are phase-limited." },
      { status: "Working", title: "Virtual sensors", body: "Replay CFD output through PID, MOX, electrochemical, NDIR, or pellistor models. Response, detection limit, noise, drift, and cross-sensitivity are simulated—not read from physical hardware." },
      { status: "Heuristic", title: "Material route assessment", body: "Batch Panel computes material splits, per-route yields, RDF/recycling/compost/digestion/landfill scores, and reasoned recommendations from composition, tonnage, age, and moisture." },
      { status: "Not connected", title: "Physical sensors & JWIS", body: "There is no physical device connection or live sensor feed to JWIS. Simulated candidate sites need numerical validation, then truck-mounted trials with calibration and field comparison." },
    ],
    rdfTitle: "Gas alone cannot decide RDF",
    rdfIntro: "‘RDF suitability’ screens a treatment route; it does not certify that a load can immediately be processed as fuel.",
    rdfColumns: ["Evidence", "What it supports", "What it does not establish"],
    rdfRows: [
      { name: "Composition + moisture", supported: "A heuristic RDF score and estimated material fraction for processing; dry paper, textiles, and wood raise the score.", blocked: "Not fuel grade, plant acceptance, or a final decision without inspecting the load." },
      { name: "Simulated gas", supported: "Estimated exposure at sensor points and gas-phase chlorine/sulfur indications from AP-42 references.", blocked: "Not chlorine content in RDF feedstock, calorific value, or a reading from a real truck." },
      { name: "Laboratory sample", supported: "Traceable material-basis NCV, ash, and chlorine can inform fuel-quality review.", blocked: "Scentinel does not assign an EN 15359 / ISO 21640 class; class boundaries are not yet cited in the app." },
    ],
    qualityTitle: "Pass quality gates before a hardware decision",
    qualityIntro: "A successful run means the pipeline finished and sampled its points. It does not imply convergence, mesh independence, mass-balance pass, or experimental validation.",
    qualityMeasure: "266.29%",
    qualityMeasureLabel: "worst S3 deviation when refining mesh 0.50 → 0.25 m",
    qualityTarget: "Mesh-independence target: <10%",
    qualityRows: [
      { title: "Absolute concentration", text: "Not mesh-converged; use as a screening estimate, not a field measurement." },
      { title: "Sensor-site ranking", text: "Not shown stable. Do not select physical installation sites from an S1–S3 ranking yet." },
      { title: "Fresh waste", text: "Early aerobic waste differs from a mature landfill. Some AP-42 source strengths remain extrapolations; their provenance and uncertainty must travel with the result." },
    ],
    integrationTitle: "What must travel into JWIS?",
    integrationIntro: "Scentinel stores every attempt in an auditable run.json manifest. Evidence integration does not copy the solver into the JWIS backend.",
    integrationFields: [
      { key: "Identity", value: "Linked truck, load, sample, run ID, app version, timestamp, and scenario." },
      { key: "Computation provenance", value: "Format-10 manifest, each gas source, applied parameters, and SHA-256 case-input digest." },
      { key: "Result quality", value: "Execution outcome shown separately from convergence, mesh, mass balance, and experimental validation gates." },
      { key: "Evidence type", value: "external_simulation label for CFD; lab and physical sensor readings retain separate source records. Older manifests must not be silently accepted." },
    ],
    integrationNote: "This workspace currently explains the integration boundary only. JWIS does not yet import manifests, ingest devices, or make automatic RDF decisions.",
    source: "Explore Scentinel source",
    issue: "See integration plan #23",
  },
};

function BinSection({ text }) {
  return (
    <figure className="scentinel-bin">
      <div className="scentinel-bin-heading"><strong>{text.diagramTitle}</strong><span>2D / CFD</span></div>
      <svg viewBox="0 0 600 330" role="img" aria-label={text.diagramTitle} preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="scentinel-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="none" stroke="#a9c7b8" strokeWidth="1.5" /></marker>
        </defs>
        <g className="scentinel-wind">
          <path d="M40 60 H260" markerEnd="url(#scentinel-arrow)" />
          <path d="M40 92 H195" markerEnd="url(#scentinel-arrow)" />
          <text x="42" y="44">{text.diagramWind}</text>
        </g>
        <path className="scentinel-bin-outline" d="M52 112 V279 H548 V112" />
        <path className="scentinel-mound" d="M53 276 C105 261 134 219 195 227 C255 233 281 178 342 193 C401 206 453 247 547 274" />
        <path className="scentinel-bin-base" d="M52 278 H548" />
        <g className="scentinel-plume" fill="none">
          <path d="M210 219 C185 187 208 159 250 140 S337 119 390 96" />
          <path d="M323 191 C313 166 334 153 375 138 S450 129 491 102" />
          <path d="M136 247 C125 211 145 177 188 156" />
        </g>
        <g className="scentinel-point"><circle cx="104" cy="164" r="8" /><text x="88" y="148">S1</text></g>
        <g className="scentinel-point"><circle cx="305" cy="133" r="8" /><text x="289" y="117">S2</text></g>
        <g className="scentinel-point"><circle cx="501" cy="168" r="8" /><text x="486" y="152">S3</text></g>
        <text className="scentinel-mound-label" x="300" y="254" textAnchor="middle">{text.diagramWaste}</text>
      </svg>
      <figcaption>{text.diagramCaption}</figcaption>
    </figure>
  );
}

export function ScentinelWorkspace() {
  const { lang } = useLanguage();
  const text = copy[lang] || copy.id;
  const sections = ["flow", "capabilities", "rdf", "quality", "integration"];

  return (
    <article className="scentinel-workspace workspace-page">
      <header className="scentinel-lead">
        <div className="scentinel-lead-copy">
          <h1>{text.title}</h1>
          <p>{text.intro}</p>
          <span className="scentinel-scope"><CircleAlert size={16} aria-hidden="true" />{text.scope}</span>
        </div>
        <BinSection text={text} />
      </header>

      <nav className="scentinel-local-nav" aria-label={lang === "id" ? "Bagian Scentinel" : "Scentinel sections"}>
        {sections.map((section, index) => <a key={section} href={`#scentinel-${section}`}>{text.jump[index]}<ArrowDown size={14} aria-hidden="true" /></a>)}
      </nav>

      <section className="scentinel-journey" id="scentinel-flow" aria-labelledby="scentinel-flow-title">
        <div className="scentinel-section-head"><h2 id="scentinel-flow-title">{text.journeyTitle}</h2><p>{text.journeyIntro}</p></div>
        <ol className="scentinel-journey-list">
          {text.journey.map((step) => <li key={step.label}><span className="scentinel-step-label">{step.label}</span><div><h3>{step.title}</h3><p>{step.body}</p></div></li>)}
        </ol>
      </section>

      <section className="scentinel-capabilities" id="scentinel-capabilities" aria-labelledby="scentinel-capabilities-title">
        <div className="scentinel-section-head"><h2 id="scentinel-capabilities-title">{text.capabilityTitle}</h2><p>{text.capabilityIntro}</p></div>
        <div className="scentinel-capability-list">
          {text.capabilities.map((item, index) => <div className="scentinel-capability" key={item.title}>
            <span className={`scentinel-capability-state ${index === 3 ? "pending" : ""}`}>{index === 3 ? <Radio size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{item.status}</span>
            <h3>{item.title}</h3><p>{item.body}</p>
          </div>)}
        </div>
      </section>

      <section className="scentinel-rdf" id="scentinel-rdf" aria-labelledby="scentinel-rdf-title">
        <div className="scentinel-section-head"><h2 id="scentinel-rdf-title">{text.rdfTitle}</h2><p>{text.rdfIntro}</p></div>
        <div className="scentinel-table-wrap" role="region" aria-label={text.rdfTitle} tabIndex={0}>
          <table><thead><tr>{text.rdfColumns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
            <tbody>{text.rdfRows.map((row) => <tr key={row.name}><th scope="row">{row.name}</th><td>{row.supported}</td><td>{row.blocked}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="scentinel-quality" id="scentinel-quality" aria-labelledby="scentinel-quality-title">
        <div className="scentinel-quality-main">
          <h2 id="scentinel-quality-title">{text.qualityTitle}</h2><p>{text.qualityIntro}</p>
          <div className="scentinel-quality-reading"><strong>{text.qualityMeasure}</strong><span>{text.qualityMeasureLabel}</span></div>
          <p className="scentinel-quality-target">{text.qualityTarget}</p>
        </div>
        <div className="scentinel-quality-notes">{text.qualityRows.map((row) => <div key={row.title}><h3>{row.title}</h3><p>{row.text}</p></div>)}</div>
      </section>

      <section className="scentinel-integration" id="scentinel-integration" aria-labelledby="scentinel-integration-title">
        <div className="scentinel-section-head"><h2 id="scentinel-integration-title">{text.integrationTitle}</h2><p>{text.integrationIntro}</p></div>
        <dl>{text.integrationFields.map((field) => <div key={field.key}><dt>{field.key}</dt><dd>{field.value}</dd></div>)}</dl>
        <footer className="scentinel-footer">
          <p>{text.integrationNote}</p>
          <div><a href="https://github.com/alertxsto/scentinel" target="_blank" rel="noopener noreferrer"><FlaskConical size={17} aria-hidden="true" />{text.source}<ArrowUpRight size={16} aria-hidden="true" /></a>
            <a href="https://github.com/bynguts/jwis-system/issues/23" target="_blank" rel="noopener noreferrer"><ScanSearch size={17} aria-hidden="true" />{text.issue}<ArrowUpRight size={16} aria-hidden="true" /></a></div>
        </footer>
      </section>
    </article>
  );
}
