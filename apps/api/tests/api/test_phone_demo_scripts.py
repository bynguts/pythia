"""The phone-demo launchers put /api on a public tunnel: they must never rely on
the published <role>-demo-pass defaults (random per-run passwords for every role,
and a refusal while the API still accepts a default login)."""

import re

import pytest

from app.core.auth import ROLES
from app.core.paths import REPO_ROOT

SCRIPTS = {
    "sh": REPO_ROOT / "scripts" / "phone-demo.sh",
    "ps1": REPO_ROOT / "scripts" / "phone-demo.ps1",
}


def _roles(kind: str, text: str) -> set[str]:
    if kind == "sh":
        match = re.search(r'^roles="([a-z ]+)"$', text, re.M)
        return set(match.group(1).split()) if match else set()
    match = re.search(r"^\$roles = @\(([^)]*)\)$", text, re.M)
    return set(re.findall(r'"([a-z]+)"', match.group(1))) if match else set()


@pytest.mark.parametrize("kind", sorted(SCRIPTS))
def test_phone_demo_generates_a_password_for_every_role(kind):
    text = SCRIPTS[kind].read_text(encoding="utf-8")
    assert _roles(kind, text) == set(ROLES)
    assert "PYTHIA_PW_" in text
    assert ("secrets.token_urlsafe" in text) if kind == "sh" else ("RandomNumberGenerator" in text)


@pytest.mark.parametrize("kind", sorted(SCRIPTS))
def test_phone_demo_refuses_the_tunnel_while_a_default_login_works(kind):
    text = SCRIPTS[kind].read_text(encoding="utf-8")
    assert "/auth/login" in text and "REFUSING TO OPEN THE TUNNEL" in text
    tunnel = text.rindex("cloudflared tunnel --url")  # the command, not the header comment
    assert text.index("REFUSING TO OPEN THE TUNNEL") < tunnel
    assert "PUBLIC" in text[:tunnel]
    # No published credential is printed as the way to sign in.
    for line in text.splitlines():
        if re.search(r"\b(echo|Write-Host)\b", line):
            assert not re.search(r"/ [a-z]+-demo-pass", line), line
