"""#76: the assistant request carries an explicit UI language and the
gateway system prompt pins the answer language for the conversation."""
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_assistant_request_accepts_language_field(monkeypatch):
    monkeypatch.setenv("JWIS_DB_PATH", "/tmp/test-76-language.db")
    login = client.post("/api/auth/login", json={
        "username": "dispatcher", "password": "dispatcher-demo-pass"})
    assert login.status_code == 200
    token = login.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    captured = {}

    def fake_answer(question, snapshot, history=None, tool_ctx=None, images=None, language="id"):
        captured["language"] = language
        return {"answer": "ok", "provider": "local"}

    with patch("app.main.answer_with_openai_if_configured", side_effect=fake_answer):
        res = client.post("/api/assistant/query", headers=headers,
                          json={"question": "status?", "language": "en"})
    assert res.status_code == 200
    assert captured["language"] == "en"


def test_assistant_language_defaults_to_indonesian(monkeypatch):
    monkeypatch.setenv("JWIS_DB_PATH", "/tmp/test-76-language.db")
    login = client.post("/api/auth/login", json={
        "username": "dispatcher", "password": "dispatcher-demo-pass"})
    token = login.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    captured = {}

    def fake_answer(question, snapshot, history=None, tool_ctx=None, images=None, language="id"):
        captured["language"] = language
        return {"answer": "ok", "provider": "local"}

    with patch("app.main.answer_with_openai_if_configured", side_effect=fake_answer):
        res = client.post("/api/assistant/query", headers=headers,
                          json={"question": "status?"})
    assert res.status_code == 200
    assert captured["language"] == "id"


def test_assistant_rejects_unknown_language(monkeypatch):
    monkeypatch.setenv("JWIS_DB_PATH", "/tmp/test-76-language.db")
    login = client.post("/api/auth/login", json={
        "username": "dispatcher", "password": "dispatcher-demo-pass"})
    token = login.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    res = client.post("/api/assistant/query", headers=headers,
                      json={"question": "status?", "language": "fr"})
    assert res.status_code == 422
