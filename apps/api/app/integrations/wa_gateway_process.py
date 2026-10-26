"""Start and stop the local WhatsApp gateway (apps/wa-gateway) so pairing needs no terminal.

Only a gateway on this machine is started: when OPENWA_BASE_URL points elsewhere
(docker runs wa-gateway as its own service) it is managed externally and the API
never spawns one. The child runs a fixed argv (``node server.js``), never a shell,
and logs to a file in the system temp dir, never the repository.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlparse

from app.core.paths import WA_GATEWAY_DIR
from app.integrations.whatsapp import OpenWAClient

logger = logging.getLogger(__name__)

LOG_FILE = Path(tempfile.gettempdir()) / "pythia_wa_gateway.log"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
NPM_INSTALL_TIMEOUT_S = 600
STOP_TIMEOUT_S = 5

_lock = threading.Lock()
_process: subprocess.Popen | None = None


class GatewayExternal(Exception):
    """The configured gateway is not on this machine (or not configured): nothing to start."""


class GatewayUnavailable(Exception):
    """The gateway could not be started here (no Node.js, install or spawn failed)."""


def is_local(base_url: str) -> bool:
    return (urlparse(base_url).hostname or "") in LOCAL_HOSTS


def gateway_reachable(base_url: str) -> bool:
    """A reachable gateway always reports its socket ``state``; the offline branch has none."""
    return "state" in OpenWAClient(base_url=base_url, session_id="default").health()


def _running() -> bool:
    return _process is not None and _process.poll() is None


def process_state(base_url: str) -> dict:
    """What the settings screen needs to offer (or not offer) a start button."""
    if not is_local(base_url):
        return {"managed": "external", "running": None, "exit_code": None}
    exit_code = _process.poll() if _process is not None else None
    return {"managed": "local", "running": _running(), "exit_code": exit_code}


def start(base_url: str) -> dict:
    """Start ``node server.js`` unless a gateway already answers; idempotent."""
    global _process
    if not base_url:
        raise GatewayExternal("The WhatsApp gateway is not configured (OPENWA_BASE_URL is empty).")
    if not is_local(base_url):
        raise GatewayExternal(
            "The WhatsApp gateway is managed externally (OPENWA_BASE_URL is not this machine); "
            "start it where it runs."
        )
    with _lock:
        if _running():
            return {"started": False, "state": "running"}
        if gateway_reachable(base_url):
            return {"started": False, "state": "already_reachable"}
        node = shutil.which("node")
        if not node:
            raise GatewayUnavailable("Node.js is not installed on the server (node is not on PATH).")
        try:
            with open(LOG_FILE, "a", encoding="utf-8") as log:
                if not (WA_GATEWAY_DIR / "node_modules").is_dir():
                    npm = shutil.which("npm")
                    if not npm:
                        raise GatewayUnavailable("npm is not installed on the server (npm is not on PATH).")
                    subprocess.run(
                        [npm, "install", "--no-audit", "--no-fund"],
                        cwd=WA_GATEWAY_DIR,
                        stdin=subprocess.DEVNULL,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        timeout=NPM_INSTALL_TIMEOUT_S,
                        check=True,
                    )
                _process = subprocess.Popen(
                    [node, "server.js"],
                    cwd=WA_GATEWAY_DIR,
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
        except (OSError, subprocess.SubprocessError) as error:
            logger.warning("WhatsApp gateway could not be started: %s (log: %s)", error, LOG_FILE)
            raise GatewayUnavailable(
                f"The WhatsApp gateway could not be started; see {LOG_FILE} on the server."
            ) from error
        logger.info("WhatsApp gateway started (pid %s, log %s)", _process.pid, LOG_FILE)
        return {"started": True, "state": "starting"}


def stop() -> None:
    """Stop the gateway this process started (API shutdown); a gateway started elsewhere is left alone."""
    global _process
    with _lock:
        process, _process = _process, None
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=STOP_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        process.kill()
