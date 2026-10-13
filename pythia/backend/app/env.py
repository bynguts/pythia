"""Environment settings that survive the JWIS -> Pythia rebrand.

Every setting is read as ``PYTHIA_<NAME>``. A deployment whose .env or
compose file still exports the pre-rebrand ``JWIS_<NAME>`` keeps working:
the legacy name is used only when the new one is absent.
"""
from __future__ import annotations

import os
from pathlib import Path

PREFIX = "PYTHIA_"
LEGACY_PREFIX = "JWIS_"
# <repo>/pythia/backend/app/env.py in a checkout. The docker image is shallower
# (/app/app/env.py), where there is no checkout and no jwis/ to look in.
_PARENTS = Path(__file__).resolve().parents
REPO_ROOT = _PARENTS[3] if len(_PARENTS) > 3 else None


def getenv(name: str, default: str | None = None) -> str | None:
    """Return PYTHIA_<name>, else legacy JWIS_<name>, else ``default``."""
    value = os.environ.get(PREFIX + name)
    if value is None:
        value = os.environ.get(LEGACY_PREFIX + name)
    return default if value is None else value


def legacy_dotenv_files(repo_root: Path | None = REPO_ROOT) -> list[Path]:
    """.env files left in jwis/ by the jwis/ -> pythia/ folder rename.

    Same precedence the old upward search had: backend/.env before jwis/.env.
    """
    if repo_root is None:
        return []
    candidates = (repo_root / "jwis" / "backend" / ".env", repo_root / "jwis" / ".env")
    return [path for path in candidates if path.is_file()]
