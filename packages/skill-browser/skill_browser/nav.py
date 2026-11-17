"""Navigation that turns Patchright failures into typed errors naming no URL."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import re
from typing import Any
from urllib.parse import urlsplit

from skill_browser.errors import ApiError, NotLoggedInError

NAV_TIMEOUT_MS = 30_000

Barrier = Callable[[str], "str | None"]


def path_only(url: str) -> str:
    """Path, no query or fragment. The safe default for anything logged."""
    return urlsplit(url).path or "/"


async def goto(
    page: Any,
    url: str,
    *,
    tool: str,
    barrier: Barrier,
    redact: Callable[[str], str] = path_only,
    timeout_ms: int = NAV_TIMEOUT_MS,
) -> None:
    """Navigate. *barrier* says why a URL is a sign-in page (or None).

    A sign-in redirect left behind by a failed or timed-out navigation is real
    evidence about the session and outranks the network error.
    """
    from patchright.async_api import Error as PlaywrightError
    from patchright.async_api import TimeoutError as PlaywrightTimeoutError

    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    except PlaywrightError as exc:
        reason = barrier(page.url)
        if reason and not page.url.startswith("about:"):
            raise NotLoggedInError(
                f"Not signed in ({reason}). Run `{tool} login`.",
                code="redirected_to_sign_in",
            ) from exc
        if isinstance(exc, PlaywrightTimeoutError):
            raise ApiError(
                f"Timed out loading {redact(url)}", code="navigation_timeout"
            ) from exc
        net = re.search(r"net::[A-Z_]+", str(exc))
        raise ApiError(
            f"Could not load {redact(url)} "
            f"({net.group(0) if net else type(exc).__name__}). Check the network.",
            code="navigation_failed",
        ) from exc


async def wait_for_stable_text(
    page: Any, timeout: float = 15.0, stable_polls: int = 3
) -> None:
    """Until body text length stops changing. Reads the *length*, never the text."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    last, stable = -1, 0
    while loop.time() < deadline:
        try:
            length = await page.evaluate(
                "() => (document.body && document.body.innerText || '').length"
            )
        except Exception:
            length = 0
        if isinstance(length, int) and length > 0 and length == last:
            stable += 1
            if stable >= stable_polls:
                return
        else:
            stable = 0
        last = length if isinstance(length, int) else -1
        await asyncio.sleep(0.5)


async def wait_off_barrier(
    page: Any, barrier: Barrier, *, timeout: float = 10.0, poll: float = 0.25
) -> str | None:
    """Give an SSO bounce time to come back. Returns the barrier reason if it stays.

    An OIDC app often redirects to its identity provider on load, which
    redirects straight back while its own session cookie is valid. Treating
    the first glimpse of the provider as "signed out" fails a live session.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        try:
            reason = barrier(page.url)
        except Exception:
            reason = None
        if reason is None or loop.time() > deadline:
            return reason
        await asyncio.sleep(poll)
