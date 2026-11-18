"""A headed, human-driven sign-in on a dedicated profile.

Nothing here types or stores a credential. The person signs in in the window;
this waits, and the persistent context writes the session to the profile.

Acceptance is strict, after ramp-mcp-server's ``wait_for_manual_login``: the
site's own ``is_signed_in`` check must pass on ``REQUIRED_STABLE_POLLS``
consecutive polls, so a page that flashes a dashboard mid-redirect does not
count. Hops through an identity provider count as progress, not failure.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
import logging
import sys
from typing import Any
from urllib.parse import urlsplit

from skill_browser.errors import LoginTimeoutError, NotLoggedInError, SkillError

logger = logging.getLogger(__name__)

REQUIRED_STABLE_POLLS = 3

SignedInCheck = Callable[[], Awaitable[bool]]


def say(message: str) -> None:
    """Progress for the human, on stderr so stdout stays one JSON document."""
    print(message, file=sys.stderr, flush=True)


def host_of(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


async def poll_signed_in(check: SignedInCheck) -> bool:
    """One poll. Any failure (mid-navigation, off-site) is False, except a closed window."""
    try:
        return bool(await check())
    except SkillError as exc:
        if exc.code == "browser_closed":
            raise
        return False
    except Exception:
        return False


async def wait_for_manual_login(
    page: Any,
    check: SignedInCheck,
    *,
    tool: str,
    timeout_seconds: float,
    poll_seconds: float = 1.0,
) -> None:
    """Block until *check* passes on consecutive polls, or time out.

    ``timeout_seconds`` of 0 waits forever. Only hosts are printed, never URLs:
    identity-provider URLs carry codes and state.
    """
    loop = asyncio.get_running_loop()
    started = loop.time()
    stable = 0
    last_host: str | None = None
    while True:
        if await poll_signed_in(check):
            stable += 1
            if stable >= REQUIRED_STABLE_POLLS:
                return
        else:
            stable = 0
        try:
            host = host_of(page.url)
        except Exception:
            host = ""
        if host and host != last_host:
            say(f"   Sign-in in progress at {host}")
            last_host = host
        if timeout_seconds and loop.time() - started > timeout_seconds:
            raise LoginTimeoutError(
                f"Sign-in was not completed within {timeout_seconds / 60:.0f} minutes. "
                f"Run `{tool} login` again (use --timeout 0 for no limit)."
            )
        await asyncio.sleep(poll_seconds)


def log_window(page: Any) -> None:
    """Narrate the sign-in window's main-frame hops, by host only."""

    def hop(frame: Any) -> None:
        if frame == page.main_frame:
            say(f"   Sign-in window at {host_of(frame.url) or 'about:blank'}")

    page.on("framenavigated", hop)
    page.on("close", lambda _: say("   Sign-in window closed"))


async def human_login(
    browser: Any,
    *,
    tool: str,
    start_url: str,
    check: SignedInCheck,
    timeout_seconds: float,
    goto: Callable[[Any, str], Awaitable[None]],
    on_sign_in_form: Callable[[str], bool] | None = None,
    settle_seconds: float = 15.0,
) -> bool:
    """Open *start_url* headed and wait for the human. Returns ``already_signed_in``.

    *on_sign_in_form* (given the page URL) ends the settle wait early once the
    redirect chain has clearly landed on the identity provider's form.
    "Already signed in" needs the same ``REQUIRED_STABLE_POLLS`` consecutive
    passes as a manual login, so a dashboard flashed mid-redirect does not count.
    """
    page = browser.page
    log_window(page)
    browser.context.on("page", log_window)  # identity-provider popups
    try:
        await goto(page, start_url)
    except NotLoggedInError as exc:
        # A start page that redirects to sign-in while loading is exactly
        # what login expects: the human signs in next.
        if exc.code != "redirected_to_sign_in":
            raise

    # Give the redirect chain a chance to land before the first decision.
    loop = asyncio.get_running_loop()
    deadline = loop.time() + settle_seconds
    stable = 0
    while loop.time() < deadline:
        if await poll_signed_in(check):
            stable += 1
            if stable >= REQUIRED_STABLE_POLLS:
                say("   Already signed in; keeping the existing session.")
                return True
        else:
            stable = 0
        try:
            if on_sign_in_form and on_sign_in_form(page.url):
                break
        except Exception:
            pass
        await asyncio.sleep(0.5)

    say("\n   A browser window has opened. Sign in there.")
    say(f"   {tool} never sees or types your password; it waits.\n")
    await wait_for_manual_login(page, check, tool=tool, timeout_seconds=timeout_seconds)
    return False
