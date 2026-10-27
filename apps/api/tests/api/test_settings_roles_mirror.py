"""Settings: the read-only "Tim & akses" list must describe the roles the server enforces."""

import re
from pathlib import Path

from app.core.auth import ROLES

REPO = Path(__file__).resolve().parents[4]
ROLES_JS = REPO / "apps" / "web" / "src" / "features" / "settings" / "roles.js"


def _roles_in_settings_page() -> dict[str, set[str]]:
    text = ROLES_JS.read_text(encoding="utf-8")
    body = text[text.index("ROLE_PERMISSIONS = {") :]
    return {
        role: set(re.findall(r'"([a-z]+:[a-z]+)"', permissions))
        for role, permissions in re.findall(r"(\w+): \[(.*?)\]", body, flags=re.S)
    }


def test_settings_role_map_mirrors_the_server_roles():
    assert _roles_in_settings_page() == ROLES
