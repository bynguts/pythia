"""Starting the WhatsApp gateway from Settings: no real process, gateway or WhatsApp is touched."""

import subprocess

import pytest

from app.integrations import wa_gateway_process
from app.integrations.whatsapp import OpenWAClient

START = "/api/whatsapp/gateway/start"


class FakeProcess:
    pid = 4242

    def __init__(self):
        self.returncode = None
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.returncode = -9


@pytest.fixture()
def gateway(monkeypatch, tmp_path):
    """A local gateway dir with node_modules, node on PATH, nothing reachable, Popen faked."""
    (tmp_path / "node_modules").mkdir()
    monkeypatch.setattr(wa_gateway_process, "WA_GATEWAY_DIR", tmp_path)
    monkeypatch.setattr(wa_gateway_process, "LOG_FILE", tmp_path / "gateway.log")
    monkeypatch.setattr(wa_gateway_process, "_process", None)
    monkeypatch.setattr(wa_gateway_process, "gateway_reachable", lambda _url: False)
    monkeypatch.setattr(OpenWAClient, "health", lambda _self: {"connected": False, "message": "offline"})
    monkeypatch.setattr(wa_gateway_process.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setenv("OPENWA_BASE_URL", "http://127.0.0.1:2785/api")
    spawned = []
    installs = []

    def fake_popen(argv, **kwargs):
        spawned.append((argv, kwargs))
        return FakeProcess()

    monkeypatch.setattr(wa_gateway_process.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(
        wa_gateway_process.subprocess, "run", lambda argv, **kwargs: installs.append((argv, kwargs))
    )
    return {"dir": tmp_path, "spawned": spawned, "installs": installs}


def test_start_spawns_node_server_once_without_a_shell(api_client, auth_headers, gateway):
    first = api_client.post(START, headers=auth_headers("administrator"))
    assert first.status_code == 200, first.text
    assert first.json() == {"started": True, "state": "starting"}
    second = api_client.post(START, headers=auth_headers("administrator"))
    assert second.json() == {"started": False, "state": "running"}

    assert len(gateway["spawned"]) == 1
    argv, kwargs = gateway["spawned"][0]
    assert argv == ["/usr/bin/node", "server.js"]
    assert kwargs["cwd"] == gateway["dir"]
    assert "shell" not in kwargs
    assert gateway["installs"] == []  # node_modules exists


def test_status_reports_the_gateway_process(api_client, auth_headers, gateway):
    before = api_client.get("/api/whatsapp/status", headers=auth_headers("dispatcher")).json()
    assert before["gateway_process"] == {"managed": "local", "running": False, "exit_code": None}
    api_client.post(START, headers=auth_headers("administrator"))
    after = api_client.get("/api/whatsapp/status", headers=auth_headers("dispatcher")).json()
    assert after["gateway_process"]["running"] is True


def test_a_gateway_already_answering_is_not_started_again(api_client, auth_headers, gateway, monkeypatch):
    monkeypatch.setattr(wa_gateway_process, "gateway_reachable", lambda _url: True)
    res = api_client.post(START, headers=auth_headers("administrator"))
    assert res.json() == {"started": False, "state": "already_reachable"}
    assert gateway["spawned"] == []


def test_missing_node_modules_runs_npm_install_first(api_client, auth_headers, gateway):
    (gateway["dir"] / "node_modules").rmdir()
    res = api_client.post(START, headers=auth_headers("administrator"))
    assert res.status_code == 200
    argv, kwargs = gateway["installs"][0]
    assert argv == ["/usr/bin/npm", "install", "--no-audit", "--no-fund"]
    assert kwargs["cwd"] == gateway["dir"]
    assert len(gateway["spawned"]) == 1


def test_a_non_local_gateway_is_managed_externally(api_client, auth_headers, gateway, monkeypatch):
    monkeypatch.setenv("OPENWA_BASE_URL", "http://wa-gateway:2785/api")
    res = api_client.post(START, headers=auth_headers("administrator"))
    assert res.status_code == 409
    assert "managed externally" in res.json()["detail"]
    assert gateway["spawned"] == []
    status = api_client.get("/api/whatsapp/status", headers=auth_headers("dispatcher")).json()
    assert status["gateway_process"]["managed"] == "external"


def test_an_unconfigured_gateway_is_not_started(api_client, auth_headers, gateway, monkeypatch):
    monkeypatch.setenv("OPENWA_BASE_URL", "")
    res = api_client.post(START, headers=auth_headers("administrator"))
    assert res.status_code == 409
    assert "not configured" in res.json()["detail"]
    assert gateway["spawned"] == []


def test_missing_node_is_503(api_client, auth_headers, gateway, monkeypatch):
    monkeypatch.setattr(wa_gateway_process.shutil, "which", lambda _name: None)
    res = api_client.post(START, headers=auth_headers("administrator"))
    assert res.status_code == 503
    assert "Node.js is not installed" in res.json()["detail"]
    assert gateway["spawned"] == []


def test_a_failed_spawn_is_503(api_client, auth_headers, gateway, monkeypatch):
    def broken_popen(argv, **kwargs):
        raise OSError("spawn failed")

    monkeypatch.setattr(wa_gateway_process.subprocess, "Popen", broken_popen)
    res = api_client.post(START, headers=auth_headers("administrator"))
    assert res.status_code == 503
    assert "could not be started" in res.json()["detail"]


def test_start_needs_an_administrator(api_client, auth_headers, gateway):
    assert api_client.post(START).status_code == 401
    for role in ("dispatcher", "supervisor", "driver"):
        assert api_client.post(START, headers=auth_headers(role)).status_code == 403
    assert gateway["spawned"] == []


def test_stop_terminates_only_the_process_it_started(gateway):
    wa_gateway_process.stop()  # nothing started: no-op
    wa_gateway_process.start("http://127.0.0.1:2785/api")
    process = wa_gateway_process._process
    wa_gateway_process.stop()
    assert process.terminated
    assert wa_gateway_process._process is None


def test_stop_kills_a_gateway_that_ignores_terminate(gateway):
    wa_gateway_process.start("http://127.0.0.1:2785/api")
    process = wa_gateway_process._process

    def stuck_wait(timeout=None):
        raise subprocess.TimeoutExpired("node", timeout)

    process.terminate = lambda: None
    process.wait = stuck_wait
    wa_gateway_process.stop()
    assert process.returncode == -9
