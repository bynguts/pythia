"""City registry for the Pythia twin.

Jakarta is the production city: its district forecasts come from the trained
Prophet + XGBoost models over the real SILIKA DLH 2023 baseline. Ho Chi Minh
City is a *demo* city that shows how Pythia expands across Southeast Asia: no
model is trained there, so its volumes come from a transparent allocation of
the published citywide total and are labelled SIMULATED DEMO CITY everywhere.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from app.core.units import EVENT_WASTE_KG_PER_PERSON


@dataclass(frozen=True)
class City:
    id: str
    name: str
    country: str
    center: tuple[float, float]  # (lng, lat)
    zoom: float
    data_class: str
    note: str


CITIES: dict[str, City] = {
    "jakarta": City(
        id="jakarta",
        name="Jakarta",
        country="Indonesia",
        center=(106.8456, -6.2088),
        zoom=10.4,
        data_class="MODEL_OUTPUT",
        note=(
            "Per-kecamatan Prophet + XGBoost forecast over the real SILIKA DLH 2023 "
            "baseline; fleet telemetry is simulated for the pilot."
        ),
    ),
    "hcmc": City(
        id="hcmc",
        name="Ho Chi Minh City",
        country="Vietnam",
        center=(106.6600, 10.7900),
        zoom=10.2,
        data_class="SIMULATED_DEMO_CITY",
        note=(
            "Demo city for SEA expansion: the published citywide total is allocated "
            "to former districts by 2019 census population. No model is trained here."
        ),
    ),
}

# Ho Chi Minh City former districts (boundaries before the July 2025 reform).
# Population: 2019 Population and Housing Census; the 22 figures sum to the
# published citywide 8,993,082. Thu Duc City = former Districts 2, 9 and Thu Duc.
# Coordinates are approximate district centroids, for visualisation only.
HCMC_DISTRICTS: tuple[tuple[str, str, float, float, int], ...] = (
    ("district_1", "District 1", 10.7769, 106.7009, 142_625),
    ("district_3", "District 3", 10.7843, 106.6844, 190_375),
    ("district_4", "District 4", 10.7578, 106.7013, 175_329),
    ("district_5", "District 5", 10.7540, 106.6634, 159_073),
    ("district_6", "District 6", 10.7480, 106.6352, 233_561),
    ("district_7", "District 7", 10.7340, 106.7215, 360_155),
    ("district_8", "District 8", 10.7240, 106.6286, 424_667),
    ("district_10", "District 10", 10.7746, 106.6679, 234_819),
    ("district_11", "District 11", 10.7629, 106.6503, 209_867),
    ("district_12", "District 12", 10.8672, 106.6413, 620_146),
    ("binh_thanh", "Binh Thanh", 10.8106, 106.7091, 499_164),
    ("go_vap", "Go Vap", 10.8387, 106.6653, 676_899),
    ("phu_nhuan", "Phu Nhuan", 10.7991, 106.6802, 163_961),
    ("tan_binh", "Tan Binh", 10.8015, 106.6527, 474_792),
    ("tan_phu", "Tan Phu", 10.7901, 106.6282, 485_348),
    ("binh_tan", "Binh Tan", 10.7652, 106.6038, 784_173),
    ("thu_duc", "Thu Duc City", 10.8494, 106.7537, 1_169_967),
    ("binh_chanh", "Binh Chanh", 10.6870, 106.5940, 705_508),
    ("hoc_mon", "Hoc Mon", 10.8839, 106.5951, 542_243),
    ("cu_chi", "Cu Chi", 11.0067, 106.5132, 462_047),
    ("nha_be", "Nha Be", 10.6950, 106.7400, 206_837),
    ("can_gio", "Can Gio", 10.4110, 106.9540, 71_526),
)
HCMC_POPULATION_2019 = 8_993_082
# ~13,000 t/day domestic solid waste (2024 public reporting).
HCMC_DAILY_TONS = 13_000.0
HCMC_LANDFILL = {"name": "Da Phuoc Waste Treatment Complex", "lat": 10.6596, "lng": 106.6702}


@dataclass(frozen=True)
class Venue:
    id: str
    name: str
    lat: float
    lng: float


# Event venue presets — the one backend source for the twin, Ana and the XR
# deep links. The first venue per city is the default. Approximate centroids.
VENUES: dict[str, tuple[Venue, ...]] = {
    "jakarta": (
        Venue("gbk", "GBK", -6.2183, 106.8022),
        Venue("jis", "JIS", -6.1246, 106.8584),
        Venue("monas", "Monas", -6.1754, 106.8272),
    ),
    "hcmc": (Venue("d1", "District 1", 10.7769, 106.7009),),
}


def get_venue(city_id: str, key: str | None) -> Venue | None:
    """A city's venue by id or display name (case-insensitive); None if unknown."""
    wanted = str(key or "").strip().lower()
    return next((v for v in VENUES.get(city_id, ()) if wanted in (v.id, v.name.lower())), None)


# Scenario sensitivities for the demo allocation (assumptions, labelled as such).
WEEKEND_UPLIFT = 0.04
RAIN_UPLIFT_PER_MM = 0.0015
RAIN_UPLIFT_CAP = 0.12


def get_city(city_id: str) -> City:
    try:
        return CITIES[city_id]
    except KeyError:
        raise ValueError(f"unknown city {city_id!r}; expected one of {sorted(CITIES)}") from None


def _nearest_district(lat: float, lng: float) -> str:
    def dist(row):
        return math.hypot(row[2] - lat, (row[3] - lng) * math.cos(math.radians(lat)))

    return min(HCMC_DISTRICTS, key=dist)[0]


def hcmc_district_forecasts(
    days: int,
    rainfall_mm: float = 0.0,
    event_attendance: int = 0,
    event_lat: float | None = None,
    event_lng: float | None = None,
    start: date | None = None,
) -> list[dict[str, Any]]:
    """Daily demo volumes per HCMC district.

    tons = citywide total × census population share × (1 + weekend uplift)
           × (1 + capped rain uplift), plus 1.2 kg per event attendee in the
    district nearest the event. Every factor is an explicit assumption.
    """
    start = start or date.today()
    rain_factor = 1.0 + min(RAIN_UPLIFT_CAP, max(0.0, rainfall_mm) * RAIN_UPLIFT_PER_MM)
    event_district = None
    if event_attendance > 0:
        event_district = _nearest_district(
            event_lat if event_lat is not None else 10.7769, event_lng if event_lng is not None else 106.7009
        )
    out = []
    for slug, name, lat, lng, population in HCMC_DISTRICTS:
        base = HCMC_DAILY_TONS * population / HCMC_POPULATION_2019
        series = []
        for offset in range(days):
            day = start + timedelta(days=offset)
            tons = base * rain_factor * (1.0 + (WEEKEND_UPLIFT if day.weekday() >= 5 else 0.0))
            if slug == event_district:
                tons += event_attendance * EVENT_WASTE_KG_PER_PERSON / 1000.0
            series.append({"date": day.isoformat(), "predicted_tons": round(tons, 1)})
        out.append(
            {
                "id": slug,
                "name": name,
                "admin_area": "Ho Chi Minh City",
                "lat": lat,
                "lng": lng,
                "population_2019": population,
                "baseline_tons": round(base, 1),
                "series": series,
                "interval_p10_p90": None,
                "capacity_tons": None,
                "event_localized": slug == event_district,
            }
        )
    return out
