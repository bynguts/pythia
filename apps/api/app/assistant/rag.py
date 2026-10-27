from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer

from app.core.paths import KNOWLEDGE_DIR, PROCESSED_DIR, REPO_ROOT, SOURCES_DIR

CURATED_KNOWLEDGE = [
    {
        "source": "curated:pythia_overview",
        "title": "Pythia overview",
        "text": (
            "Pythia is an AI operations platform for DKI Jakarta waste collection, built as two surfaces: a "
            "dispatcher console and a driver app. In the console the dispatcher sees the pilot fleet on one "
            "map, issues work orders (SPJ) to drivers, books TPA Bantargebang gate slots so trucks reach the "
            "weighbridge spread across the day, and closes the day with a recap of weighed tonnes against the "
            "plan. The Tomorrow page forecasts city-wide waste for all 42 kecamatan 7, 14 or 30 days ahead, "
            "turns it into trucks, crews and a plan, and self-corrects from weighbridge data. Drivers use the "
            "driver app for their work orders, navigation, weighbridge tickets and private messages from the "
            "dispatcher. Ana, the assistant, answers from live tools and proposes actions; a human approves "
            "every send before anything changes."
        ),
    },
    # The same overview in Indonesian: a local answer quotes only excerpts in the UI language.
    {
        "source": "curated:pythia_overview_id",
        "title": "Ringkasan Pythia",
        "text": (
            "Pythia adalah platform operasi berbasis AI untuk pengangkutan sampah DKI Jakarta, dengan dua "
            "permukaan: konsol dispatcher dan aplikasi pengemudi. Fitur utama Pythia dan cara kerja Pythia: di "
            "konsol, dispatcher melihat armada uji coba di satu peta, menerbitkan surat jalan (SPJ) ke pengemudi, "
            "memesan slot gerbang TPA Bantargebang agar truk tiba di jembatan timbang tersebar sepanjang hari, dan "
            "menutup hari dengan rekap tonase tertimbang dibandingkan rencana. Halaman Besok memprakirakan sampah "
            "se-kota untuk 42 kecamatan 7, 14 atau 30 hari ke depan, mengubahnya menjadi kebutuhan truk, kru dan "
            "rencana, dan mengoreksi diri dari data jembatan timbang. Pengemudi memakai aplikasi pengemudi untuk "
            "surat jalan, navigasi, tiket timbang dan pesan pribadi dari dispatcher. Asisten Ana menjawab dari alat "
            "data langsung dan mengusulkan tindakan; manusia menyetujui setiap pengiriman sebelum ada yang berubah."
        ),
    },
    {
        "source": "curated:waste_forecast",
        "title": "Waste forecast capability",
        "text": (
            "The Waste Forecast module predicts waste tonnage for the next 7 days, 14 days or 30 days, city-wide, "
            "with the total, the average per day, the peak day and the trucks needed at the peak. Each of the 42 kecamatan has "
            "its own Prophet + XGBoost model; district rows carry predicted_tons, baseline_tons, spike_percent, "
            "risk_level, recommended_extra_trucks, recommended_extra_crews, trucks_required, crews_required, "
            "workers_required, man_hours_required (person-hours) and bins_required. Inputs fill themselves: "
            "Open-Meteo rainfall, temperature and wind for the first 16 days, then a dry-day baseline (0 mm "
            "rain) that sharpens as the weather forecast reaches each day, plus weekends, national holidays, "
            "official events and permitted crowd events. The forecast learns from the weighbridge: every closed "
            "work-order day's weighed tonnes are compared with the plan's forecast, and from the third weighed "
            "day a bounded correction (capped at 25 %) appears beside the model figure, never instead of it. "
            "Bantargebang intake is forecast monthly, validated 1-3 months ahead on real weighing data."
        ),
    },
    {
        "source": "curated:fleet_routing",
        "title": "Fleet routing and map operations",
        "text": (
            "Fleet Operations shows a MapLibre supervision map of the simulated pilot fleet. Vehicles are classified by corridor compliance and condition. "
            "T-047 is the critical route deviation demo truck. Pythia compares assigned and actual movement, highlights violation "
            "segments, and recommends recovery routes such as Route B - Daan Mogot Recovery. OSRM supplies road geometry, ETA, "
            "and route evidence. A* dynamic rerouting simulates corridor congestion and diverts trucks through recovery paths."
        ),
    },
    {
        "source": "curated:dispatch_loop",
        "title": "Dispatch and field confirmation loop",
        "text": (
            "Pythia is a closed operational loop: detect, predict, recommend, approve, dispatch, confirm, and audit. Managers approve "
            "dispatch actions in the command center. Drivers receive clear instructions in the field app or through WhatsApp Gateway "
            "when Baileys is connected. Field confirmations are stored in the backend history so managers can verify whether an "
            "instruction was received and acted on."
        ),
    },
    {
        "source": "curated:data_provenance",
        "title": "Data provenance and honest demo limits",
        "text": (
            "Pythia uses public and fallback sources: Open-Meteo weather forecast and historical weather, Indonesian holiday calendar, "
            "Jakarta administrative geography, SILIKA/DLH-derived waste references, SIPSN/Bantargebang references where available, "
            "OSRM public routing, and explicit simulated fleet/event inputs for prototype demonstration. The system must describe "
            "fleet GPS, event inputs, and some waste seed data as simulated or fallback when they are not official live feeds."
        ),
    },
    {
        "source": "curated:assistant_behavior",
        "title": "Ana assistant behavior",
        "text": (
            "Ana is the operational AI assistant inside Pythia. Ana should answer questions about Pythia features, data, forecast, routing, "
            "dispatch, map pins, WhatsApp Gateway, field app, model audit, demo limitations, and competition narrative. Ana should be "
            "clear, practical, and honest. Ana must not claim live WhatsApp delivery unless the gateway is connected and the send result "
            "confirms delivery. Ana should avoid raw JSON, snake_case fields, and unexplained technical labels in normal answers."
        ),
    },
    {
        "source": "curated:gate_surveillance",
        "title": "Gate surveillance (computer vision) capability",
        "text": (
            "The Gate Surveillance module (Case 1 illegal-activity requirement) is a computer-vision ANPR pipeline: YOLOv8n detects "
            "trucks in a gate-camera feed, EasyOCR reads the license plate, and the DLH registry whitelist decides authorized vs "
            "unlicensed. Unlicensed plates surface as critical UNLICENSED alerts. The feed is a simulated demo clip labeled "
            "source=simulated, exactly like the simulated GPS feed; the event contract is identical to a real DLH gate camera + ANPR, "
            "so swapping in a camera at pilot requires no downstream change. Ana must not claim live camera processing when the feed "
            "is the simulated clip."
        ),
    },
]


DOCUMENT_PATHS = [
    REPO_ROOT / "README.md",
    KNOWLEDGE_DIR / "ARCHITECTURE.md",
    KNOWLEDGE_DIR / "PRODUCT.md",
    PROCESSED_DIR / "eda_report.md",
    PROCESSED_DIR / "fleet_anomaly_evaluation.md",
    PROCESSED_DIR / "hybrid_forecaster_evaluation.md",
    PROCESSED_DIR / "system_impact_evaluation.md",
    SOURCES_DIR / "DATA_RESEARCH_SUMMARY.md",
    REPO_ROOT / "apps" / "wa-gateway" / "package.json",
    KNOWLEDGE_DIR / "01_OPERATIONS_AND_DECISION_LOGIC.md",
    KNOWLEDGE_DIR / "02_MODULES_AND_WORKFLOW.md",
    KNOWLEDGE_DIR / "03_DASHBOARD_OPERATOR_GUIDE.md",
    KNOWLEDGE_DIR / "04_DEMO_NARRATIVE_AND_LIMITS.md",
]


def _source_label(path: Path) -> str:
    """Repo-relative label for citations (falls back to the file name)."""
    try:
        return path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.name


@dataclass(frozen=True)
class RagChunk:
    source: str
    title: str
    text: str


@dataclass
class RagIndex:
    chunks: list[RagChunk]
    vectorizer: TfidfVectorizer
    mean: np.ndarray
    components: np.ndarray
    scale: np.ndarray
    vectors: np.ndarray
    raw_vectors: np.ndarray


def _clean_text(text: str) -> str:
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _read_document(path: Path) -> str:
    text = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix == ".json":
        try:
            text = json.dumps(json.loads(text), indent=2, ensure_ascii=False)
        except Exception:
            pass
    return _clean_text(text[:30000])


def _chunk_text(
    source: str, title: str, text: str, max_chars: int = 1400, overlap: int = 220
) -> list[RagChunk]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[RagChunk] = []
    current = ""
    for paragraph in paragraphs:
        if len(current) + len(paragraph) + 2 <= max_chars:
            current = f"{current}\n\n{paragraph}".strip()
            continue
        if current:
            chunks.append(RagChunk(source=source, title=title, text=current))
        current = paragraph[-max_chars:]
    if current:
        chunks.append(RagChunk(source=source, title=title, text=current))

    if overlap <= 0 or len(chunks) <= 1:
        return chunks
    overlapped: list[RagChunk] = []
    prev_tail = ""
    for chunk in chunks:
        text_with_overlap = f"{prev_tail}\n\n{chunk.text}".strip() if prev_tail else chunk.text
        overlapped.append(
            RagChunk(source=chunk.source, title=chunk.title, text=text_with_overlap[-max_chars:])
        )
        prev_tail = chunk.text[-overlap:]
    return overlapped


def load_rag_chunks() -> list[RagChunk]:
    chunks: list[RagChunk] = [
        RagChunk(source=item["source"], title=item["title"], text=item["text"]) for item in CURATED_KNOWLEDGE
    ]
    for path in DOCUMENT_PATHS:
        if not path.exists():
            continue
        text = _read_document(path)
        if not text:
            continue
        title = path.stem.replace("_", " ").replace("-", " ").title()
        chunks.extend(_chunk_text(source=_source_label(path), title=title, text=text))
    return chunks


def _fit_whitening(vectors: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = vectors.mean(axis=0, keepdims=True)
    centered = vectors - mean
    if centered.shape[0] < 2:
        components = np.eye(centered.shape[1], dtype=np.float32)
        scale = np.ones(centered.shape[1], dtype=np.float32)
        return mean, components, scale

    _, singular_values, vt = np.linalg.svd(centered, full_matrices=False)
    eps = 1e-6
    scale = np.sqrt(max(centered.shape[0] - 1, 1)) / np.maximum(singular_values, eps)
    return mean.astype(np.float32), vt.astype(np.float32), scale.astype(np.float32)


def _apply_whitening(
    vectors: np.ndarray, mean: np.ndarray, components: np.ndarray, scale: np.ndarray
) -> np.ndarray:
    projected = (vectors - mean) @ components.T
    whitened = projected * scale
    norm = np.linalg.norm(whitened, axis=1, keepdims=True)
    return whitened / np.maximum(norm, 1e-9)


def _normalize(vectors: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.maximum(norm, 1e-9)


@lru_cache(maxsize=1)
def build_rag_index() -> RagIndex:
    chunks = load_rag_chunks()
    texts = [f"{chunk.title}\n{chunk.text}" for chunk in chunks]
    vectorizer = TfidfVectorizer(
        lowercase=True,
        strip_accents="unicode",
        ngram_range=(1, 2),
        max_features=5000,
        min_df=1,
        sublinear_tf=True,
    )
    raw = vectorizer.fit_transform(texts).astype(np.float32).toarray()
    raw_vectors = _normalize(raw)
    mean, components, scale = _fit_whitening(raw)
    vectors = _apply_whitening(raw, mean, components, scale)
    return RagIndex(
        chunks=chunks,
        vectorizer=vectorizer,
        mean=mean,
        components=components,
        scale=scale,
        vectors=vectors,
        raw_vectors=raw_vectors,
    )


def retrieve_pythia_context(question: str, top_k: int = 5) -> list[dict[str, Any]]:
    index = build_rag_index()
    query_text = (
        f"{question or 'Pythia overview'} "
        "Pythia fitur feature cara kerja workflow overview arsitektur architecture forecast routing dispatch audit map"
    )
    query_raw = index.vectorizer.transform([query_text]).astype(np.float32).toarray()
    query = _apply_whitening(query_raw, index.mean, index.components, index.scale)[0]
    query_lexical = _normalize(query_raw)[0]
    whitened_scores = index.vectors @ query
    lexical_scores = index.raw_vectors @ query_lexical
    scores = (0.55 * whitened_scores) + (0.45 * lexical_scores)
    order = np.argsort(scores)[::-1][:top_k]
    results = []
    for idx in order:
        chunk = index.chunks[int(idx)]
        results.append(
            {
                "source": chunk.source,
                "title": chunk.title,
                "text": chunk.text,
                "score": float(scores[int(idx)]),
            }
        )
    return results


def format_rag_context(question: str, top_k: int = 5, max_chars: int = 5000) -> str:
    parts = []
    for item in retrieve_pythia_context(question, top_k=top_k):
        parts.append(f"[{item['title']} | {item['source']} | score={item['score']:.3f}]\n{item['text']}")
    context = "\n\n---\n\n".join(parts)
    return context[:max_chars]
