"""Scentinel sensor-placement evidence import (#23).

`alertxsto/scentinel` runs CFD screening (OpenFOAM) to propose sensor
placements. JWIS consumes its *outputs* as immutable external evidence —
never as live telemetry. The backend never executes the solver.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# The manifest schema this integration is pinned to. A manifest that does
# not match is rejected with an actionable error instead of a silent
# partial import (issue non-goal: never silently accept incompatible
# versions).
SUPPORTED_MANIFEST_SCHEMA = "scentinel.run.v1"
SUPPORTED_SENSOR_CSV_COLUMNS = ("timestamp", "sensor_id", "gas", "ppm")

# Quality gates Scentinel itself distinguishes; JWIS records them but does
# not re-derive them.
GATES = ("pipeline_success", "numerical_convergence", "mesh_independence", "mass_balance", "experimental_validation")


class ScentinelImportError(ValueError):
    """Incompatible or malformed Scentinel evidence package."""


class ScentinelManifest(BaseModel):
    manifest_schema: str = Field(..., alias="schema")
    run_id: str = Field(min_length=1)
    source_repository: str = Field(min_length=1)
    source_version: str = Field(min_length=1)
    scenario: str = Field(min_length=1)
    gas_set: list[str] = Field(min_length=1)
    candidate_sensors: list[dict[str, Any]] = Field(min_length=1)
    execution: dict[str, Any]
    input_digest: str = Field(min_length=1)

    def gates(self) -> dict[str, bool]:
        out = {g: False for g in GATES}
        for key in ("pipeline_success", "numerical_convergence", "mesh_independence", "mass_balance", "experimental_validation"):
            if key in self.execution:
                out[key] = bool(self.execution[key])
        return out


@dataclass
class ScentinelEvidence:
    run_id: str
    truck_code: str | None
    scenario: str
    gas_set: list[str]
    candidate_sensors: list[dict[str, Any]]
    gates: dict[str, bool]
    source_repository: str
    source_version: str
    input_digest: str
    sensor_csv_rows: int = 0
    evidence_class: str = "external_simulation"
    created_at: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


def parse_sensor_csv(text: str) -> list[dict[str, str]]:
    """Parse the exported sensor CSV; header must carry the pinned columns."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        raise ScentinelImportError("Sensor CSV is empty.")
    header = [c.strip() for c in lines[0].split(",")]
    missing = [c for c in SUPPORTED_SENSOR_CSV_COLUMNS if c not in header]
    if missing:
        raise ScentinelImportError(
            f"Sensor CSV is missing required column(s): {', '.join(missing)}. "
            f"Expected columns: {', '.join(SUPPORTED_SENSOR_CSV_COLUMNS)}."
        )
    rows = []
    for ln in lines[1:]:
        values = [v.strip() for v in ln.split(",")]
        if len(values) != len(header):
            raise ScentinelImportError(
                f"Sensor CSV row has {len(values)} values but the header declares {len(header)}."
            )
        rows.append(dict(zip(header, values)))
    return rows


def digest_payload(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()[:16]


def import_scentinel_evidence(manifest: dict[str, Any], sensor_csv: str, truck_code: str | None = None) -> ScentinelEvidence:
    """Validate and normalize one Scentinel evidence package.

    Raises ScentinelImportError with an actionable message on incompatible
    schemas, failed runs, or malformed payloads.
    """
    schema = manifest.get("schema")
    if schema != SUPPORTED_MANIFEST_SCHEMA:
        raise ScentinelImportError(
            f"Unsupported Scentinel manifest schema {schema!r}. "
            f"This JWIS release pins {SUPPORTED_MANIFEST_SCHEMA} — export the run "
            "with a compatible scentinel release."
        )
    try:
        parsed = ScentinelManifest(**manifest)
    except Exception as exc:  # pydantic validation → actionable error
        raise ScentinelImportError(f"Scentinel manifest is incomplete: {exc}") from exc

    rows = parse_sensor_csv(sensor_csv)
    gates = parsed.gates()
    if not gates.get("pipeline_success"):
        raise ScentinelImportError(
            f"Scentinel run {parsed.run_id} reports pipeline_success=false — "
            "a failed run cannot be imported as evidence."
        )

    return ScentinelEvidence(
        run_id=parsed.run_id,
        truck_code=truck_code,
        scenario=parsed.scenario,
        gas_set=parsed.gas_set,
        candidate_sensors=parsed.candidate_sensors,
        gates=gates,
        source_repository=parsed.source_repository,
        source_version=parsed.source_version,
        input_digest=parsed.input_digest,
        sensor_csv_rows=len(rows),
        created_at=parsed.execution.get("finished_at", ""),
        extra={"execution": parsed.execution},
    )


def evidence_to_payload(ev: ScentinelEvidence) -> dict[str, Any]:
    """Serializable representation returned by the API (audit trail)."""
    return {
        "run_id": ev.run_id,
        "evidence_class": ev.evidence_class,
        "truck_code": ev.truck_code,
        "scenario": ev.scenario,
        "gas_set": ev.gas_set,
        "candidate_sensors": ev.candidate_sensors,
        "quality_gates": ev.gates,
        "source_repository": ev.source_repository,
        "source_version": ev.source_version,
        "input_digest": ev.input_digest,
        "sensor_csv_rows": ev.sensor_csv_rows,
        "created_at": ev.created_at,
    }
