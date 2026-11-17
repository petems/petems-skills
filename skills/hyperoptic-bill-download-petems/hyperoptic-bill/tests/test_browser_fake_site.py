"""End to end against a local fake of the Hyperoptic account site, in a real Chromium.

Exercises what unit tests cannot: the bills page wait, the year selector,
clicking a month, the View Bill page loading late, the browser download event,
and the response-listener fallback. No Hyperoptic page is loaded.

Set HYPEROPTIC_BILL_TEST_CHROME to a Chromium binary if patchright's own is not
installed; the tests are skipped when neither is usable.
"""

from __future__ import annotations

from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlsplit

import pytest
from skill_browser.browser import open_profile
from skill_browser.errors import NotFoundError, NotLoggedInError
from skill_browser.months import MONTHS

from hyperoptic_bill import site as site_mod
from hyperoptic_bill.site import Hyperoptic, Site

pytestmark = pytest.mark.browser

PDF = b"%PDF-1.7\n" + b"0" * 40_000 + b"\n%%EOF\n"
TODAY = date.today()


def _shift(months_back: int) -> tuple[str, int]:
    index = TODAY.month - 1 - months_back
    return MONTHS[index % 12], TODAY.year + index // 12


# (month, year) -> (invoiceId, amount). The current month has no bill yet.
BILLS = {
    _shift(1): ("84623147", "53.00"),
    _shift(2): ("84500001", "1,053.50"),
    _shift(12): ("83000001", "49.00"),
}
BY_ID = {invoice: (m, y, amount) for (m, y), (invoice, amount) in BILLS.items()}
YEARS = sorted({y for _m, y in BILLS} | {TODAY.year}, reverse=True)

BILLS_HTML = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<nav>Dashboard</nav><h1>Bills and payments</h1>
<button onclick="this.remove()">Accept all cookies</button>
<select aria-label="Year" onchange="location.search='?year='+this.value">%(options)s</select>
<ul>%(months)s</ul></body></html>"""

VIEW_HTML = """<!doctype html><html><head><meta charset="utf-8"></head><body><nav>Dashboard</nav><div id="root"></div><script>
setTimeout(() => {
  document.getElementById('root').innerHTML = `<h1>%(month)s %(year)s bill</h1>
    <p>£%(amount)s</p><p>Amount due</p><p>9 %(month)s, %(year)s</p><p>Bill date</p><p>23 %(month)s, %(year)s</p><p>Payment date</p>
    %(control)s`;
}, 300);
</script></body></html>"""

DOWNLOAD_LINK = '<a href="/billing/%(id)s/pdf">Download PDF bill</a>'
# The fallback case: the control fetches the PDF but no download happens.
FETCH_BUTTON = "<button onclick=\"fetch('/billing/%(id)s/pdf?inline=1')\">Download PDF bill</button>"


class FakeSite:
    def __init__(self) -> None:
        self.download_mode = "attachment"  # or "fetch"


def make_handler(state: FakeSite):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def signed_in(self) -> bool:
            return "session=ok" in (self.headers.get("Cookie") or "")

        def send(self, status, body=b"", ctype="text/html", headers=None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            parts = urlsplit(self.path)
            query = parse_qs(parts.query)
            if parts.path.startswith("/realms/"):
                return self.send(200, b"<form>Sign in<input type=password></form>")
            if not self.signed_in():
                return self.send(
                    302,
                    headers={
                        "Location": "/realms/hyperoptic/protocol/openid-connect/auth"
                    },
                )
            if parts.path == "/":
                return self.send(200, b"<h1>Dashboard</h1>")
            if parts.path == "/bills-and-payments":
                year = int(query.get("year", [TODAY.year])[0])
                options = "".join(
                    f"<option{' selected' if y == year else ''}>{y}</option>"
                    for y in YEARS
                )
                months = []
                for m in MONTHS:
                    if (m, year) in BILLS:
                        invoice = BILLS[(m, year)][0]
                        months.append(
                            f'<li><a href="/bills-and-payments/view-bill?invoiceId={invoice}">{m}</a></li>'
                        )
                    else:
                        months.append(f"<li><span>{m}</span></li>")
                html = BILLS_HTML % {"options": options, "months": "".join(months)}
                return self.send(200, html.encode())
            if parts.path == "/bills-and-payments/view-bill":
                invoice = query.get("invoiceId", [""])[0]
                if invoice not in BY_ID:
                    return self.send(404)
                month, year, amount = BY_ID[invoice]
                control = (
                    DOWNLOAD_LINK
                    if state.download_mode == "attachment"
                    else FETCH_BUTTON
                ) % {"id": invoice}
                html = VIEW_HTML % {
                    "month": month,
                    "year": year,
                    "amount": amount,
                    "control": control,
                }
                return self.send(200, html.encode())
            if parts.path.startswith("/billing/"):
                invoice = parts.path.split("/")[2]
                headers = {}
                if "inline" not in query:
                    headers["Content-Disposition"] = (
                        f'attachment; filename="Invoice-{invoice}.pdf"'
                    )
                return self.send(200, PDF, "application/pdf", headers)
            return self.send(404)

    return Handler


@pytest.fixture
def fake():
    state = FakeSite()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield state, Site(f"http://127.0.0.1:{server.server_address[1]}")
    server.shutdown()


@pytest.fixture(autouse=True)
def fast_timeouts(monkeypatch):
    monkeypatch.setattr(site_mod, "MONTH_NAV_TIMEOUT_MS", 1_500)
    monkeypatch.setattr(site_mod, "DOWNLOAD_TIMEOUT_MS", 3_000)


def _chrome() -> str | None:
    path = os.environ.get("HYPEROPTIC_BILL_TEST_CHROME")
    return path if path and Path(path).exists() else None


async def _open(tmp_path, site, *, signed_in=True):
    cm = open_profile(
        tmp_path / "profile",
        tool="hyperoptic-bill",
        headless=True,
        executable_path=_chrome(),
        require_existing=False,
    )
    try:
        browser = await cm.__aenter__()
    except Exception as exc:  # no usable Chromium here
        pytest.skip(f"Chromium unavailable: {exc}")
    if signed_in:
        await browser.context.add_cookies(
            [{"name": "session", "value": "ok", "url": site.base_url}]
        )
    return cm, browser


@pytest.fixture
async def launched(tmp_path, fake):
    state, site = fake
    cm, browser = await _open(tmp_path, site)
    yield state, site, browser
    await cm.__aexit__(None, None, None)


async def test_latest_skips_the_month_without_a_bill(launched):
    _state, site, browser = launched
    hyper = Hyperoptic(browser, site)
    hyper.start_recording()
    bill = await hyper.find_bill(None, None)
    month, year = _shift(1)
    assert (bill.invoiceId, bill.month, bill.year) == ("84623147", month, year)
    assert bill.amount == "53.00"
    assert bill.billDate == f"9 {month}, {year}"
    assert bill.warnings == []

    data, via = await hyper.download_pdf(bill)
    assert (data, via) == (PDF, "download")
    # Redacted log: no invoice ids or query strings.
    assert hyper.network.entries
    assert all("84623147" not in e["path"] for e in hyper.network.entries)


async def test_named_month_and_comma_amount(launched):
    _state, site, browser = launched
    month, year = _shift(2)
    bill = await Hyperoptic(browser, site).find_bill(month, year)
    assert (bill.invoiceId, bill.amount) == ("84500001", "1053.50")


async def test_previous_year_via_selector(launched):
    _state, site, browser = launched
    month, year = _shift(12)
    bill = await Hyperoptic(browser, site).find_bill(month, year)
    assert (bill.invoiceId, bill.month, bill.year) == ("83000001", month, year)


async def test_missing_month_is_not_found(launched):
    _state, site, browser = launched
    month, year = _shift(0)
    with pytest.raises(NotFoundError) as info:
        await Hyperoptic(browser, site).find_bill(month, year)
    assert info.value.code == "bill_not_found"


async def test_year_not_in_selector(launched):
    _state, site, browser = launched
    with pytest.raises(NotFoundError) as info:
        await Hyperoptic(browser, site).find_bill("May", 2001)
    assert info.value.code == "year_not_available"
    assert str(TODAY.year) in info.value.details["available"]


async def test_download_falls_back_to_response(launched):
    state, site, browser = launched
    state.download_mode = "fetch"
    hyper = Hyperoptic(browser, site)
    month, year = _shift(1)
    bill = await hyper.find_bill(month, year)
    data, via = await hyper.download_pdf(bill)
    assert (data, via) == (PDF, "network")


async def test_list_returns_newest_first(launched):
    _state, site, browser = launched
    bills = await Hyperoptic(browser, site).list_bills(TODAY.year)
    expected = [BILLS[key][0] for key in (_shift(1), _shift(2)) if key[1] == TODAY.year]
    assert [b.invoiceId for b in bills] == expected


async def test_signed_in_check(launched):
    _state, site, browser = launched
    hyper = Hyperoptic(browser, site)
    await hyper.goto(site.home_url)
    assert await hyper.is_signed_in()


async def test_signed_out_fails_fast_with_login_hint(tmp_path, fake):
    _state, site = fake
    cm, browser = await _open(tmp_path, site, signed_in=False)
    try:
        hyper = Hyperoptic(browser, site)
        with pytest.raises(NotLoggedInError) as info:
            await hyper.open_bills()
        assert "hyperoptic-bill login" in str(info.value)
        assert not await hyper.is_signed_in()
    finally:
        await cm.__aexit__(None, None, None)
