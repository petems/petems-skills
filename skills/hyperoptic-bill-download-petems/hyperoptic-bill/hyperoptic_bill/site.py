"""Driving the Hyperoptic account site: session checks, the bills page, the PDF.

Hyperoptic has no JSON API this CLI relies on, so the browser drives the same
pages a person would: ``/bills-and-payments``, a month name, the View Bill
page, and its "Download PDF bill" control. Every decision about what those
pages say is made in Python by :mod:`hyperoptic_bill.contract`.

What this replaces from the chrome-devtools-mcp flow:

* reading snapshots by eye → ``inner_text`` parsed and validated in Python;
* ``touch`` marker + polling ``~/Downloads`` → Playwright's download event;
* ``get_network_request`` with a ``responseFilePath`` → a response listener.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date
import logging
from pathlib import Path
import re
from typing import Any

from skill_browser import nav
from skill_browser import pdf as pdf_checks
from skill_browser.diagnostics import NetworkLog
from skill_browser.errors import (
    ContractChangedError,
    NotFoundError,
    NotLoggedInError,
    PdfInvalidError,
)
from skill_browser.months import MONTHS

from hyperoptic_bill import contract
from hyperoptic_bill.contract import Bill

logger = logging.getLogger(__name__)

TOOL_NAME = "hyperoptic-bill"

PAGE_READY_TIMEOUT_SECONDS = 20.0
MONTH_NAV_TIMEOUT_MS = 6_000
VIEW_BILL_TIMEOUT_MS = 20_000
DOWNLOAD_TIMEOUT_MS = 30_000
COOKIE_TIMEOUT_MS = 2_000
PDF_MIN_BYTES = 20_000
DOWNLOAD_LABEL = "Download PDF bill"


@dataclass(frozen=True)
class Site:
    """Where the account site lives. Overridable only so tests can serve a local fake."""

    base_url: str = contract.BASE_URL

    @property
    def host(self) -> str:
        return contract.host_of(self.base_url)

    def url(self, path: str) -> str:
        return self.base_url + path

    @property
    def home_url(self) -> str:
        return self.url("/")

    @property
    def bills_url(self) -> str:
        return self.url(contract.BILLS_PATH)


def _timeout_error() -> type[Exception]:
    from patchright.async_api import TimeoutError as PlaywrightTimeoutError

    return PlaywrightTimeoutError


class Hyperoptic:
    """One signed-in account page, driven from Python."""

    def __init__(self, browser: Any, site: Site | None = None) -> None:
        self.browser = browser
        self.site = site or Site()
        self.network = NetworkLog(
            match=lambda url: contract.is_billing_url(url, self.site.base_url)
        )
        self._listening = False

    @property
    def page(self) -> Any:
        return self.browser.page

    def barrier(self, url: str) -> str | None:
        return contract.auth_barrier(url, self.site.base_url)

    def start_recording(self) -> None:
        if not self._listening:
            self.network.attach(self.page)
            self._listening = True

    async def goto(self, url: str) -> None:
        await nav.goto(self.page, url, tool=TOOL_NAME, barrier=self.barrier)

    async def body_text(self) -> str:
        try:
            text = await self.page.inner_text("body", timeout=5_000)
        except Exception:
            return ""
        return text if isinstance(text, str) else ""

    # -- session ---------------------------------------------------------

    async def is_signed_in(self) -> bool:
        if self.barrier(self.page.url):
            return False
        return contract.has_signed_in_marker(await self.body_text())

    def _not_signed_in(self, reason: str) -> NotLoggedInError:
        return NotLoggedInError(
            f"Hyperoptic is not signed in ({reason}). Run `{TOOL_NAME} login`.",
            code="redirected_to_sign_in",
        )

    async def dismiss_cookies(self) -> None:
        """Best effort: click a cookie "Accept" button if one is showing."""
        button = self.page.get_by_role("button", name=re.compile(r"^\s*accept", re.I))
        try:
            if await button.count():
                await button.first.click(timeout=COOKIE_TIMEOUT_MS)
        except Exception:
            logger.debug("No cookie banner dismissed", exc_info=True)

    # -- bills page ------------------------------------------------------

    async def open_bills(self, year: int | None = None) -> None:
        """Load ``/bills-and-payments`` (directly, never via the sidebar)."""
        await self.goto(self.site.bills_url)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + PAGE_READY_TIMEOUT_SECONDS
        january = self.page.get_by_text("January", exact=True)
        while True:
            # The SPA bounces through Keycloak on load; only a redirect that
            # stays on Keycloak means signed out.
            reason = await nav.wait_off_barrier(self.page, self.barrier)
            if reason:
                raise self._not_signed_in(reason)
            try:
                if await january.count():
                    break
            except Exception:
                pass  # mid-navigation
            if loop.time() > deadline:
                raise ContractChangedError(
                    "The bills page loaded but shows no month names",
                    code="bills_page_shape_changed",
                )
            await asyncio.sleep(0.25)
        await self.dismiss_cookies()
        if year is not None and year != date.today().year:
            await self.select_year(year)

    async def select_year(self, year: int) -> None:
        combo = self.page.get_by_role("combobox")
        if not await combo.count():
            raise ContractChangedError(
                "No year selector on the bills page", code="year_selector_missing"
            )
        target = combo.first
        label = str(year)
        try:
            options = await target.evaluate(
                "el => el.tagName === 'SELECT' ? [...el.options].map(o => o.label.trim()) : null"
            )
        except Exception:
            options = None
        if isinstance(options, list):
            if label not in options:
                raise NotFoundError(
                    f"The bills page has no {year} in its year selector",
                    code="year_not_available",
                    available=[o for o in options if re.fullmatch(r"20\d{2}", o)],
                )
            await target.select_option(label=label)
        else:
            # A custom dropdown: open it and pick the option.
            try:
                await target.click(timeout=5_000)
                await self.page.get_by_role("option", name=label, exact=True).click(
                    timeout=5_000
                )
            except Exception as exc:
                raise ContractChangedError(
                    "Could not pick a year in the year selector",
                    code="year_selector_missing",
                ) from exc
        await nav.wait_for_stable_text(self.page, timeout=5.0)

    async def open_month(self, month: str, year: int) -> Bill | None:
        """Open the View Bill page for *month* / *year*. None if that month has no bill."""
        await self.open_bills(year)
        link = self.page.get_by_text(month, exact=True)
        if not await link.count():
            raise ContractChangedError(
                f"The bills page does not list {month}", code="bills_page_shape_changed"
            )
        await link.first.click()
        try:
            await self.page.wait_for_url(
                lambda url: (
                    contract.invoice_id_from_url(url, self.site.base_url) is not None
                ),
                timeout=MONTH_NAV_TIMEOUT_MS,
            )
        except _timeout_error():
            reason = self.barrier(self.page.url)
            if reason:
                raise self._not_signed_in(reason) from None
            return None  # months without a bill do not respond
        return await self.read_view_bill()

    async def read_view_bill(self) -> Bill:
        # The content loads after the navigation; "Amount due" is the last to land.
        try:
            await self.page.get_by_text("Amount due").first.wait_for(
                timeout=VIEW_BILL_TIMEOUT_MS
            )
        except _timeout_error():
            raise ContractChangedError(
                "The View Bill page never showed 'Amount due'",
                code="view_bill_shape_changed",
                field="Amount due",
            ) from None
        await nav.wait_for_stable_text(self.page, timeout=5.0)
        return contract.parse_view_bill(
            await self.body_text(), self.page.url, self.site.base_url
        )

    async def find_bill(self, month: str | None, year: int | None) -> Bill:
        """A named month, or (with no month) the newest bill within 13 months."""
        today = date.today()
        if month is not None:
            bill = await self.open_month(month, year or today.year)
            if bill is None:
                raise NotFoundError(
                    f"No bill for {month} {year or today.year}",
                    code="bill_not_found",
                    requested={"month": month, "year": year or today.year},
                )
            return bill
        start_month = (
            MONTHS[today.month - 1] if year in (None, today.year) else "December"
        )
        tried = []
        for m, y in contract.months_back(start_month, year or today.year):
            if year is not None and y != year:
                break
            bill = await self.open_month(m, y)
            if bill is not None:
                return bill
            tried.append({"month": m, "year": y})
        raise NotFoundError(
            "No bill found in the months tried", code="bill_not_found", tried=tried
        )

    async def list_bills(self, year: int) -> list[Bill]:
        today = date.today()
        last = today.month if year == today.year else 12
        bills = []
        for m in MONTHS[:last]:
            bill = await self.open_month(m, year)
            if bill is not None:
                bills.append(bill)
        bills.reverse()  # newest first
        return bills

    # -- PDF -------------------------------------------------------------

    async def _download_control(self) -> Any:
        for role in ("button", "link"):
            control = self.page.get_by_role(role, name=DOWNLOAD_LABEL)
            if await control.count():
                return control.first
        control = self.page.get_by_text(DOWNLOAD_LABEL)
        if await control.count():
            return control.first
        raise ContractChangedError(
            f"No '{DOWNLOAD_LABEL}' control on the View Bill page",
            code="download_control_missing",
        )

    async def download_pdf(self, bill: Bill) -> tuple[bytes, str]:
        """``(bytes, via)``: the browser download, else the captured billing response."""
        invoice_id = contract.validate_invoice_id(bill.invoiceId)
        if (
            contract.invoice_id_from_url(self.page.url, self.site.base_url)
            != invoice_id
        ):
            raise ContractChangedError(
                "The page is no longer on this bill's View Bill page",
                code="wrong_page",
            )
        captured: list[Any] = []

        def collect(response: Any) -> None:
            try:
                ctype = (response.headers.get("content-type") or "").lower()
                if (
                    contract.is_bill_pdf_url(response.url, invoice_id)
                    and "pdf" in ctype
                ):
                    captured.append(response)
            except Exception:
                pass

        control = await self._download_control()
        self.page.on("response", collect)
        try:
            try:
                async with self.page.expect_download(
                    timeout=DOWNLOAD_TIMEOUT_MS
                ) as info:
                    await control.click()
                download = await info.value
                failure = await download.failure()
                if failure:
                    raise PdfInvalidError(
                        f"The browser download failed ({failure})",
                        code="download_failed",
                    )
                data = Path(await download.path()).read_bytes()
                validate_pdf(200, "", data, check_content_type=False)
                return data, "download"
            except _timeout_error():
                logger.info("No download event; trying the captured response")
            if not captured:
                raise PdfInvalidError(
                    "Clicking 'Download PDF bill' produced no download and no "
                    f"/billing/{invoice_id} PDF response",
                    code="no_download",
                )
            response = captured[-1]
            body = await response.body()
            validate_pdf(
                response.status, response.headers.get("content-type", ""), body
            )
            return body, "network"
        finally:
            self.page.remove_listener("response", collect)


def validate_pdf(
    status: int,
    content_type: str,
    body: bytes | None,
    *,
    check_content_type: bool = True,
) -> None:
    pdf_checks.validate_pdf(
        status,
        content_type,
        body,
        min_bytes=PDF_MIN_BYTES,
        check_content_type=check_content_type,
    )
