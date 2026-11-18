"""``three-bill login``: a headed, human-driven sign-in on the dedicated profile.

The waiting, polling and narration are skill_browser's. What is Three-specific
is the acceptance check: the page must be on the www host, off any sign-in
route, *and* the My3 API must say ``isAnonymous: false``. Hops through
``auth.three.co.uk`` (Auth0) count as progress, not failure.
"""

from __future__ import annotations

import asyncio
from typing import Any

from skill_browser.login import host_of, human_login, say

from three_bill.my3 import TOOL_NAME, My3, auth_barrier, goto, is_account_url

# After Auth0, the SPA goes /customer-logged -> /account on its own and takes a
# few seconds to write its customer state to sessionStorage. Navigating to
# /account before then bounces to /customer-login (seen live, 2026-11-17).
POST_LOGIN_SETTLE_SECONDS = 30.0
_STATE_READY_JS = (
    "() => !!sessionStorage.getItem('persist:customerProfilePersistor')"
    " && !!sessionStorage.getItem('persist:user')"
)


async def is_signed_in(my3: My3) -> bool:
    if auth_barrier(my3.page.url, my3.site):
        return False
    await my3.check_authenticated(attempts=1)
    return True


async def wait_for_spa_state(
    my3: My3, timeout: float = POST_LOGIN_SETTLE_SECONDS
) -> bool:
    """Until the SPA is on /account with its customer state written. False on timeout."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        try:
            if is_account_url(my3.page.url, my3.site) and await my3.page.evaluate(
                _STATE_READY_JS
            ):
                return True
        except Exception:
            pass  # mid-navigation
        await asyncio.sleep(0.5)
    return False


async def interactive_login(
    browser: Any, my3: My3, *, timeout_seconds: float
) -> dict[str, Any]:
    already = await human_login(
        browser,
        tool=TOOL_NAME,
        start_url=my3.site.login_url,
        check=lambda: is_signed_in(my3),
        timeout_seconds=timeout_seconds,
        goto=lambda page, url: goto(page, url, my3.site),
        # On Auth0, the sign-in form is up: no point waiting out the settle.
        on_sign_in_form=lambda url: host_of(url) not in ("", my3.site.host),
    )
    if not already:
        say("   Signed in; waiting for My3 to finish loading your account.")
        if not await wait_for_spa_state(my3):
            say("   My3 did not reach /account on its own; checking it directly.")
    # Prove the state normal runs depend on: /account loads and the cuid can be
    # read. A login that only reached /customer-logged fails here.
    account = await my3.open_account()
    return {
        "signed_in": True,
        "already_signed_in": already,
        "account_ending": account.cuid[-3:],
    }
