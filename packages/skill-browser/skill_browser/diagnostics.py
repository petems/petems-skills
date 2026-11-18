"""Redacted evidence for when a site changes: a request log and a screenshot.

The log holds method, redacted path, status and redacted headers. Never bodies,
tokens, cookies or query strings.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
import json
import logging
from pathlib import Path
import re
import time
from typing import Any

from skill_browser.errors import SkillError
from skill_browser.nav import path_only

logger = logging.getLogger(__name__)

_SENSITIVE_HEADER = re.compile(r"auth|cookie|token|session|secret|key", re.I)


def redact_headers(headers: dict[str, str] | None) -> dict[str, str]:
    return {
        name: ("<redacted>" if _SENSITIVE_HEADER.search(name) else value)
        for name, value in (headers or {}).items()
    }


def redact_ids(url: str) -> str:
    """Path only, with any run of 6+ digits or 16+ hex chars replaced."""
    path = path_only(url)
    path = re.sub(r"[0-9a-fA-F-]{16,}", "<id>", path)
    return re.sub(r"\d{6,}", "<id>", path)


@dataclass
class NetworkLog:
    """Records responses whose URL *match* accepts, redacted by *redact*."""

    match: Callable[[str], bool]
    redact: Callable[[str], str] = redact_ids
    entries: list[dict[str, Any]] = field(default_factory=list)

    def add(
        self,
        method: str,
        url: str,
        status: int,
        headers: dict[str, str] | None,
        via: str,
    ) -> None:
        try:
            if not self.match(url):
                return
        except Exception:
            return
        self.entries.append(
            {
                "via": via,
                "method": method,
                "path": self.redact(url),
                "status": status,
                "headers": redact_headers(headers),
            }
        )

    def on_response(self, response: Any) -> None:
        try:
            self.add(
                response.request.method,
                response.url,
                response.status,
                response.headers,
                "page",
            )
        except Exception:  # a listener must never raise
            pass

    def attach(self, page: Any) -> None:
        page.on("response", self.on_response)


async def capture(
    page: Any,
    directory: Path,
    *,
    tool: str,
    error: SkillError,
    network: NetworkLog | None,
    redact: Callable[[str], str] = redact_ids,
    screenshot: bool = True,
) -> dict[str, str]:
    """Write ``<tool>-<stamp>.json`` (and ``.png``) under *directory*, mode 0600.

    Pass ``screenshot=False`` when the page shows personal data (a name and
    address on a receipt) that should not be left on disk.
    """
    stamp = time.strftime("%Y%m%d-%H%M%S")
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    out: dict[str, str] = {}
    try:
        page_path: str | None = redact(page.url)
    except Exception:
        page_path = None
    log_path = directory / f"{tool}-{stamp}.json"
    log_path.write_text(
        json.dumps(
            {
                "error": error.code,
                "page": page_path,
                "requests": network.entries if network else [],
            },
            indent=2,
        )
    )
    log_path.chmod(0o600)
    out["network_log"] = str(log_path)
    if screenshot:
        try:
            shot = directory / f"{tool}-{stamp}.png"
            await page.screenshot(path=str(shot))
            shot.chmod(0o600)
            out["screenshot"] = str(shot)
        except Exception:
            logger.debug("Screenshot failed", exc_info=True)
    return out
