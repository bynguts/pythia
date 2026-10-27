"""PDF page → image conversion for ANA's multimodal vision pipeline.

The gateway model (ag/gemini-3-flash) supports vision:true but pdf:false.
This module bridges that gap: render each PDF page to a PNG at 150 DPI and
return data URLs the model can ingest as image_url content.
"""

from __future__ import annotations

import base64
import binascii
import re

import pymupdf

_MAX_PAGES = 3
_RENDER_DPI = 100
# A page whose render would exceed this many pixels is skipped (a huge MediaBox
# would otherwise allocate gigabytes for one pixmap).
_MAX_PAGE_PIXELS = 25_000_000

# Only inline data goes to the model, never a URL it would fetch.
IMAGE_DATA_URL = re.compile(r"^data:image/(png|jpeg|jpg|webp|gif);base64,", re.IGNORECASE)
PDF_DATA_URL = re.compile(r"^data:application/pdf;base64,", re.IGNORECASE)


def pdf_bytes_to_image_data_urls(pdf_bytes: bytes, max_pages: int = _MAX_PAGES) -> list[str]:
    """Render up to max_pages PDF pages as base64 JPEG data URLs."""
    urls: list[str] = []
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    zoom = _RENDER_DPI / 72.0
    matrix = pymupdf.Matrix(zoom, zoom)
    try:
        for page in doc:
            if len(urls) >= max_pages:
                break
            rect = page.rect
            if rect.width * zoom * rect.height * zoom > _MAX_PAGE_PIXELS:
                continue
            pix = page.get_pixmap(matrix=matrix)
            jpg_bytes = pix.tobytes("jpeg", jpg_quality=85)
            b64 = base64.b64encode(jpg_bytes).decode("ascii")
            urls.append(f"data:image/jpeg;base64,{b64}")
    finally:
        doc.close()
    return urls


def data_url_to_bytes(data_url: str) -> tuple[bytes, str]:
    """Split a data URL into raw bytes and its mime type."""
    header, _, b64 = data_url.partition(",")
    mime = header.split(":")[1].split(";")[0] if ":" in header else "application/octet-stream"
    try:
        return base64.b64decode(b64, validate=True), mime
    except (binascii.Error, ValueError):
        raise ValueError("The attached file is not valid base64.") from None


def resolve_file_to_images(file_data: str, file_type: str) -> list[str]:
    """Resolve an uploaded file (image or PDF) into a list of image data URLs.

    ValueError when the file is not a base64 data URL of the declared kind.
    """
    if file_type == "image":
        if not IMAGE_DATA_URL.match(file_data):
            raise ValueError("The attached image must be a PNG, JPEG, WebP or GIF data URL.")
        return [file_data]
    if file_type == "pdf":
        if not PDF_DATA_URL.match(file_data):
            raise ValueError("The attached file must be a PDF data URL.")
        raw, _ = data_url_to_bytes(file_data)
        return pdf_bytes_to_image_data_urls(raw)
    return []
