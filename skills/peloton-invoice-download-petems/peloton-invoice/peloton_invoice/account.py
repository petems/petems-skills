"""Driving the Peloton account site: session, token, GraphQL, receipt capture.

The browser is a transport. Every decision about what comes back is made in
Python by :mod:`peloton_invoice.contract`.

What this replaces from the chrome-devtools-mcp flow:

* ``window.__pelotonToken`` → the token held in a Python variable and passed
  to each in-page fetch as an ``evaluate`` argument, never returned to stdout;
* ``REPLACE_WITH_*`` inlining → ``page.evaluate(js, arg)`` with real arguments;
* ``filePath`` capture into the project dir, ``/tmp`` and a cleanup protocol →
  the sanitised HTML held in memory and printed by a throwaway headless browser.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import logging
import time
from typing import Any

from skill_browser import nav
from skill_browser.diagnostics import NetworkLog
from skill_browser.errors import ApiError, ContractChangedError, NotLoggedInError

from peloton_invoice import contract
from peloton_invoice.contract import Invoice, Subscription

logger = logging.getLogger(__name__)

NAV_TIMEOUT_MS = 30_000
MEMBERSHIP_TIMEOUT_SECONDS = 25.0
RECEIPT_TIMEOUT_SECONDS = 20.0
GQL_TIMEOUT_MS = 20_000


@dataclass(frozen=True)
class Site:
    """Where Peloton lives. Overridable only so tests can serve a local fake."""

    entry_url: str = contract.ENTRY_URL
    account_base: str = contract.ACCOUNT_BASE
    graphql_url: str = contract.GRAPHQL_URL
    auth_host: str = contract.AUTH_HOST
    members_host: str = contract.MEMBERS_HOST
    api_hosts: tuple[str, ...] = contract.API_HOSTS

    @property
    def account_host(self) -> str:
        return contract.host_of(self.account_base)

    def barrier(self, url: str) -> str | None:
        """Why *url* is a sign-in page, else None."""
        if contract.host_of(url) == self.auth_host:
            return f"sign-in page at {self.auth_host}"
        return None

    def is_api_url(self, url: str) -> bool:
        return contract.host_of(url) in self.api_hosts or url.startswith(
            self.graphql_url
        )


_TOKEN_ENTRIES = """
({prefix, audience}) => Object.keys(localStorage)
  .filter(k => k.startsWith(prefix) && k.includes(audience))
  .map(k => localStorage.getItem(k))
"""

_GQL = """
async ({url, token, operationName, query, variables, timeoutMs}) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'apollographql-client-name': 'account',
      },
      body: JSON.stringify({ operationName, query, variables }),
    });
    const text = await r.text();
    if (r.status !== 200) return { status: r.status };
    try { return { status: 200, body: JSON.parse(text) }; }
    catch (e) { return { status: 200, parseError: true }; }
  } catch (e) {
    return { networkError: e && e.name === 'AbortError' ? 'timeout' : 'fetch_failed' };
  } finally { clearTimeout(timer); }
}
"""

# Copies all CSS inline, removes scripts, frames, forms, trackers, the cookie
# banner, inline on* handlers and javascript: URLs, then adds a CSP that blocks
# all script and network access other than styles, fonts and images.
_CAPTURE = r"""
({invoiceId, marker}) => {
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(invoiceId)) return 'ERROR:invalid_identifier';
  if (!location.pathname.endsWith('/invoices/' + invoiceId)) return 'ERROR:wrong_page';
  if (!document.body.innerText.includes(marker)) return 'ERROR:receipt_not_rendered';
  const css = [];
  for (const s of document.styleSheets) {
    try { css.push([...s.cssRules].map(r => r.cssText).join('\n')); }
    catch (e) { if (s.href) css.push(`@import url("${s.href}");`); }
  }
  const doc = document.documentElement.cloneNode(true);
  // Remove by tag or id only. NEVER select on class substrings like
  // [class*="fides"]: the consent tool adds a fides-* class to <body>,
  // which deletes the whole receipt and prints a blank page.
  doc.querySelectorAll('script, noscript, iframe, frame, object, embed, link, style, meta, base, form, #fides-overlay, #ada-entry, #fb-root, #post-order-banner, .Toastify, next-route-announcer, #podscribe-request, [id^="batBeacon"]').forEach(n => n.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction|srcset)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) {
        el.removeAttribute(a.name);
      }
    }
  }
  let head = doc.querySelector('head');
  if (!head) { head = document.createElement('head'); doc.prepend(head); }
  const csp = document.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline' https:; img-src https: data:; font-src https: data:");
  head.prepend(csp);
  const charset = document.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  head.prepend(charset);
  const style = document.createElement('style');
  style.textContent = css.join('\n') + '\n@page { size: A4; margin: 12mm; }';
  head.append(style);
  return '<!DOCTYPE html>\n' + doc.outerHTML;
}
"""


async def body_text(page: Any) -> str:
    try:
        text = await page.evaluate(
            "() => (document.body && document.body.innerText) || ''"
        )
    except Exception:
        return ""
    return text if isinstance(text, str) else ""


class PelotonAccount:
    """One signed-in Peloton account page, driven from Python."""

    def __init__(self, browser: Any, site: Site | None = None) -> None:
        self.browser = browser
        self.site = site or Site()
        self.network = NetworkLog(match=self.site.is_api_url)
        self._listening = False

    @property
    def page(self) -> Any:
        return self.browser.page

    def start_recording(self) -> None:
        """Log API traffic from every page in the context (receipt tabs too)."""
        if not self._listening:
            self.browser.context.on("response", self.network.on_response)
            self._listening = True

    async def goto(self, page: Any, url: str) -> None:
        await nav.goto(
            page,
            url,
            tool=contract.TOOL_NAME,
            barrier=self.site.barrier,
            timeout_ms=NAV_TIMEOUT_MS,
        )

    # -- session ---------------------------------------------------------

    async def is_signed_in(self) -> bool:
        """One login poll. Bounces off the classes app back to the account site."""
        url = self.page.url
        if contract.host_of(url) == self.site.members_host:
            # Login can land on members.onepeloton.com; invoices are not there.
            await self.goto(self.page, self.site.entry_url)
            return False
        if not contract.is_membership_url(url, self.site.account_host):
            return False
        return contract.has_signed_in_marker(await body_text(self.page))

    async def open_membership(self) -> str:
        """Load the membership page, confirm the session, return the locale."""
        page = self.page
        await self.goto(page, self.site.entry_url)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + MEMBERSHIP_TIMEOUT_SECONDS
        bounced = False
        while loop.time() < deadline:
            url = page.url
            reason = self.site.barrier(url)
            if reason:
                raise NotLoggedInError(
                    f"Not signed in ({reason}). Run `{contract.TOOL_NAME} login`.",
                    code="redirected_to_sign_in",
                )
            if contract.host_of(url) == self.site.members_host and not bounced:
                bounced = True
                await self.goto(page, self.site.entry_url)
                continue
            if contract.is_membership_url(
                url, self.site.account_host
            ) and contract.has_signed_in_marker(await body_text(page)):
                locale = contract.locale_from_url(url)
                if locale is None:  # pragma: no cover - is_membership_url checked it
                    break
                return locale
            await asyncio.sleep(0.5)

        url = page.url
        if contract.is_membership_url(url, self.site.account_host):
            raise ContractChangedError(
                "The membership page loaded but shows neither "
                f"{' nor '.join(repr(m) for m in contract.SIGNED_IN_MARKERS)}.",
                code="membership_page_unrecognised",
            )
        if contract.host_of(
            url
        ) == self.site.account_host and not contract.locale_from_url(url):
            raise ContractChangedError(
                "The account site did not redirect to /<locale>/mymembership.",
                code="locale_not_found",
                path=nav.path_only(url)[:60],
            )
        raise NotLoggedInError(
            f"The membership page never loaded signed in. Run `{contract.TOOL_NAME} login`.",
            code="not_signed_in",
            host=contract.host_of(url),
        )

    async def token(self) -> str:
        entries = await self.page.evaluate(
            _TOKEN_ENTRIES,
            {"prefix": contract.TOKEN_KEY_PREFIX, "audience": contract.TOKEN_AUDIENCE},
        )
        return contract.pick_token(
            entries if isinstance(entries, list) else [], time.time()
        )

    # -- GraphQL ---------------------------------------------------------

    async def gql(
        self,
        token: str,
        operation: str,
        query: str,
        variables: dict[str, Any],
        prefix: str,
    ) -> dict[str, Any]:
        result = await self.page.evaluate(
            _GQL,
            {
                "url": self.site.graphql_url,
                "token": token,
                "operationName": operation,
                "query": query,
                "variables": variables,
                "timeoutMs": GQL_TIMEOUT_MS,
            },
        )
        return contract.check_gql_result(result, prefix)

    async def subscriptions(self, token: str, locale: str) -> list[Subscription]:
        body = await self.gql(
            token,
            "Subs",
            contract.SUBS_QUERY,
            {
                "input": {
                    "billingStrategyFilters": [],
                    "subscriptionTypeFilters": [],
                    "country": contract.country_of(locale),
                }
            },
            "subs",
        )
        return contract.parse_subscriptions(body)

    async def invoices(self, token: str, subscription: Subscription) -> list[Invoice]:
        body = await self.gql(
            token,
            "PaymentHistory",
            contract.HISTORY_QUERY,
            {"input": {"subscriptionId": subscription.id}},
            "history",
        )
        return contract.parse_invoices(body, subscription.id)

    # -- receipt ---------------------------------------------------------

    async def receipt_html(self, locale: str, invoice: Invoice) -> str:
        """Open the receipt in its own tab, check it, and capture sanitised HTML."""
        url = self.site.account_base + contract.receipt_path(
            locale, invoice.subscriptionId, invoice.id
        )
        page = await self.browser.context.new_page()
        try:
            await self.goto(page, url)
            loop = asyncio.get_running_loop()
            deadline = loop.time() + RECEIPT_TIMEOUT_SECONDS
            text = ""
            while loop.time() < deadline:
                reason = self.site.barrier(page.url)
                if reason:
                    raise NotLoggedInError(
                        f"Not signed in ({reason}). Run `{contract.TOOL_NAME} login`.",
                        code="redirected_to_sign_in",
                    )
                text = await body_text(page)
                if contract.RECEIPT_MARKER in text:
                    break
                await asyncio.sleep(0.5)
            else:
                raise ApiError(
                    f"The receipt never showed {contract.RECEIPT_MARKER!r}. Check the "
                    "invoice and subscription ids belong together.",
                    code="receipt_not_rendered",
                )
            contract.check_receipt_text(text, invoice)
            captured = await page.evaluate(
                _CAPTURE, {"invoiceId": invoice.id, "marker": contract.RECEIPT_MARKER}
            )
            return contract.validate_capture(captured)
        finally:
            try:
                await page.close()
            except Exception:
                logger.debug("Closing the receipt tab failed", exc_info=True)
