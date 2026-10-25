"""Official events without coordinates are placed by name; "HI" must be a whole word."""

import pytest

from app.fleet.data import _official_event_coordinates

MONAS = (-6.1754, 106.8272)
BUNDARAN_HI = (-6.1950, 106.8230)
GBK = (-6.2183, 106.8022)


@pytest.mark.parametrize(
    ("name", "location", "expected"),
    [
        ("Car Free Day Bundaran HI", "", BUNDARAN_HI),
        ("Festival", "Jl. Sudirman", BUNDARAN_HI),
        ("Upacara di Monas", "", MONAS),
        # Substrings of other words never move an event to Bundaran HI.
        ("Jakarta Chill Fest", "Senayan", GBK),
        ("Hindu Festival", "", GBK),
        ("Konser", "Stadion GBK", GBK),
    ],
)
def test_official_event_placement(name, location, expected):
    assert _official_event_coordinates(name, location) == expected
