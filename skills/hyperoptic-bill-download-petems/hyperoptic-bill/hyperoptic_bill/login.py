"""``hyperoptic-bill login``: a headed, human-driven sign-in on the dedicated profile.

The waiting, polling and narration are skill_browser's. What is
Hyperoptic-specific is the acceptance check: the page must be on the account
host, off any sign-in route, and show signed-in page content. Hops through
Keycloak (another host) count as progress, not failure.
"""

from __future__ import annotations

from typing import Any

from skill_browser.login import host_of, human_login

from hyperoptic_bill.site import TOOL_NAME, Hyperoptic


async def interactive_login(
    browser: Any, site: Hyperoptic, *, timeout_seconds: float
) -> dict[str, Any]:
    already = await human_login(
        browser,
        tool=TOOL_NAME,
        start_url=site.site.home_url,
        check=site.is_signed_in,
        timeout_seconds=timeout_seconds,
        goto=lambda _page, url: site.goto(url),
        # Off the account host means the Keycloak form is up.
        on_sign_in_form=lambda url: host_of(url) not in ("", site.site.host),
    )
    # Prove the state normal runs depend on: the bills page loads signed in.
    await site.open_bills()
    return {"signed_in": True, "already_signed_in": already}
