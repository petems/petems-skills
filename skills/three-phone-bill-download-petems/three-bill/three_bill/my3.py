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
from dataclasses import dataclass, field
import json
import logging
from pathlib import Path
import re
import time
from typing import Any
from urllib.parse import urlsplit

from three_bill import contract
from three_bill.contract import Bill
from three_bill.errors import (
    ApiError,
    ContractChangedError,
    NotLoggedInError,
    PdfInvalidError,
    ThreeBillError,
)

logger = logging.getLogger(__name__)

NAV_TIMEOUT_MS = 30_000
SEED_CAPTURE_TIMEOUT_SECONDS = 30.0
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


def validate_pdf(
    status: int, content_type: str, body: bytes | None, *, size: int | None = None
) -> None:
    """Raise unless this is a plausible Three bill PDF."""
    if status != 200:
        raise PdfInvalidError(
            f"PDF request returned HTTP {status}", code=f"pdf_status:{status}"
        )
    media = (content_type or "").split(";")[0].strip().lower()
    if not media.startswith("application/pdf"):
        # text/html here is almost always an auth redirect.
        raise PdfInvalidError(
            f"PDF request returned {media or 'no content type'}",
            code=f"pdf_content_type:{media or 'none'}",
        )
    length = len(body) if body is not None else (size or 0)
    if length > PDF_MAX_BYTES:
        raise PdfInvalidError(
            f"PDF is {length} bytes, over the cap", code="pdf_too_large", bytes=length
        )
    if body is None or not body.startswith(b"%PDF-"):
        raise PdfInvalidError("Response does not start with %PDF-", code="pdf_not_pdf")
    if length < PDF_MIN_BYTES:
        raise PdfInvalidError(
            f"PDF is only {length} bytes; a Three bill is usually 0.5-2 MB",
            code="pdf_too_small",
            bytes=length,
        )


async def goto(page: Any, url: str, site: Site) -> None:
    """Navigate, turning any failure into a typed error that names no URL.

    A sign-in redirect left behind by a failed or timed-out navigation is real
    evidence about the session and outranks the network error.
    """
    from patchright.async_api import Error as PlaywrightError
    from patchright.async_api import TimeoutError as PlaywrightTimeoutError

    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
    except PlaywrightError as exc:
        barrier = auth_barrier(page.url, site)
        if barrier and not page.url.startswith("about:"):
            raise NotLoggedInError(
                f"My3 is not signed in ({barrier}). Run `three-bill login`.",
                code="redirected_to_sign_in",
            ) from exc
        if isinstance(exc, PlaywrightTimeoutError):
            raise ApiError(
                f"Timed out loading {contract.redact_url(url)}",
                code="navigation_timeout",
            ) from exc
        net = re.search(r"net::[A-Z_]+", str(exc))
        raise ApiError(
            f"Could not load {contract.redact_url(url)} "
            f"({net.group(0) if net else type(exc).__name__}). Check the network.",
            code="navigation_failed",
        ) from exc


@dataclass
class NetworkLog:
    """A redacted record of the My3 API traffic, for diagnostics only."""

    entries: list[dict[str, Any]] = field(default_factory=list)

    def add(
        self,
        method: str,
        url: str,
        status: int,
        headers: dict[str, str] | None,
        via: str,
    ) -> None:
        if contract.API_PREFIX not in urlsplit(url).path:
            return
        self.entries.append(
            {
                "via": via,
                "method": method,
                "path": contract.redact_url(url),
                "status": status,
                "headers": contract.redact_headers(headers),
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
        self.network = NetworkLog()
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
            except ThreeBillError:
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

    async def wait_while_loading(
        self, timeout: float = 15.0, stable_polls: int = 3
    ) -> None:
        """Until body text length stops changing. Text *length*, never text."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        last, stable = -1, 0
        while loop.time() < deadline:
            try:
                length = await self.page.evaluate(
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
            await goto(page, self.site.account_url, self.site)
            await asyncio.sleep(1.0)
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
        await self.wait_while_loading()
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
                # Buffered whole by APIRequestContext; fine for a 0.5-2 MB bill,
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

    # -- diagnostics -----------------------------------------------------

    async def capture_diagnostics(
        self, directory: Path, error: ThreeBillError
    ) -> dict[str, str]:
        """Screenshot plus the redacted API log. No bodies, tokens or cookies."""
        stamp = time.strftime("%Y%m%d-%H%M%S")
        directory.mkdir(parents=True, exist_ok=True)
        directory.chmod(0o700)
        out: dict[str, str] = {}
        log_path = directory / f"three-bill-{stamp}.json"
        try:
            page_path: str | None = contract.redact_url(self.page.url)
        except Exception:
            page_path = None
        payload = {
            "error": error.code,
            "page": page_path,
            "requests": self.network.entries,
        }
        log_path.write_text(json.dumps(payload, indent=2))
        log_path.chmod(0o600)
        out["network_log"] = str(log_path)
        try:
            shot = directory / f"three-bill-{stamp}.png"
            await self.page.screenshot(path=str(shot))
            shot.chmod(0o600)
            out["screenshot"] = str(shot)
        except Exception:
            logger.debug("Screenshot failed", exc_info=True)
        return out
