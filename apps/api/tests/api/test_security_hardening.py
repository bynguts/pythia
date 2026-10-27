"""Auth on read routes, the login throttle, the assistant quota and its error detail."""

import struct
import zlib
from unittest.mock import patch

import pytest

from app.core.auth import LOGIN_MAX_FAILURES, client_ip

SESSION_READS = [
    ("get", "/api/reports/executive-summary"),
    ("get", "/api/ai/events"),
    ("post", "/api/ai/events/0/ack"),
    ("get", "/api/spj/active-path/T-047"),
    ("get", "/api/scentinel/evidence"),
]


@pytest.mark.parametrize("method,path", SESSION_READS)
def test_console_reads_need_a_session(api_client, method, path):
    res = getattr(api_client, method)(path)
    assert res.status_code == 401, f"{path}: {res.status_code}"


@pytest.mark.parametrize("method,path", SESSION_READS)
def test_console_reads_pass_for_the_dispatcher(api_client, auth_headers, method, path):
    res = getattr(api_client, method)(path, headers=auth_headers("dispatcher"))
    assert res.status_code == 200, f"{path}: {res.status_code} {res.text[:200]}"


def test_the_driver_app_reads_its_active_path_with_the_driver_token(api_client, auth_headers):
    res = api_client.get("/api/spj/active-path/T-047", headers=auth_headers("driver"))
    assert res.status_code == 200
    assert res.json()["truck_code"] == "T-047"


def test_a_driver_token_cannot_read_the_executive_summary(api_client, auth_headers):
    assert api_client.get("/api/reports/executive-summary", headers=auth_headers("driver")).status_code == 403


# --- login throttle ---------------------------------------------------------------


def _login(api_client, password, ip="203.0.113.7", username="executive"):
    return api_client.post(
        "/api/auth/login", json={"username": username, "password": password}, headers={"X-Real-IP": ip}
    )


def test_login_is_throttled_after_ten_failures_per_ip_and_username(api_client):
    for _ in range(LOGIN_MAX_FAILURES):
        assert _login(api_client, "wrong").status_code == 401
    blocked = _login(api_client, "executive-demo-pass")
    assert blocked.status_code == 429
    assert 0 < int(blocked.headers["Retry-After"]) <= 300
    # Another client, or another account from the same client, is not locked out.
    assert _login(api_client, "executive-demo-pass", ip="203.0.113.8").status_code == 200
    assert _login(api_client, "auditor-demo-pass", username="auditor").status_code == 200


def test_a_successful_login_clears_the_failure_count(api_client):
    for _ in range(LOGIN_MAX_FAILURES - 1):
        assert _login(api_client, "wrong").status_code == 401
    assert _login(api_client, "executive-demo-pass").status_code == 200
    for _ in range(LOGIN_MAX_FAILURES - 1):
        assert _login(api_client, "wrong").status_code == 401
    assert _login(api_client, "executive-demo-pass").status_code == 200


def test_the_throttle_window_expires(api_client):
    # Only the limiter's clock moves (patching time.monotonic itself would move every clock).
    with patch("app.core.ratelimit.time") as clock:
        clock.monotonic.return_value = 1000.0
        for _ in range(LOGIN_MAX_FAILURES):
            _login(api_client, "wrong")
        assert _login(api_client, "executive-demo-pass").status_code == 429
        clock.monotonic.return_value = 1000.0 + 301
        assert _login(api_client, "executive-demo-pass").status_code == 200


def test_a_non_ascii_password_is_a_401_not_a_500(api_client):
    assert _login(api_client, "pässwörd-日本").status_code == 401


def test_client_ip_trusts_x_real_ip_and_the_outer_proxy_entry():
    assert client_ip("10.0.0.2", None, None) == "10.0.0.2"
    # nginx facing the internet: X-Real-IP is the client; a forged X-Forwarded-For is ignored.
    assert client_ip("172.18.0.3", "8.8.4.4", "1.2.3.4") == "8.8.4.4"
    # nginx behind a proxy on the host: the last X-Forwarded-For entry is the client.
    assert client_ip("172.18.0.3", "127.0.0.1", "1.2.3.4, 8.8.8.8") == "8.8.8.8"
    assert client_ip("172.18.0.3", "172.18.0.1", None) == "172.18.0.1"


# --- assistant ----------------------------------------------------------------------

_LOCAL_ANSWER = {"provider": "local", "mode": "local", "answer": "ok"}


def test_assistant_gateway_errors_do_not_leak_their_text(api_client, auth_headers):
    boom = RuntimeError("Failed to open stream http://10.1.2.3:8317/v1")
    with patch("app.api.routers.assistant.answer_with_openai_if_configured", side_effect=boom):
        res = api_client.post(
            "/api/assistant/query", json={"question": "status?"}, headers=auth_headers("dispatcher")
        )
    assert res.status_code == 502
    assert "10.1.2.3" not in res.text and "Failed to open stream" not in res.text


def test_assistant_allows_twenty_questions_per_session_in_five_minutes(api_client, auth_headers):
    headers = auth_headers("dispatcher")
    with patch("app.api.routers.assistant.answer_with_openai_if_configured", return_value=_LOCAL_ANSWER):
        for _ in range(20):
            ok = api_client.post("/api/assistant/query", json={"question": "status?"}, headers=headers)
            assert ok.status_code == 200, ok.text
        res = api_client.post("/api/assistant/query", json={"question": "status?"}, headers=headers)
        assert res.status_code == 429
        assert int(res.headers["Retry-After"]) > 0
        # The quota is per session: another signed-in user still gets answers.
        other = api_client.post(
            "/api/assistant/query", json={"question": "status?"}, headers=auth_headers("administrator")
        )
        assert other.status_code == 200


@pytest.mark.parametrize(
    "file_data,file_type",
    [
        ("https://example.test/a.png", "image"),
        ("http://169.254.169.254/latest/meta-data", "image"),
        ("data:text/html;base64,PGgxPg==", "image"),
        ("https://example.test/a.pdf", "pdf"),
        ("data:image/png;base64,AAAA", "pdf"),
    ],
)
def test_assistant_attachments_must_be_data_urls(api_client, auth_headers, file_data, file_type):
    with patch("app.api.routers.assistant.answer_with_openai_if_configured") as answer:
        res = api_client.post(
            "/api/assistant/query",
            json={"question": "baca ini", "file_data": file_data, "file_type": file_type},
            headers=auth_headers("dispatcher"),
        )
    assert res.status_code == 422, res.text
    answer.assert_not_called()


def test_assistant_accepts_an_image_data_url(api_client, auth_headers):
    image = "data:image/png;base64,iVBORw0KGgo="
    with patch(
        "app.api.routers.assistant.answer_with_openai_if_configured", return_value=_LOCAL_ANSWER
    ) as answer:
        res = api_client.post(
            "/api/assistant/query",
            json={"question": "baca ini", "file_data": image, "file_type": "image"},
            headers=auth_headers("dispatcher"),
        )
    assert res.status_code == 200
    assert answer.call_args.kwargs["images"] == [image]


# --- image decoding limit ------------------------------------------------------------


def _png_header(width: int, height: int) -> bytes:
    """A PNG whose header claims width x height; Pillow reads the size without decoding."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    chunk = b"IHDR" + ihdr
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", len(ihdr))
        + chunk
        + struct.pack(">I", zlib.crc32(chunk) & 0xFFFFFFFF)
    )


def test_thumbnail_refuses_images_above_forty_megapixels():
    pytest.importorskip("PIL")
    from app.api.routers.spj import _thumbnail

    assert _thumbnail(_png_header(8000, 6000)) is None  # 48 MP: never decoded


def test_thumbnail_still_resizes_a_normal_photo():
    image_module = pytest.importorskip("PIL.Image")
    import io

    from app.api.routers.spj import _thumbnail

    out = io.BytesIO()
    image_module.new("RGB", (1200, 900), "white").save(out, format="JPEG")
    small = _thumbnail(out.getvalue())
    assert small is not None and small.startswith(b"\xff\xd8")
