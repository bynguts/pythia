"""Demo-path reliability fixes for the 2026 competition build (WS-C)."""

from unittest import mock


def test_confirm_with_operation_id_for_unknown_dispatch_is_404(api_client, auth_headers):
    response = api_client.post(
        "/api/dispatch/does-not-exist/confirm",
        json={"status": "READY", "note": "", "operation_id": "op-unknown-1"},
        headers=auth_headers("driver"),
    )
    assert response.status_code == 404


def test_normal_spj_completion_records_no_override_event(api_client, auth_headers):
    # The last stop normally closes the SPJ itself, so this path is only
    # reachable by a direct close; it must not crash on the missing override.
    closed = {"spj_id": "spj-x", "status": "selesai", "stops": []}
    with (
        mock.patch("app.main.SPJ_STORE.complete", return_value=object()) as complete,
        mock.patch("app.main._spj_payload", return_value=closed),
        mock.patch("app.main.history_store.record_event") as record_event,
    ):
        response = api_client.post("/api/spj/spj-x/complete", headers=auth_headers("supervisor"))
    assert response.status_code == 200
    complete.assert_called_once_with("spj-x", None)
    assert not any(call.args[0] == "spj_completed_by_override" for call in record_event.call_args_list)


def test_requirements_declare_python_dotenv():
    from pathlib import Path

    requirements = (Path(__file__).resolve().parents[1] / "requirements.txt").read_text()
    assert "python-dotenv" in requirements
