"""Talking to My3 through the browser: session checks, the API calls, the PDF.

The browser is only a transport. It holds the HttpOnly session cookies and runs
same-origin ``fetch`` calls; every decision about the responses is made in
Python by :mod:`three_bill.contract`.

What this replaces from the chrome-devtools-mcp flow:

* ``list_network_requests`` → a ``response`` listener scoped to one navigation;
* ``REPLACE_WITH_*`` inlining → ``page.evaluate(js, arg)`` with a real argument;
* ``window.__threeAuth`` → the rotating token held in a Python variable;
* ``filePath`` + base64 + ``tr | base64 -d`` → bytes in Python.
"""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
import logging
import time
from typing import Any
from urllib.parse import urlsplit

from skill_browser import nav
from skill_browser import pdf as pdf_checks
from skill_browser.diagnostics import NetworkLog
from skill_browser.errors import (
    ApiError,
    ContractChangedError,
    NotLoggedInError,
    PdfInvalidError,
    SkillError,
)

from three_bill import contract
from three_bill.contract import Bill

logger = logging.getLogger(__name__)

TOOL_NAME = "three-bill"

NAV_TIMEOUT_MS = 30_000
SEED_CAPTURE_TIMEOUT_SECONDS = 30.0
ACCOUNT_RECOVERY_TIMEOUT_SECONDS = 45.0
SIGN_IN_ROUTE_GRACE_SECONDS = 6.0
ACCOUNT_STABLE_SECONDS = 3.0
LANDING_STALL_SECONDS = 15.0
API_TIMEOUT_MS = 30_000
PDF_TIMEOUT_MS = 60_000
PDF_MIN_BYTES = 100_000
PDF_MAX_BYTES = 20 * 1024 * 1024

# Routes that mean "not signed in" on the www host. Matched on the parsed path.
_SIGN_IN_PATHS = ("/customer-login", "/login", "/logout")


@dataclass(frozen=True)
class Site:
    """Where My3 lives. Overridable only so tests can serve a local fake."""

    base_url: str = contract.BASE_URL

    @property
    def host(self) -> str:
        return contract.host_of(self.base_url)

    def url(self, path: str) -> str:
        return self.base_url + path

    @property
    def login_url(self) -> str:
        return self.url("/customer-login")

    @property
    def account_url(self) -> str:
        return self.url("/account")


def auth_barrier(url: str, site: Site) -> str | None:
    """Why *url* is not a signed-in My3 page, from the URL alone, else None."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host != site.host or parts.scheme != urlsplit(site.base_url).scheme:
        return f"off-site redirect to {host or 'an unknown host'}"
    path = (parts.path or "/").lower().rstrip("/") or "/"
    for blocker in _SIGN_IN_PATHS:
        if path == blocker or path.startswith(blocker + "/"):
            return f"sign-in route {blocker}"
    return None


def is_account_url(url: str, site: Site) -> bool:
    """On ``/account``, not ``/customer-logged`` (which never loads customer state)."""
    if auth_barrier(url, site):
        return False
    path = urlsplit(url).path.rstrip("/")
    return path == "/account" or path.startswith("/account/")


def recovery_step(url: str, site: Site) -> str:
    """Where the SPA is on its way back to /account.

    ``account`` done; ``auth_form`` the Auth0 sign-in form (a human is
    needed); ``auth_silent`` any other Auth0 hop; ``sign_in_route`` a www
    sign-in route; ``landing`` any other www page (e.g. /customer-logged).
    """
    if is_account_url(url, site):
        return "account"
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host and host != site.host:
        path = (parts.path or "/").lower()
        return "auth_form" if path.startswith("/u/") else "auth_silent"
    if auth_barrier(url, site):
        return "sign_in_route"
    return "landing"


def validate_pdf(
    status: int, content_type: str, body: bytes | None, *, size: int | None = None
) -> None:
    """Raise unless this is a plausible Three bill PDF (usually 0.5 to 3 MB)."""
    pdf_checks.validate_pdf(
        status,
        content_type,
        body,
        size=size,
        min_bytes=PDF_MIN_BYTES,
        max_bytes=PDF_MAX_BYTES,
    )


async def goto(page: Any, url: str, site: Site) -> None:
    await nav.goto(
        page,
        url,
        tool=TOOL_NAME,
        barrier=lambda current: auth_barrier(current, site),
        redact=contract.redact_url,
        timeout_ms=NAV_TIMEOUT_MS,
    )


def is_api_url(url: str) -> bool:
    return contract.API_PREFIX in urlsplit(url).path


_FETCH_JSON = """
async ({url, token, timeoutMs}) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = token ? { authorization: token } : {};
    const r = await fetch(url, { credentials: 'include', headers, signal: ctrl.signal });
    const out = {
      status: r.status,
      token: r.headers.get('uxfauthorization'),
      contentType: r.headers.get('content-type') || '',
      parsed: false,
      body: null,
    };
    if (r.status === 200) {
      try { out.body = await r.json(); out.parsed = true; } catch (e) { /* reported as unparsed */ }
    }
    return out;
  } catch (e) {
    return { status: 0, error: e && e.name === 'AbortError' ? 'timeout' : 'fetch_failed' };
  } finally {
    clearTimeout(timer);
  }
}
"""

_FETCH_PDF = """
async ({url, token, maxBytes, timeoutMs}) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { credentials: 'include', headers: { authorization: token }, signal: ctrl.signal });
    const out = {
      status: r.status,
      token: r.headers.get('uxfauthorization'),
      contentType: r.headers.get('content-type') || '',
      b64: null,
      size: 0,
    };
    if (r.status !== 200 || !out.contentType.toLowerCase().startsWith('application/pdf')) return out;
    const bytes = new Uint8Array(await r.arrayBuffer());
    out.size = bytes.length;
    if (bytes.length > maxBytes) return out;
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    out.b64 = btoa(bin);
    return out;
  } catch (e) {
    return { status: 0, error: e && e.name === 'AbortError' ? 'timeout' : 'fetch_failed' };
  } finally {
    clearTimeout(timer);
  }
}
"""


@dataclass
class Account:
    cuid: str
    source: str  # "spa_seed_response" or "session_storage"


class My3:
    """One signed-in My3 page, driven from Python."""

    def __init__(self, browser: Any, site: Site | None = None) -> None:
        self.browser = browser
        self.site = site or Site()
        self.network = NetworkLog(match=is_api_url, redact=contract.redact_url)
        self._listening = False

    @property
    def page(self) -> Any:
        return self.browser.page

    def start_recording(self) -> None:
        if not self._listening:
            self.page.on("response", self.network.on_response)
            self._listening = True

    # -- session ---------------------------------------------------------

    async def fetch_json(self, path: str, token: str | None = None) -> dict[str, Any]:
        result = await self.page.evaluate(
            _FETCH_JSON,
            {"url": path, "token": token, "timeoutMs": API_TIMEOUT_MS},
        )
        if not isinstance(result, dict):
            raise ApiError("The in-page fetch returned nothing", code="fetch_failed")
        if result.get("status") == 0:
            raise ApiError(
                f"Request to {contract.redact_url(path)} failed ({result.get('error')})",
                code=f"fetch_{result.get('error') or 'failed'}",
            )
        return result

    async def check_authenticated(self, *, attempts: int = 3) -> None:
        """``GET .../authentication/v1/B2C/user``; only ``isAnonymous is False`` passes.

        Retried a few times only for *transport* failures (the page navigating
        under the evaluate); a definite answer is never retried.
        """
        last: Exception | None = None
        for _ in range(attempts):
            barrier = auth_barrier(self.page.url, self.site)
            if barrier:
                raise NotLoggedInError(
                    f"My3 is not signed in ({barrier}). Run `three-bill login`.",
                    code="redirected_to_sign_in",
                )
            try:
                result = await self.fetch_json(contract.auth_check_path())
            except SkillError:
                raise
            except Exception as exc:  # execution context destroyed mid-navigation
                last = exc
                await asyncio.sleep(1.0)
                continue
            if result["status"] == 200 and not result.get("parsed"):
                raise NotLoggedInError(
                    "The My3 auth check body was not JSON. Run `three-bill login`.",
                    code="auth_check_unparseable",
                )
            try:
                contract.check_auth_body(result["status"], result.get("body"))
            except NotLoggedInError as exc:
                exc.args = (f"{exc} Run `three-bill login`.",)
                raise
            return
        raise ApiError(
            "Could not run the My3 auth check; the page kept navigating.",
            code="auth_check_unreachable",
        ) from last

    async def goto_account(self) -> None:
        """Load /account, letting the SPA's own redirects interrupt the load.

        The /account guard can redirect before the load finishes, and
        Patchright then reports the interrupted navigation while the page is
        on Auth0 (live, 2026-11-17). That is the start of the SPA's recovery,
        not proof of a signed-out session: :meth:`wait_for_account` decides.
        """
        try:
            await goto(self.page, self.site.account_url, self.site)
        except NotLoggedInError as exc:
            if exc.code != "redirected_to_sign_in":
                raise
            logger.info("The /account load was redirected mid-flight; recovering")

    async def wait_for_account(self) -> None:
        """Let the SPA recover its own session until it is on ``/account``.

        After a browser restart My3's sessionStorage is empty, so the /account
        route guard sends the page to /customer-login, which runs a silent
        Auth0 /authorize (persistent ``auth0`` cookie), lands on
        /customer-logged and moves itself to /account (seen live,
        2026-11-17). Fails fast only when a human is needed: the Auth0 form
        is showing, or the page sits on a sign-in route.
        """
        loop = asyncio.get_running_loop()
        started = loop.time()
        on_sign_in_since: float | None = None
        landing_since: float | None = None
        account_since: float | None = None
        retried = False
        while True:
            now = loop.time()
            step = recovery_step(self.page.url, self.site)
            # /account renders for a moment before its guard redirects, so it
            # only counts once the page has stayed there.
            account_since = (account_since or now) if step == "account" else None
            if account_since and now - account_since >= ACCOUNT_STABLE_SECONDS:
                return
            if step == "auth_form":
                raise NotLoggedInError(
                    "My3 needs you to sign in again (the Auth0 form is showing). "
                    "Run `three-bill login`.",
                    code="sign_in_required",
                )
            on_sign_in_since = (
                (on_sign_in_since or now) if step == "sign_in_route" else None
            )
            if (
                on_sign_in_since
                and now - on_sign_in_since > SIGN_IN_ROUTE_GRACE_SECONDS
            ):
                raise NotLoggedInError(
                    f"My3 is not signed in ({auth_barrier(self.page.url, self.site)}). "
                    "Run `three-bill login`.",
                    code="redirected_to_sign_in",
                )
            landing_since = (landing_since or now) if step == "landing" else None
            if (
                landing_since
                and not retried
                and now - landing_since > LANDING_STALL_SECONDS
            ):
                # The SPA usually moves itself on; nudge it once if it stalls.
                retried = True
                landing_since = None
                await self.goto_account()
            if now - started > ACCOUNT_RECOVERY_TIMEOUT_SECONDS:
                raise NotLoggedInError(
                    "My3 did not reach /account. Run `three-bill login`.",
                    code="not_on_account_page",
                    path=contract.redact_url(self.page.url),
                )
            await asyncio.sleep(0.25)

    async def open_account(self) -> Account:
        """Load ``/account``, confirm the session, and learn the cuid.

        The cuid comes from the SPA's own seed request
        (``/care/v1/B2C/customer/<cuid>?…``), read off a response listener that
        only accepts requests started after this navigation began. The
        redux-persist copy in ``sessionStorage`` is the fallback.
        """
        page = self.page
        captured: list[Any] = []
        started_ms = time.time() * 1000

        def collect(response: Any) -> None:
            try:
                request = response.request
                if request.method != "GET" or not response.ok:
                    return
                if not contract.is_seed_url(response.url, self.site.base_url):
                    return
                start = (request.timing or {}).get("startTime")
                # A request that began before this navigation is a previous
                # page's late refetch, never this page's answer.
                if (
                    isinstance(start, int | float)
                    and start > 0
                    and start < started_ms - 1000
                ):
                    return
                captured.append(response)
            except Exception:
                pass

        page.on("response", collect)
        try:
            await self.goto_account()
            await self.wait_for_account()
            await self.check_authenticated()

            loop = asyncio.get_running_loop()
            deadline = loop.time() + SEED_CAPTURE_TIMEOUT_SECONDS
            while not captured and loop.time() < deadline:
                barrier = auth_barrier(page.url, self.site)
                if barrier:
                    raise NotLoggedInError(
                        f"My3 is not signed in ({barrier}). Run `three-bill login`.",
                        code="redirected_to_sign_in",
                    )
                await asyncio.sleep(0.25)
        finally:
            page.remove_listener("response", collect)

        if not is_account_url(page.url, self.site):
            raise NotLoggedInError(
                "My3 did not stay on /account (it lands on /customer-logged when the "
                "customer state is missing). Run `three-bill login`.",
                code="not_on_account_page",
                path=contract.redact_url(page.url),
            )

        seen = {
            cuid
            for cuid in (contract.cuid_from_seed_url(r.url) for r in captured)
            if cuid
        }
        if len(seen) > 1:
            # Never guess which account the user meant.
            raise ContractChangedError(
                f"My3 loaded {len(seen)} customer accounts; three-bill handles one.",
                code="multiple_accounts",
                count=len(seen),
            )
        if seen:
            return Account(contract.validate_cuid(seen.pop()), "spa_seed_response")

        logger.info("SPA seed request not seen; falling back to sessionStorage")
        await nav.wait_for_stable_text(self.page)
        raw = await page.evaluate(
            "() => sessionStorage.getItem('persist:customerProfilePersistor')"
        )
        return Account(contract.cuid_from_persistor(raw), "session_storage")

    # -- API -------------------------------------------------------------

    async def seed(self, cuid: str) -> tuple[str, str]:
        """``(billId, token)``. Needs no auth header; returns the first token.

        Called by us rather than reusing the token on the SPA's own seed
        response: the SPA spends that token on its next call, and the token
        rotates per call.
        """
        result = await self.fetch_json(contract.seed_path(cuid))
        status = result["status"]
        if status in (401, 403):
            raise NotLoggedInError(
                f"The seed call returned HTTP {status}; the session expired. "
                "Run `three-bill login`.",
                code="seed_unauthorized",
                status=status,
            )
        if status != 200:
            raise ApiError(
                f"The seed call returned HTTP {status}; the Three API may have moved.",
                code="seed_failed",
                status=status,
            )
        token = result.get("token")
        if not token:
            raise ContractChangedError(
                "The seed response has no uxfauthorization header",
                code="no_auth_header",
            )
        if not result.get("parsed"):
            raise ContractChangedError(
                "The seed response body is not JSON",
                code="seed_shape_changed",
                field="body",
            )
        return contract.bill_id_from_seed(result.get("body")), token

    async def list_bills(
        self, cuid: str, bill_id: str, token: str
    ) -> tuple[list[Bill], str]:
        result = await self.fetch_json(contract.list_path(cuid, bill_id), token)
        status = result["status"]
        if status in (401, 403):
            raise NotLoggedInError(
                f"The list-bills call returned HTTP {status}. Run `three-bill login`.",
                code="list_unauthorized",
                status=status,
            )
        if status != 200:
            raise ApiError(
                f"The list-bills call returned HTTP {status}",
                code="list_failed",
                status=status,
            )
        if not result.get("parsed"):
            raise ContractChangedError(
                "The list-bills body is not JSON", code="list_shape_changed"
            )
        return contract.parse_bills(result.get("body")), result.get("token") or token

    async def download_pdf(
        self, cuid: str, bill_id: str, bill_number: str, token: str
    ) -> tuple[bytes, str]:
        """Fetch the PDF with the session cookies and the rotating token.

        Primary path is ``context.request``, which shares the persistent
        context's cookies. If that is refused, the token is refreshed with a
        new seed call and the fetch is retried inside the page.
        """
        path = contract.pdf_path(cuid, bill_id, bill_number)
        try:
            return await self._pdf_via_request(path, token)
        except PdfInvalidError as primary:
            if primary.code in ("pdf_too_large", "pdf_too_small", "pdf_not_pdf"):
                raise
            logger.info(
                "context.request PDF fetch failed (%s); retrying in-page", primary.code
            )
            _, fresh = await self.seed(cuid)
            try:
                return await self._pdf_via_page(path, fresh)
            except PdfInvalidError as fallback:
                fallback.details.setdefault("primary_error", primary.code)
                raise

    async def _pdf_via_request(self, path: str, token: str) -> tuple[bytes, str]:
        url = self.site.url(path)
        response = await self.browser.context.request.get(
            url,
            headers={"authorization": token, "referer": self.site.account_url},
            timeout=PDF_TIMEOUT_MS,
            max_redirects=0,
            fail_on_status_code=False,
        )
        try:
            headers = response.headers
            self.network.add("GET", url, response.status, headers, "context.request")
            content_type = headers.get("content-type", "")
            body = None
            if response.status == 200 and content_type.lower().startswith(
                "application/pdf"
            ):
                # Buffered whole by APIRequestContext; fine for a 0.5-3 MB bill,
                # but it means the cap is checked after the download.
                body = await response.body()
            validate_pdf(response.status, content_type, body)
            return body, headers.get("uxfauthorization") or token  # type: ignore[return-value]
        finally:
            await response.dispose()

    async def _pdf_via_page(self, path: str, token: str) -> tuple[bytes, str]:
        result = await self.page.evaluate(
            _FETCH_PDF,
            {
                "url": path,
                "token": token,
                "maxBytes": PDF_MAX_BYTES,
                "timeoutMs": PDF_TIMEOUT_MS,
            },
        )
        if not isinstance(result, dict) or result.get("status") == 0:
            raise ApiError("The in-page PDF fetch failed", code="pdf_fetch_failed")
        encoded = result.get("b64")
        body = base64.b64decode(encoded) if encoded else None
        validate_pdf(
            result["status"],
            result.get("contentType", ""),
            body,
            size=result.get("size"),
        )
        return body, result.get("token") or token  # type: ignore[return-value]
