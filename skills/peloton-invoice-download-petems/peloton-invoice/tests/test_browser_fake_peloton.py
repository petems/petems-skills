"""End to end against a local fake of the Peloton account site, in a real Chromium.

Exercises what unit tests cannot: the localStorage token read, the in-page
GraphQL fetch with the token passed as an argument, the client-side rendered
receipt, the sanitising capture (tracker script, fides-* body class, inline
handlers) and the headless print. No Peloton page is loaded.

The fake serves the account site on 127.0.0.1 and the "Auth0" sign-in page on
localhost, so the two are different hosts. Set PELOTON_INVOICE_TEST_CHROME to a
Chromium binary if patchright's own is not installed; the tests are skipped
when neither is usable.
"""

from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import time

import pytest
from skill_browser.browser import open_profile
from skill_browser.errors import ApiError, ContractChangedError, NotLoggedInError
from skill_browser.pdf import html_to_pdf, validate_pdf

from peloton_invoice import account as account_mod
from peloton_invoice import cli as cli_mod
from peloton_invoice.account import PelotonAccount, Site
from peloton_invoice.cli import PDF_MIN_BYTES

pytestmark = pytest.mark.browser

TOKEN = "eyJfake" + "t" * 40
SUB1 = "11111111-1111-4111-8111-111111111111"
SUB2 = "22222222-2222-4222-8222-222222222222"
OCT = "0123456789abcdef0123456789abcdef"
SEP = "fedcba9876543210fedcba9876543210"
MAR24 = "aaaaaaaabbbbbbbbccccccccdddddddd"
NEVER = "99999999999999999999999999999999"

MEMBERSHIP_HTML = """<!doctype html><html><body><div id="app">Loading</div><script>
localStorage.setItem('@@auth0spajs@@::stale::https://api.onepeloton.com/::openid',
  JSON.stringify({body: {access_token: 'eyJstale' + 'x'.repeat(40)}, expiresAt: 1}));
localStorage.setItem('@@auth0spajs@@::client::https://api.onepeloton.com/::openid profile',
  JSON.stringify({body: {access_token: '%(token)s'}, expiresAt: Date.now() / 1000 + 3600}));
setTimeout(() => { document.getElementById('app').innerText = 'Memberships on file'; }, 300);
</script></body></html>"""

LOREM = " ".join(
    f"Line {i}: subtotal, tax, discount and payment details." for i in range(250)
)

RECEIPT_HTML = """<!doctype html><html><head>
<style>body { font-family: serif } h1 { font-size: 28px }</style>
<script src="/tracker.js"></script>
</head><body class="fides-overlay-modal-link-shown">
<div id="fides-overlay">We use cookies</div>
<a href="javascript:alert(1)" onclick="alert(2)">Print</a>
<main id="receipt">Loading</main>
<script>
setTimeout(() => {
  document.getElementById('receipt').innerHTML =
    '<h1>Peloton Interactive UK Limited</h1><p>VAT ID Number GB123456789</p>' +
    '<p onmouseover="steal()">Payment date %(date)s</p><p>Total £%(amount)s</p>' +
    '<p>Total amount paid</p><p>%(lorem)s</p>';
}, 300);
</script></body></html>"""

INVOICES = {
    SUB1: [
        (OCT, "2026-10-07T19:10:49.000Z", 4500, "07/10/2026", "45.00"),
        (SEP, "2026-09-07T19:10:49.000Z", 4500, "07/09/2026", "45.00"),
    ],
    SUB2: [(MAR24, "2024-03-07T19:10:49.000Z", 3900, "07/03/2024", "39.00")],
}


class FakePeloton:
    def __init__(self) -> None:
        self.graphql_auth: list[str | None] = []
        self.tracker_hits = 0
        self.wrong_amount = False
        self.port = 0

    @property
    def site(self) -> Site:
        base = f"http://127.0.0.1:{self.port}"
        return Site(
            entry_url=f"{base}/mymembership",
            account_base=base,
            graphql_url=f"{base}/graphql",
            auth_host="localhost",
            members_host="members.invalid",
            api_hosts=("127.0.0.1",),
        )


def make_handler(state: FakePeloton):
    receipts = {
        f"/en-GB/mymembership/v2/subscriptions/{sid}/invoices/{iid}": (date, amount)
        for sid, rows in INVOICES.items()
        for iid, _paid, _cents, date, amount in rows
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def signed_in(self) -> bool:
            return self.headers.get("Host", "").startswith("127.0.0.1") and (
                "session=ok" in (self.headers.get("Cookie") or "")
            )

        def send(self, status, body=b"", ctype="text/html", headers=None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/login":
                return self.send(
                    200, b"<form><input type=password></form>Membership Terms"
                )
            if path == "/tracker.js":
                state.tracker_hits += 1
                return self.send(200, b"window.__tracked = 1;", "text/javascript")
            if not self.signed_in():
                return self.send(
                    302, headers={"Location": f"http://localhost:{state.port}/login"}
                )
            if path == "/mymembership":
                return self.send(302, headers={"Location": "/en-GB/mymembership"})
            if path == "/en-GB/mymembership":
                return self.send(200, (MEMBERSHIP_HTML % {"token": TOKEN}).encode())
            if path.endswith(f"/invoices/{NEVER}"):
                return self.send(200, b"<html><body>Something went wrong</body></html>")
            if path in receipts:
                date, amount = receipts[path]
                if state.wrong_amount:
                    amount = "1.00"
                html = RECEIPT_HTML % {"date": date, "amount": amount, "lorem": LOREM}
                return self.send(200, html.encode())
            return self.send(404)

        def do_POST(self):
            if self.path != "/graphql":
                return self.send(404)
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            auth = self.headers.get("authorization")
            state.graphql_auth.append(auth)
            if auth != f"Bearer {TOKEN}":
                return self.send(401, b"{}", "application/json")
            if body["operationName"] == "Subs":
                assert body["variables"]["input"]["country"] == "GB"
                subs = [
                    {
                        "id": SUB2,
                        "isActive": False,
                        "status": "Cancelled",
                        "billingStrategy": "AutoDebit",
                    },
                    {
                        "id": "33333333-3333-4333-8333-333333333333",
                        "isActive": False,
                        "status": "Discontinued",
                        "billingStrategy": "NotBilled",
                    },
                    {
                        "id": SUB1,
                        "isActive": True,
                        "status": "Active",
                        "billingStrategy": "AutoDebit",
                    },
                ]
                data = {"subPelotonMember": {"subscriptions": subs}}
            else:
                sid = body["variables"]["input"]["subscriptionId"]
                data = {
                    "subPelotonSubscription": {
                        "id": sid,
                        "pastInvoices": [
                            {
                                "id": iid,
                                "createdAt": paid,
                                "invoicePayments": [{"paymentDate": paid}],
                                "billingSummary": {
                                    "totalAmount": {
                                        "currencyCode": "GBP",
                                        "centAmount": cents,
                                    },
                                    "tax": {"centAmount": cents // 6},
                                },
                            }
                            for iid, paid, cents, _date, _amount in INVOICES.get(
                                sid, []
                            )
                        ],
                    }
                }
            return self.send(
                200, json.dumps({"data": data}).encode(), "application/json"
            )

    return Handler


@pytest.fixture
def fake():
    state = FakePeloton()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state))
    state.port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield state
    server.shutdown()


def _chrome() -> str | None:
    path = os.environ.get("PELOTON_INVOICE_TEST_CHROME")
    return path if path and Path(path).exists() else None


def _cookie(state: FakePeloton) -> dict:
    return {
        "name": "session",
        "value": "ok",
        "url": state.site.account_base,
        "expires": time.time() + 3600,
    }


async def _open(tmp_path, state, *, signed_in=True):
    cm = open_profile(
        tmp_path / "profile",
        tool="peloton-invoice",
        headless=True,
        executable_path=_chrome(),
        require_existing=False,
    )
    browser = await cm.__aenter__()
    if signed_in:
        await browser.context.add_cookies([_cookie(state)])
    return cm, browser


@pytest.fixture
async def launched(tmp_path, fake):
    try:
        cm, browser = await _open(tmp_path, fake)
    except Exception as exc:  # no usable Chromium here
        pytest.skip(f"Chromium unavailable: {exc}")
    yield fake, browser
    await cm.__aexit__(None, None, None)


async def test_session_token_and_history(launched):
    state, browser = launched
    account = PelotonAccount(browser, state.site)
    account.start_recording()
    locale = await account.open_membership()
    assert locale == "en-GB"
    token = await account.token()
    assert token == TOKEN  # the stale entry was skipped
    subs = await account.subscriptions(token, locale)
    assert {s.id for s in subs} >= {SUB1, SUB2}
    invoices = await account.invoices(token, subs[-1])
    assert [i.id for i in invoices] == [OCT, SEP]
    assert state.graphql_auth == [f"Bearer {TOKEN}"] * 2
    # Redacted log: no token, no auth header value.
    dumped = json.dumps(account.network.entries)
    assert TOKEN not in dumped
    assert any(e["path"] == "/graphql" for e in account.network.entries)


async def test_receipt_capture_is_sanitised_and_prints(launched):
    state, browser = launched
    account = PelotonAccount(browser, state.site)
    locale = await account.open_membership()
    token = await account.token()
    sub1 = next(s for s in await account.subscriptions(token, locale) if s.id == SUB1)
    october = (await account.invoices(token, sub1))[0]
    pages_before = len(browser.context.pages)

    html = await account.receipt_html(locale, october)
    assert len(browser.context.pages) == pages_before  # receipt tab closed
    lowered = html.lower()
    for banned in (
        "<script",
        "onclick",
        "onmouseover",
        "javascript:",
        'fides-overlay"',
        "tracker.js",
    ):
        assert banned not in lowered, banned
    # The fides-* class on <body> must not take the receipt with it.
    assert "Total amount paid" in html and "fides-overlay-modal-link-shown" in html
    assert "Content-Security-Policy" in html and "script-src 'none'" in html

    hits = state.tracker_hits
    data = await html_to_pdf(browser, html)
    validate_pdf(200, "", data, min_bytes=PDF_MIN_BYTES, check_content_type=False)
    assert state.tracker_hits == hits  # the offline copy fetched nothing


async def test_receipt_mismatch(launched):
    state, browser = launched
    state.wrong_amount = True
    account = PelotonAccount(browser, state.site)
    locale = await account.open_membership()
    token = await account.token()
    sub1 = next(s for s in await account.subscriptions(token, locale) if s.id == SUB1)
    with pytest.raises(ContractChangedError) as info:
        await account.receipt_html(locale, (await account.invoices(token, sub1))[0])
    assert info.value.code == "receipt_mismatch"
    assert info.value.details["failed"] == ["hasAmount"]


async def test_receipt_not_rendered(launched, monkeypatch):
    state, browser = launched
    monkeypatch.setattr(account_mod, "RECEIPT_TIMEOUT_SECONDS", 1.0)
    account = PelotonAccount(browser, state.site)
    locale = await account.open_membership()
    token = await account.token()
    sub1 = next(s for s in await account.subscriptions(token, locale) if s.id == SUB1)
    october = (await account.invoices(token, sub1))[0]
    from dataclasses import replace

    with pytest.raises(ApiError) as info:
        await account.receipt_html(locale, replace(october, id=NEVER))
    assert info.value.code == "receipt_not_rendered"


async def test_signed_out_fails_fast_with_login_hint(tmp_path, fake):
    try:
        cm, browser = await _open(tmp_path, fake, signed_in=False)
    except Exception as exc:
        pytest.skip(f"Chromium unavailable: {exc}")
    try:
        started = time.monotonic()
        account = PelotonAccount(browser, fake.site)
        with pytest.raises(NotLoggedInError) as info:
            await account.open_membership()
        assert info.value.code == "redirected_to_sign_in"
        assert "peloton-invoice login" in str(info.value)
        assert time.monotonic() - started < 10
        assert await account.is_signed_in() is False
    finally:
        await cm.__aexit__(None, None, None)


def test_cli_download_end_to_end(tmp_path, fake, monkeypatch, capsys):
    """The real CLI: latest, a month on the cancelled subscription, then refusal."""
    home = tmp_path / "home"

    async def seed_profile():
        cm = open_profile(
            home / "profile",
            tool="peloton-invoice",
            headless=True,
            executable_path=_chrome(),
            require_existing=False,
        )
        browser = await cm.__aenter__()
        await browser.context.add_cookies([_cookie(fake)])
        await cm.__aexit__(None, None, None)

    try:
        asyncio.run(seed_profile())
    except Exception as exc:
        pytest.skip(f"Chromium unavailable: {exc}")
    monkeypatch.setattr(cli_mod, "make_site", lambda: fake.site)
    out = tmp_path / "out"
    base = ["--home", str(home), "--headless"]
    if _chrome():
        base += ["--chrome-path", _chrome()]

    assert cli_mod.main([*base, "download", "--latest", "--out", str(out)]) == 0
    result = json.loads(capsys.readouterr().out)
    assert Path(result["path"]).name == "Peloton_Invoice_October_2026_GBP45.00.pdf"
    assert result["subscriptionId"] == SUB1 and result["warnings"] == []
    assert Path(result["path"]).read_bytes().startswith(b"%PDF-")
    assert TOKEN not in json.dumps(result)

    code = cli_mod.main(
        [*base, "download", "--month", "mar", "--year", "2024", "--out", str(out)]
    )
    assert code == 0
    result = json.loads(capsys.readouterr().out)
    assert Path(result["path"]).name == "Peloton_Invoice_March_2024_GBP39.00.pdf"
    assert result["subscriptionId"] == SUB2

    assert cli_mod.main([*base, "download", "--latest", "--out", str(out)]) == 10
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "output_exists"

    assert cli_mod.main([*base, "download", "--month", "jan", "--year", "2019"]) == 6
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "bill_not_found"
    assert len(err["details"]["available"]) == 3
