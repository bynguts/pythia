from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

from scrapling.fetchers import Fetcher


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
SOURCES = ROOT / "data" / "sources"

TARGETS = [
    {
        "name": "satudata_open_data",
        "url": "https://satudata.jakarta.go.id/open-data",
        "keywords": ["sampah", "timbulan", "lingkungan", "kelurahan", "dataset", "api"],
    },
    {
        "name": "satudata_waste_detail",
        "url": "https://satudata.jakarta.go.id/open-data/detail/data-timbulan-dan-berat-jenis-sampah-di-setiap-sumber-sampah",
        "keywords": ["sampah", "dataset", "tidak ditemukan", "open data"],
    },
    {
        "name": "satudata_kelurahan_dashboard",
        "url": "https://satudata.jakarta.go.id/dashboard/dashboard-publik/dashboard-potensi-kelurahan?blok=kependudukan-dan-ketenagakerjaan",
        "keywords": ["kelurahan", "podes", "bps", "download data", "metadata"],
    },
    {
        "name": "jakarta_satu_geospatial",
        "url": "https://satudata.jakarta.go.id/jakarta-satu",
        "keywords": ["geospasial", "jakarta satu", "satu peta", "kelurahan"],
    },
]


def compact_text(text: str) -> str:
    return " ".join(text.split())


def html_to_text(html: str) -> str:
    html = re.sub(r"<script\b[^>]*>.*?</script>", " ", html, flags=re.I | re.S)
    html = re.sub(r"<style\b[^>]*>.*?</style>", " ", html, flags=re.I | re.S)
    html = re.sub(r"<[^>]+>", " ", html)
    return compact_text(html)


def scrape_target(target: dict) -> dict:
    page = Fetcher.get(target["url"], stealthy_headers=True, timeout=30000)
    html = str(page.html_content or page.body.decode("utf-8", "ignore"))
    text = html_to_text(html)
    if not text:
        text = compact_text(html)
    RAW.joinpath(f"{target['name']}.txt").write_text(text[:12000], encoding="utf-8")

    lower = text.lower()
    matches = [keyword for keyword in target["keywords"] if keyword.lower() in lower]
    links = []
    for link in page.css("a"):
        href = link.attrib.get("href", "")
        label = compact_text(link.get_all_text() or link.text or "")
        if href:
            links.append({"text": label[:120], "href": href})

    return {
        "name": target["name"],
        "url": target["url"],
        "status": "scraped",
        "keyword_matches": matches,
        "text_file": f"data/raw/{target['name']}.txt",
        "links_sample": links[:20],
    }


def main() -> int:
    RAW.mkdir(parents=True, exist_ok=True)
    SOURCES.mkdir(parents=True, exist_ok=True)
    results = []
    for target in TARGETS:
        try:
            result = scrape_target(target)
        except Exception as error:
            result = {"name": target["name"], "url": target["url"], "status": "failed", "error": str(error)}
        results.append(result)
        print(f"{result['name']}: {result['status']}")

    SOURCES.joinpath("scrapling_research_manifest.json").write_text(
        json.dumps({"generated_at": date.today().isoformat(), "results": results}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
