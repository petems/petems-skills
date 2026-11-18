"""``peloton-invoice login``: a headed, human-driven sign-in on the dedicated profile.

The waiting, polling and narration are skill_browser's. What is Peloton-specific
is the acceptance check: the page must be ``account.onepeloton.com/<locale>/
mymembership`` showing "Memberships on file" or "Membership details" (never a
generic word, which the Auth0 footer would match). A detour to the classes app
on ``members.onepeloton.com`` is bounced back to the account site.
"""

from __future__ import annotations

from typing import Any

from skill_browser.login import host_of, human_login

from peloton_invoice import contract
from peloton_invoice.account import PelotonAccount


async def interactive_login(
    browser: Any, account: PelotonAccount, *, timeout_seconds: float
) -> dict[str, Any]:
    already = await human_login(
        browser,
        tool=contract.TOOL_NAME,
        start_url=account.site.entry_url,
        check=account.is_signed_in,
        timeout_seconds=timeout_seconds,
        goto=account.goto,
        # On Auth0, the sign-in form is up: no point waiting out the settle.
        on_sign_in_form=lambda url: host_of(url) == account.site.auth_host,
    )
    # Prove the state normal runs depend on: the membership page loads signed
    # in and the Auth0 cache holds a usable token. The token is not printed.
    locale = await account.open_membership()
    await account.token()
    return {"signed_in": True, "already_signed_in": already, "locale": locale}
