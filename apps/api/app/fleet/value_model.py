"""Value per 1,000 truck arrivals at the Bantargebang gate: without vs with the stagger.

The gain is capacity and safety, not cash (drivers are paid monthly), so every output
is in truck-hours, driver hours, litres and trips, never rupiah. The waits and the
trips over the gate alert come from the seeded gate-queue simulation behind
``GET /api/tpa/queue-metric``; every other parameter is a labelled assumption. Low uses
each parameter at the end least favourable to Pythia, high the most favourable.
SIMULATED x ASSUMPTION: not a field measurement; the pilot measures real dwell from the
driver's gate tap.
"""

from __future__ import annotations

import random
from functools import lru_cache
from typing import Any

from app.core.units import GATE_ALERT_MIN
from app.fleet.queue_simulation import (
    WEIGHBRIDGE_LANES,
    _baseline_offsets,
    _departure_z,
    _gate_arrivals,
    _round_draws,
    _service_draws,
    _trace,
    scenario_queue_metric,
)

VALUE_MODEL_TRUCKS = 1000
CLASSIFICATION = "SIMULATED × ASSUMPTION"
_SIM_SOURCES = ("GET /api/tpa/queue-metric", "apps/api/app/fleet/queue_simulation.py")


def _param(
    key: str,
    label: str,
    label_id: str,
    unit: str,
    low: float,
    base: float,
    high: float,
    *,
    sources: tuple[str, ...] = (),
    assumption: bool = False,
    rationale: str,
    rationale_id: str,
) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "label_id": label_id,
        "unit": unit,
        "low": low,
        "base": base,
        "high": high,
        "sources": list(sources),
        "assumption": assumption,
        "rationale": rationale,
        "rationale_id": rationale_id,
    }


def _parameters(metric: dict[str, Any]) -> list[dict[str, Any]]:
    trips = metric["trucks_per_day"]
    rows = metric["sensitivity"]["rows"]
    band_lo, band_hi = metric["sensitivity"]["baseline_band"]
    spreads = "/".join(f"{row['departure_sd_minutes']:g}" for row in rows)
    # Low is the spread with the shortest baseline wait (least to gain), high the longest.
    low_sd, high_sd = _band_ends(rows)
    sd = metric["baseline_departure_sd_minutes"]
    ci_lo, ci_hi = metric["staggered_ci95"]
    slot = metric["recommended_stagger_minutes"]
    reps = metric["replications"]
    alert = metric["over_alert"]
    return [
        _param(
            "wait_without_min",
            "Gate wait per truck, current practice (no stagger)",
            "Waktu tunggu gerbang per truk, praktik saat ini (tanpa stagger)",
            "min",
            band_lo,
            metric["baseline_mean"],
            band_hi,
            sources=_SIM_SOURCES,
            rationale=(
                f"Mean weighbridge-stage wait in the seeded gate-queue simulation of {trips:,} "
                f"truck arrivals a day. Base: trucks leave around shift start with a {sd:g}-min "
                f"spread. Low and high: the same day re-run at {spreads}-min spreads "
                f"({band_lo:g}-{band_hi:g} min). Low is the {low_sd:g}-min spread, whose queue is "
                f"shortest and leaves least to gain; high the {high_sd:g}-min spread. Simulated, "
                "not a field measurement."
            ),
            rationale_id=(
                f"Rata-rata waktu tunggu di tahap jembatan timbang pada simulasi antrean gerbang "
                f"({trips:,} kedatangan truk per hari). Dasar: truk berangkat sekitar awal shift "
                f"dengan sebaran {sd:g} menit. Rendah dan tinggi: hari yang sama dijalankan ulang "
                f"dengan sebaran {spreads} menit ({band_lo:g}-{band_hi:g} menit). Rendah adalah "
                f"sebaran {low_sd:g} menit, antreannya terpendek sehingga paling sedikit yang bisa "
                f"dihemat; tinggi sebaran {high_sd:g} menit. Simulasi, bukan pengukuran lapangan."
            ),
        ),
        _param(
            "wait_with_min",
            f"Gate wait per truck with the {slot}-min stagger",
            f"Waktu tunggu gerbang per truk dengan stagger {slot} menit",
            "min",
            ci_hi,
            metric["staggered_mean"],
            ci_lo,
            sources=_SIM_SOURCES,
            rationale=(
                f"Mean wait on the same simulated day with departures spread over {slot}-min "
                f"slots, every truck keeping its slot. Low and high: the 95% interval across "
                f"{reps} seeded replications ({ci_lo:g}-{ci_hi:g} min), which covers simulation "
                "noise only, not model error. Low is the slower end. Simulated, not a field "
                "measurement."
            ),
            rationale_id=(
                f"Rata-rata waktu tunggu pada hari simulasi yang sama dengan keberangkatan dibagi "
                f"ke slot {slot} menit, semua truk menepati slotnya. Rendah dan tinggi: interval 95% "
                f"dari {reps} replikasi bersemai ({ci_lo:g}-{ci_hi:g} menit), hanya mencakup variasi "
                "acak simulasi, bukan kesalahan model. Rendah adalah ujung yang lebih lambat. "
                "Simulasi, bukan pengukuran lapangan."
            ),
        ),
        _param(
            "over_alert_without_per_1000",
            f"Trips waiting over the {GATE_ALERT_MIN}-min gate alert, current practice",
            f"Ritase yang menunggu lebih dari {GATE_ALERT_MIN} menit di gerbang, praktik saat ini",
            "trips",
            alert["without"]["low"],
            alert["without"]["base"],
            alert["without"]["high"],
            sources=_SIM_SOURCES,
            rationale=(
                f"Trips per 1,000 whose simulated weighbridge wait passes {GATE_ALERT_MIN} min, "
                f"counted over the same {reps} replications and spreads as the wait. The longest "
                f"simulated wait is {alert['longest_without']:g} min. The alert times the whole "
                "gate dwell, unloading included, which the simulation does not model, so a zero "
                "here is not a claim that real trips never pass the alert."
            ),
            rationale_id=(
                f"Ritase per 1.000 yang waktu tunggu jembatan timbangnya dalam simulasi melewati "
                f"{GATE_ALERT_MIN} menit, dihitung pada {reps} replikasi dan sebaran yang sama. "
                f"Tunggu terlama dalam simulasi {alert['longest_without']:g} menit. Alarm mengukur "
                "seluruh waktu di gerbang termasuk bongkar, yang tidak disimulasikan, jadi nol di "
                "sini bukan klaim bahwa ritase nyata tidak pernah melewati alarm."
            ),
        ),
        _param(
            "over_alert_with_per_1000",
            f"Trips waiting over the {GATE_ALERT_MIN}-min gate alert with the stagger",
            f"Ritase yang menunggu lebih dari {GATE_ALERT_MIN} menit di gerbang dengan stagger",
            "trips",
            alert["with"],
            alert["with"],
            alert["with"],
            sources=_SIM_SOURCES,
            rationale=(
                f"The same count on the staggered day; the longest simulated wait is "
                f"{alert['longest_with']:g} min. Held at the simulated value in every scenario."
            ),
            rationale_id=(
                f"Hitungan yang sama pada hari dengan stagger; tunggu terlama dalam simulasi "
                f"{alert['longest_with']:g} menit. Tetap pada nilai simulasi di setiap skenario."
            ),
        ),
        _param(
            "slot_adherence",
            "Share of trips that leave in their assigned slot",
            "Porsi ritase yang berangkat sesuai slotnya",
            "share",
            0.5,
            0.8,
            1.0,
            assumption=True,
            rationale=(
                "Assumption with no source in this repository: no pilot has measured how many "
                "drivers keep their slot. The simulation assumes all of them do (high). Low and "
                "base blend the two simulated days linearly by this share; a real queue is not "
                "linear and late trucks also delay punctual ones, so low may still flatter "
                "Pythia. The pilot measures adherence from gate taps against assigned slots."
            ),
            rationale_id=(
                "Asumsi tanpa sumber di repositori ini: belum ada pilot yang mengukur berapa "
                "pengemudi yang menepati slotnya. Simulasi menganggap semuanya menepati (tinggi). "
                "Rendah dan dasar mencampur kedua hari simulasi secara linear menurut porsi ini; "
                "antrean nyata tidak linear dan truk yang terlambat juga menunda truk yang tepat "
                "waktu, jadi nilai rendah masih bisa terlalu baik bagi Pythia. Pilot mengukur "
                "kepatuhan dari ketukan gerbang terhadap slot yang ditetapkan."
            ),
        ),
        _param(
            "drivers_per_truck",
            "Drivers waiting in each truck",
            "Pengemudi yang menunggu di tiap truk",
            "people",
            1.0,
            1.0,
            1.0,
            assumption=True,
            rationale=(
                "One driver stays with each truck in the queue, on duty. Crew who ride along are "
                "not counted, so driver hours are a floor on the person-hours spent waiting. Held "
                "fixed."
            ),
            rationale_id=(
                "Satu pengemudi tetap di tiap truk selama antre, dalam jam dinas. Kru yang ikut tidak "
                "dihitung, jadi jam pengemudi adalah batas bawah jam-orang yang habis untuk "
                "menunggu. Tetap."
            ),
        ),
        _param(
            "idle_fuel_l_per_h",
            "Diesel burned by a compactor truck idling in the queue",
            "Solar yang terbakar truk compactor saat idle di antrean",
            "L/h",
            1.5,
            2.5,
            4.0,
            assumption=True,
            rationale=(
                "Assumption with no source in this repository: there is no fuel log or idle "
                "measurement for DLH compactor trucks. A planning range for an idling heavy "
                "diesel truck; low also allows for drivers who switch the engine off while "
                "they wait. The pilot can replace it with fuel records."
            ),
            rationale_id=(
                "Asumsi tanpa sumber di repositori ini: tidak ada log bahan bakar atau pengukuran "
                "idle untuk truk compactor DLH. Rentang perencanaan untuk truk diesel berat yang "
                "idle; nilai rendah juga memperhitungkan pengemudi yang mematikan mesin saat "
                "menunggu. Pilot dapat menggantinya dengan catatan bahan bakar."
            ),
        ),
    ]


def _band_ends(rows: list[dict[str, Any]]) -> tuple[float, float]:
    """(departure SD with the shortest baseline wait, SD with the longest)."""
    by_wait = sorted(rows, key=lambda row: row["baseline_mean"])
    return by_wait[0]["departure_sd_minutes"], by_wait[-1]["departure_sd_minutes"]


def scenario_value(p: dict[str, float], trucks: int = VALUE_MODEL_TRUCKS) -> dict[str, Any]:
    """Without vs with the stagger for ``trucks`` gate arrivals under parameters ``p``. Pure.

    The with-arm blends the two simulated days by slot adherence: trips that keep
    their slot wait as staggered, the rest as today.
    """
    share = p["slot_adherence"]

    def blend(staggered: float, current: float) -> float:
        return share * staggered + (1 - share) * current

    def arm(wait_min: float, over_alert_per_1000: float) -> dict[str, float]:
        truck_hours = trucks * wait_min / 60.0
        return {
            "wait_minutes_per_truck": round(wait_min, 1),
            "queue_truck_hours": round(truck_hours, 1),
            "driver_hours_waiting": round(truck_hours * p["drivers_per_truck"], 1),
            "idle_fuel_litres": round(truck_hours * p["idle_fuel_l_per_h"]),
            "trips_over_alert": round(over_alert_per_1000 * trucks / VALUE_MODEL_TRUCKS, 1),
        }

    wait_with = blend(p["wait_with_min"], p["wait_without_min"])
    over_with = blend(p["over_alert_with_per_1000"], p["over_alert_without_per_1000"])
    without = arm(p["wait_without_min"], p["over_alert_without_per_1000"])
    with_ = arm(wait_with, over_with)
    returned = trucks * (p["wait_without_min"] - wait_with) / 60.0
    return {
        "without": without,
        "with": with_,
        "queue_truck_hours_returned": round(returned, 1),
        "driver_hours_returned": round(returned * p["drivers_per_truck"], 1),
        "idle_fuel_litres_avoided": round(returned * p["idle_fuel_l_per_h"]),
        "trips_over_alert_avoided": round(without["trips_over_alert"] - with_["trips_over_alert"], 1),
    }


def value_model(metric: dict[str, Any]) -> dict[str, Any]:
    """Value per :data:`VALUE_MODEL_TRUCKS` gate arrivals: low / base / high. Pure.

    ``metric`` is the queue metric plus ``over_alert`` (see :func:`_over_alert_tally`).
    """
    params = _parameters(metric)
    scenarios = {
        level: scenario_value({row["key"]: row[level] for row in params}) for level in ("low", "base", "high")
    }
    return {
        "trucks": VALUE_MODEL_TRUCKS,
        "unit": "TPA gate trips (ritasi); one truck can make several trips a day",
        "classification": CLASSIFICATION,
        "scenarios": scenarios,
        "parameters": params,
        "p95_wait_minutes": {"without": metric["baseline_p95"], "with": metric["staggered_p95"]},
        "gate_alert_minutes": GATE_ALERT_MIN,
        "trucks_per_day": metric["trucks_per_day"],
        "days_per_1000_trucks": round(VALUE_MODEL_TRUCKS / metric["trucks_per_day"], 2),
        "simulation_source": metric["source"],
        "omitted": [
            {
                "key": "extra_trips",
                "output": "extra trips the returned truck-hours allow",
                "reason": "no observed trip cycle time in the repository to convert hours into trips",
            },
        ],
        "note": (
            "SIMULATED x ASSUMPTION, not a field measurement: the pilot measures real gate dwell "
            "from the driver's gate tap. Gate (weighbridge) stage only. Low uses every parameter "
            "at the end least favourable to Pythia, high the most favourable. Capacity and safety, "
            "not cash: drivers are paid monthly."
        ),
        "note_id": (
            "SIMULASI x ASUMSI, bukan pengukuran lapangan: pilot mengukur waktu tunggu gerbang yang "
            "sebenarnya dari ketukan pengemudi saat tiba di gerbang. Hanya tahap gerbang (jembatan "
            "timbang). Rendah memakai tiap parameter di ujung yang paling tidak menguntungkan "
            "Pythia, tinggi yang paling menguntungkan. Kapasitas dan keselamatan, bukan uang: "
            "pengemudi digaji bulanan."
        ),
    }


@lru_cache(maxsize=4)
def _over_alert_tally(
    trucks_per_day: int, seed: int, replications: int, sds: tuple[float, ...]
) -> tuple[dict[float | None, float], dict[float | None, float]]:
    """Per arm (None = staggered, else the baseline departure SD): (trips per 1,000 over the
    gate alert, longest wait in minutes).

    The queue metric keeps only each day's mean and p95 wait, so this replays its seeded
    day (same seed, replications and common random numbers) and counts the waits over
    :data:`GATE_ALERT_MIN`.
    """
    arms: tuple[float | None, ...] = (None, *sds)
    over = dict.fromkeys(arms, 0)
    longest = dict.fromkeys(arms, 0.0)
    for i in range(replications):
        z = _departure_z(trucks_per_day, seed, i)
        rng = random.Random(seed * 100000 + i)  # the metric's per-replication stream
        rounds = _round_draws(trucks_per_day, rng)
        services = _service_draws(trucks_per_day, rng)
        for arm in arms:
            offsets = None if arm is None else _baseline_offsets(z, arm)
            arrivals = _gate_arrivals(trucks_per_day, rounds, offsets)
            waits, _queued = _trace(arrivals, WEIGHBRIDGE_LANES, services)
            over[arm] += sum(wait > GATE_ALERT_MIN for wait in waits)
            longest[arm] = max(longest[arm], max(waits, default=0.0))
    per_1000 = {arm: round(count / replications / trucks_per_day * 1000, 1) for arm, count in over.items()}
    return per_1000, {arm: round(wait, 1) for arm, wait in longest.items()}


def value_model_from_simulation() -> dict[str, Any] | None:
    """:func:`value_model` over the normal-day queue metric; None without arrival data."""
    metric = scenario_queue_metric()
    if metric is None:
        return None
    rows = metric["sensitivity"]["rows"]
    sds = tuple(row["departure_sd_minutes"] for row in rows)
    per_1000, longest = _over_alert_tally(
        metric["trucks_per_day"], metric["seed"], metric["replications"], sds
    )
    low_sd, high_sd = _band_ends(rows)
    over_alert = {
        "without": {
            "low": per_1000[low_sd],
            "base": per_1000[metric["baseline_departure_sd_minutes"]],
            "high": per_1000[high_sd],
        },
        "with": per_1000[None],
        "longest_without": max(longest[sd] for sd in sds),
        "longest_with": longest[None],
    }
    return value_model({**metric, "over_alert": over_alert})
