"""Render the satellite plate under the /xr Jakarta tabletop, once, offline.

Run from the repository root:
    python ml/scripts/render_xr_plate.py

Downloads the EOX Sentinel-2 cloudless 2016 tiles (the same free imagery the twin
uses, CC BY 4.0; the later yearly mosaics are CC BY-NC-SA and are not used) for
the box below at zoom 12, stitches and crops them, then darkens and desaturates
the result the way the twin's imagery layer is painted so the risk-coloured
districts keep their contrast. Writes `apps/web/public/xr/jakarta-plate.jpg`.

Credit (shown in the /xr overlay and on the in-scene panel): EOxCloudless 2016 by
EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0.

The box must match `JAKARTA_PLATE` in `apps/web/src/surfaces/xr/buildCityModel.js`.
"""

from __future__ import annotations

import io
import math
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageEnhance

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT = REPO_ROOT / "apps" / "web" / "public" / "xr" / "jakarta-plate.jpg"
TILE_URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg"
WEST, EAST, SOUTH, NORTH = 106.62, 107.06, -6.44, -6.02
ZOOM = 12
OUT_WIDTH = 1536
MAX_BYTES = 400 * 1024


def _pixel(lat: float, lng: float) -> tuple[float, float]:
    n = 256 * 2**ZOOM
    x = (lng + 180) / 360 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def _fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "pythia-xr-plate/1.0"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except OSError:
            if attempt == 4:
                raise
            time.sleep(1 + attempt)
    raise RuntimeError(url)


def main() -> None:
    x0, y0 = _pixel(NORTH, WEST)
    x1, y1 = _pixel(SOUTH, EAST)
    tx0, ty0, tx1, ty1 = int(x0 // 256), int(y0 // 256), int(x1 // 256), int(y1 // 256)
    mosaic = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            tile = Image.open(io.BytesIO(_fetch(TILE_URL.format(z=ZOOM, y=ty, x=tx)))).convert("RGB")
            mosaic.paste(tile, ((tx - tx0) * 256, (ty - ty0) * 256))
    left, top = x0 - tx0 * 256, y0 - ty0 * 256
    crop = mosaic.crop((round(left), round(top), round(left + x1 - x0), round(top + y1 - y0)))
    # Over 0.4 degrees at 6 degrees south, Mercator and plate (equirectangular) rows differ by
    # under 0.1 %, so a plain resize to the plate's aspect is exact enough for a tabletop.
    lat0 = math.radians((NORTH + SOUTH) / 2)
    aspect = ((NORTH - SOUTH) * 110540) / ((EAST - WEST) * math.cos(lat0) * 111320)
    plate = crop.resize((OUT_WIDTH, round(OUT_WIDTH * aspect)), Image.LANCZOS)
    plate = ImageEnhance.Color(plate).enhance(0.65)
    plate = ImageEnhance.Contrast(plate).enhance(1.08)
    plate = ImageEnhance.Brightness(plate).enhance(0.8)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    for quality in (80, 74, 68, 62, 56):
        buffer = io.BytesIO()
        plate.save(buffer, "JPEG", quality=quality, optimize=True, progressive=True)
        if buffer.tell() <= MAX_BYTES:
            break
    OUTPUT.write_bytes(buffer.getvalue())
    print(f"{OUTPUT} {plate.size[0]}x{plate.size[1]} q{quality} {buffer.tell() // 1024} KB")


if __name__ == "__main__":
    main()
