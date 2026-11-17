"""``three-bill login``: a headed, human-driven sign-in on the dedicated profile.

Nothing here types or stores a credential. The person signs in in the window;
this waits, and the persistent context writes the session to the profile.

Acceptance is strict, after ramp-mcp-server's ``wait_for_manual_login``: the
page must be on the www host, off any sign-in route, *and* the My3 API must say
``isAnonymous: false``, on ``REQUIRED_STABLE_POLLS`` consecutive polls. Hops
through ``auth.three.co.uk`` (Auth0) count as progress, not failure.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
import sys
from typing import Any

from three_bill.browser import open_profile
from three_bill.contract import host_of
from three_bill.errors import LoginTimeoutError, ThreeBillError
from three_bill.my3 import My3, Site, auth_barrier, goto

logger = logging.getLogger(__name__)

REQUIRED_STABLE_POLLS = 3


def _say(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


async def is_signed_in(my3: My3) -> bool:
    """One poll. Any failure (mid-navigation, off-site, anonymous) is False."""
    try:
        if auth_barrier(my3.page.url, my3.site):
            return False
        await my3.check_authenticated(attempts=1)
        return True
    except ThreeBillError as exc:
        if exc.code == "browser_closed":
            raise
        return False
    except Exception:
        return False


async def settle(my3: My3, timeout: float = 15.0) -> None:
    """Give the redirect chain a chance to land before the first decision."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if (
            auth_barrier(my3.page.url, my3.site)
            and host_of(my3.page.url) != my3.site.host
        ):
            return  # on Auth0: the sign-in form is up
        if await is_signed_in(my3):
            return
        await asyncio.sleep(0.5)


async def wait_for_manual_login(
    my3: My3, timeout_seconds: float, poll_seconds: float = 1.0
) -> None:
    loop = asyncio.get_running_loop()
    started = loop.time()
    stable = 0
    last_host: str | None = None
    while True:
        if await is_signed_in(my3):
            stable += 1
            if stable >= REQUIRED_STABLE_POLLS:
                return
        else:
            stable = 0
        host = host_of(my3.page.url)
        if host and host != last_host:
            _say(f"   Sign-in in progress at {host}")
            last_host = host
        if timeout_seconds and loop.time() - started > timeout_seconds:
            raise LoginTimeoutError(
                f"Sign-in was not completed within {timeout_seconds / 60:.0f} minutes. "
                "Run `three-bill login` again (use --timeout 0 for no limit)."
            )
        await asyncio.sleep(poll_seconds)


def _log_window(page: Any) -> None:
    """Hosts only, never URLs: Auth0 URLs carry codes and state."""

    def hop(frame: Any) -> None:
        if frame == page.main_frame:
            _say(f"   Sign-in window at {host_of(frame.url) or 'about:blank'}")

    page.on("framenavigated", hop)
    page.on("close", lambda _: _say("   Sign-in window closed"))


async def interactive_login(
    profile_dir: Path,
    *,
    timeout_seconds: float,
    executable_path: str | None = None,
    site: Site | None = None,
) -> dict[str, Any]:
    async with open_profile(
        profile_dir,
        headless=False,  # never headless: a human drives this
        executable_path=executable_path,
        require_existing=False,
    ) as browser:
        my3 = My3(browser, site)
        _log_window(my3.page)
        browser.context.on("page", _log_window)  # Auth0 / SSO popups
        await goto(my3.page, my3.site.login_url, my3.site)
        await settle(my3)

        if await is_signed_in(my3):
            _say("   Already signed in; keeping the existing session.")
            already = True
        else:
            _say("\n   A browser window has opened. Sign in to My3 there.")
            _say("   three-bill never sees or types your password; it waits.\n")
            await wait_for_manual_login(my3, timeout_seconds)
            already = False

        # Prove the state normal runs depend on: /account loads and the cuid
        # can be read. A login that only reached /customer-logged fails here.
        account = await my3.open_account()
        return {
            "signed_in": True,
            "already_signed_in": already,
            "account_ending": account.cuid[-3:],
            "profile": str(Path(profile_dir).expanduser()),
        }
