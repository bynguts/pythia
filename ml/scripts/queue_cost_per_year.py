"""Print and write apps/api/data/models/queue_cost_per_year.json (yearly cost of the gate queue)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.fleet.value_model import queue_cost_per_year, value_model_from_simulation  # noqa: E402

OUT = ROOT / "apps" / "api" / "data" / "models" / "queue_cost_per_year.json"


def main() -> None:
    model = value_model_from_simulation()
    if model is None:
        raise SystemExit("no arrival data: queue simulation unavailable")
    result = queue_cost_per_year(model)
    OUT.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
