"""Each simulated truck has its own simulated driver (D1); Safety counts Fleet's trucks (F4)."""

import re

from app.field.safety import simulated_fleet_codes
from app.fleet.data import get_dynamic_trucks
from app.fleet.fleet_generator import driver_for


def test_no_simulated_driver_is_on_two_trucks():
    names = [truck["driver_name"] for truck in get_dynamic_trucks()]
    assert len(names) == len(set(names)), "a simulated driver is assigned to more than one truck"


def test_driver_names_are_placeholders():
    for truck in get_dynamic_trucks():
        assert re.fullmatch(r"Pengemudi Sim \d{2}", truck["driver_name"]), truck["driver_name"]


def test_generated_drivers_continue_after_the_curated_ones():
    assert driver_for(0) == "Pengemudi Sim 05"
    assert driver_for(54) == "Pengemudi Sim 59"


def test_safety_roster_is_the_fleet_roster():
    assert simulated_fleet_codes() == [truck["truck_code"] for truck in get_dynamic_trucks()]
