"""`.env` must be loaded before any module that reads PYTHIA_* settings at import.

app.core.paths resolves PYTHIA_DATA_DIR when it is imported; if it were imported
before load_dotenv(), a value set in .env would be silently ignored.
"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[2]

PROBE = """
import json, sys
import dotenv

class Stop(Exception):
    pass

def probe(*args, **kwargs):
    # app.main itself is mid-import here; report everything else it pulled in.
    loaded = (m for m in sys.modules if (m == "app" or m.startswith("app.")) and m != "app.main")
    print(json.dumps(sorted(loaded)))
    raise Stop

dotenv.load_dotenv = probe
try:
    import app.main  # noqa: F401
except Stop:
    pass
"""


class SettingsLoadOrderTests(unittest.TestCase):
    def test_dotenv_loads_before_settings_are_read(self):
        result = subprocess.run(
            [sys.executable, "-c", PROBE],
            cwd=API_DIR,
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        loaded = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(loaded, ["app", "app.core", "app.core.env"])


if __name__ == "__main__":
    unittest.main()
