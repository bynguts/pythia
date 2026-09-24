"""Fixture-backed tests for the Scentinel evidence import (#23).

Covers: valid import, incompatible schema, failed run, unconverged run,
and malformed sensor CSV. Imported results must be labelled
external_simulation evidence, never live telemetry.
"""

import pytest
from fastapi.testclient import TestClient

from app.scentinel import ScentinelImportError, import_scentinel_evidence

VALID_MANIFEST = {
    "schema": "scentinel.run.v1",
    "run_id": "run-2026-09-24-001",
    "source_repository": "https://github.com/alertxsto/scentinel",
    "source_version": "v1.2.0",
    "scenario": "tps-cilandak-compact",
    "gas_set": ["ch4", "h2s", "nh3"],
    "candidate_sensors": [
        {"sensor_id": "S1", "lat": -6.29, "lng": 106.79, "rationale": "upwind boundary"},
        {"sensor_id": "S2", "lat": -6.30, "lng": 106.80, "rationale": "plume centroid"},
    ],
    "execution": {
        "pipeline_success": True,
        "numerical_convergence": True,
        "mesh_independence": False,
        "mass_balance": True,
        "experimental_validation": False,
        "finished_at": "2026-09-24T04:00:00Z",
    },
    "input_digest": "abc123def456",
}

VALID_CSV = (
    "timestamp,sensor_id,gas,ppm\n"
    "2026-09-24T04:00:01Z,S1,ch4,12.5\n"
    "2026-09-24T04:00:02Z,S2,h2s,3.1\n"
)


def test_valid_import_labels_evidence_external_simulation():
    ev = import_scentinel_evidence(VALID_MANIFEST, VALID_CSV, truck_code="T-047")
    assert ev.evidence_class == "external_simulation"
    assert ev.truck_code == "T-047"
    assert ev.sensor_csv_rows == 2
    assert ev.gates["pipeline_success"] is True
    assert ev.gates["experimental_validation"] is False
    assert ev.source_version == "v1.2.0"


def test_incompatible_schema_is_rejected_with_actionable_error():
    bad = dict(VALID_MANIFEST, schema="scentinel.run.v9")
    with pytest.raises(ScentinelImportError) as exc:
        import_scentinel_evidence(bad, VALID_CSV)
    assert "scentinel.run.v1" in str(exc.value)


def test_failed_run_is_rejected():
    failed = dict(VALID_MANIFEST)
    failed["execution"] = dict(VALID_MANIFEST["execution"], pipeline_success=False)
    with pytest.raises(ScentinelImportError) as exc:
        import_scentinel_evidence(failed, VALID_CSV)
    assert "pipeline_success=false" in str(exc.value)


def test_unconverged_run_imports_but_records_gate_off():
    unconverged = dict(VALID_MANIFEST)
    unconverged["execution"] = dict(
        VALID_MANIFEST["execution"], numerical_convergence=False
    )
    ev = import_scentinel_evidence(unconverged, VALID_CSV)
    assert ev.gates["numerical_convergence"] is False
    assert ev.gates["pipeline_success"] is True


def test_malformed_sensor_csv_rejected():
    with pytest.raises(ScentinelImportError) as exc:
        import_scentinel_evidence(VALID_MANIFEST, "timestamp,sensor_id\nrow")
    assert "missing required column" in str(exc.value).lower()


def test_api_endpoint_imports_and_lists(auth_headers):
    from app.main import app

    client = TestClient(app)
    r = client.post(
        "/api/scentinel/evidence",
        headers=auth_headers("dispatcher"),
        json={
            "manifest": VALID_MANIFEST,
            "sensor_csv": VALID_CSV,
            "truck_code": "T-047",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["evidence_class"] == "external_simulation"
    assert body["quality_gates"]["pipeline_success"] is True

    listing = client.get("/api/scentinel/evidence")
    assert listing.status_code == 200
    items = listing.json()["items"]
    assert any(i["run_id"] == VALID_MANIFEST["run_id"] for i in items)


def test_api_endpoint_rejects_incompatible_schema(auth_headers):
    from app.main import app

    client = TestClient(app)
    r = client.post(
        "/api/scentinel/evidence",
        headers=auth_headers("dispatcher"),
        json={
            "manifest": dict(VALID_MANIFEST, schema="scentinel.run.v9"),
            "sensor_csv": VALID_CSV,
        },
    )
    assert r.status_code == 422
    assert "scentinel.run.v1" in r.json()["detail"]
