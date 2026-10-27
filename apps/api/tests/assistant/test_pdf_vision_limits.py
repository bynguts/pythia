"""PDF attachments: only data URLs, at most three pages, no oversized page renders."""

import base64

import pymupdf
import pytest

from app.assistant.pdf_vision import pdf_bytes_to_image_data_urls, resolve_file_to_images


def _pdf(*sizes: tuple[float, float]) -> bytes:
    doc = pymupdf.open()
    for width, height in sizes:
        doc.new_page(width=width, height=height)
    data = doc.tobytes()
    doc.close()
    return data


def test_a_page_that_would_render_above_25_megapixels_is_skipped():
    # 14400 pt square at 100 dpi = 20000 x 20000 px = 400 MP.
    urls = pdf_bytes_to_image_data_urls(_pdf((595, 842), (14400, 14400), (595, 842)))
    assert len(urls) == 2
    assert all(u.startswith("data:image/jpeg;base64,") for u in urls)


def test_only_the_first_three_pages_are_rendered():
    assert len(pdf_bytes_to_image_data_urls(_pdf(*[(595, 842)] * 5))) == 3


def test_a_pdf_data_url_resolves_to_page_images():
    data_url = "data:application/pdf;base64," + base64.b64encode(_pdf((595, 842))).decode()
    assert len(resolve_file_to_images(data_url, "pdf")) == 1


@pytest.mark.parametrize(
    "file_data,file_type",
    [
        ("https://example.test/x.png", "image"),
        ("data:image/svg+xml;base64,PHN2Zz4=", "image"),
        ("https://example.test/x.pdf", "pdf"),
        ("data:application/pdf;base64,!!!not-base64!!!", "pdf"),
    ],
)
def test_anything_but_a_data_url_of_the_declared_kind_is_refused(file_data, file_type):
    with pytest.raises(ValueError):
        resolve_file_to_images(file_data, file_type)
