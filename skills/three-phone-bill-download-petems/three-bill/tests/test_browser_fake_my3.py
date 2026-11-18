"""End to end against a local fake of My3, in a real Chromium.

Exercises the parts unit tests cannot: the response listener, ``evaluate`` with
a real argument, ``context.request`` sharing the profile's cookies, the token
rotation, and the in-page PDF fallback. No Three page is loaded.

Set THREE_BILL_TEST_CHROME to a Chromium binary if patchright's own is not
installed; the test is skipped when neither is usable.
"""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import time

import pytest
from skill_browser.browser import open_profile
from skill_browser.errors import NotLoggedInError

from three_bill import my3 as my3_mod
from three_bill.my3 import My3, Site

pytestmark = pytest.mark.browser

CUID = "949613941"
PDF = b"%PDF-1.7\n" + b"0" * 150_000 + b"\n%%EOF\n"

ACCOUNT_HTML = """<!doctype html><html><body><h1>Dashboard shell</h1><script>
sessionStorage.setItem('persist:customerProfilePersistor',
  JSON.stringify({customerId: JSON.stringify('%(cuid)s')}));
%(seed_call)s
</script></body></html>"""

SEED_CALL = (
    f"fetch('/rp-server-b2c/care/v1/B2C/customer/{CUID}?salesChannel=selfService"
    "&initId=Digital&levelOfData=owningIndividual,financialAccount', {credentials: 'include'});"
)


class FakeMy3:
    def __init__(self) -> None:
        self.spa_calls_seed = True
        # Reproduce a restart: /account's guard needs sessionStorage, which is
        # rebuilt via /customer-login -> silent /authorize on another host ->
        # /customer-logged -> /account (live, 2026-11-17).
        self.needs_recovery = False
        self.auth_form = False  # the silent /authorize shows the Auth0 form
        self.guard_delay_ms = 1200  # /account shows, then its guard redirects
        self.port = 0
        self.pdf_requires_page = False  # reject requests without sec-fetch-mode
        self.tokens = iter(f"tok{i}" for i in range(1000))
        self.valid: set[str] = set()
        self.log: list[tuple[str, str | None]] = []

    def issue(self) -> str:
        token = next(self.tokens)
        self.valid.add(token)
        return token

    def spend(self, token: str | None) -> bool:
        if token in self.valid:
            self.valid.discard(token)
            return True
        return False


def make_handler(state: FakeMy3):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def signed_in(self) -> bool:
            return "session=ok" in (self.headers.get("Cookie") or "")

        def send(self, status, body=b"", ctype="application/json", headers=None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?")[0]
            state.log.append((path, self.headers.get("authorization")))
            if path == "/authorize":  # served as "localhost": another host
                if state.auth_form:
                    return self.send(302, headers={"Location": "/u/login"})
                return self.send(
                    302,
                    headers={
                        "Location": f"http://127.0.0.1:{state.port}/customer-logged"
                    },
                )
            if path == "/u/login":
                return self.send(200, b"<form>Auth0</form>", "text/html")
            if path == "/customer-logged" and state.needs_recovery:
                html = (
                    "<script>sessionStorage.setItem('recovered', '1');"
                    "setTimeout(() => location.replace('/account'), 300);</script>"
                )
                return self.send(200, html.encode(), "text/html")
            if path == "/customer-login" and state.needs_recovery and self.signed_in():
                html = (
                    "<script>location.replace("
                    f"'http://localhost:{state.port}/authorize');</script>"
                )
                return self.send(200, html.encode(), "text/html")
            if path == "/account":
                if not self.signed_in():
                    return self.send(302, headers={"Location": "/customer-login"})
                if state.needs_recovery:
                    # Live, /account renders briefly and then its guard
                    # redirects; mimic both an early and a late redirect.
                    guard = (
                        "<head><script>if (!sessionStorage.getItem('recovered'))"
                        " setTimeout(() => location.replace('/customer-login'),"
                        f" {state.guard_delay_ms});</script></head>"
                    )
                    html = guard + ACCOUNT_HTML % {
                        "cuid": CUID,
                        "seed_call": SEED_CALL if state.spa_calls_seed else "",
                    }
                    return self.send(200, html.encode(), "text/html")
                html = ACCOUNT_HTML % {
                    "cuid": CUID,
                    "seed_call": SEED_CALL if state.spa_calls_seed else "",
                }
                return self.send(200, html.encode(), "text/html")
            if path == "/customer-login":
                return self.send(
                    200, b"<form><input type=password></form>", "text/html"
                )
            if path == "/rp-server-b2c/authentication/v1/B2C/user":
                return self.send(
                    200, json.dumps({"isAnonymous": not self.signed_in()}).encode()
                )
            if not self.signed_in():
                return self.send(401)
            if path == f"/rp-server-b2c/care/v1/B2C/customer/{CUID}":
                body = {"customer": {"id": CUID, "financialAccount": [{"id": CUID}]}}
                return self.send(
                    200,
                    json.dumps(body).encode(),
                    headers={"uxfauthorization": state.issue()},
                )
            if (
                path
                == f"/rp-server-b2c/ebill/v1/customer/{CUID}/billing-arrangement/{CUID}/bill"
            ):
                if not state.spend(self.headers.get("authorization")):
                    return self.send(401)
                bills = {
                    "bills": [
                        {
                            "month": 5,
                            "data": {
                                "billNumber": "116",
                                "billAmount": 33.08,
                                "billPeriod": 5,
                                "billCloseDate": "2026-07-24T00:00:00Z",
                                "billStartDate": "2026-06-24T00:00:00Z",
                                "billEndDate": "2026-07-23T00:00:00Z",
                            },
                        }
                    ]
                }
                return self.send(
                    200,
                    json.dumps(bills).encode(),
                    headers={"uxfauthorization": state.issue()},
                )
            if (
                path
                == f"/rp-server-b2c/care/v1/customer/{CUID}/billing-arrangement/{CUID}/bill/116/pdf"
            ):
                if state.pdf_requires_page and not self.headers.get("sec-fetch-mode"):
                    return self.send(302, headers={"Location": "/customer-login"})
                if not state.spend(self.headers.get("authorization")):
                    return self.send(401)
                return self.send(
                    200,
                    PDF,
                    "application/pdf",
                    headers={"uxfauthorization": state.issue()},
                )
            return self.send(404)

    return Handler


@pytest.fixture
def fake():
    state = FakeMy3()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state.port = server.server_address[1]
    yield state, Site(f"http://127.0.0.1:{server.server_address[1]}")
    server.shutdown()


def _chrome() -> str | None:
    path = os.environ.get("THREE_BILL_TEST_CHROME")
    return path if path and Path(path).exists() else None


async def _open(tmp_path, site, *, signed_in=True):
    cm = open_profile(
        tmp_path / "profile",
        tool="three-bill",
        headless=True,
        executable_path=_chrome(),
        require_existing=False,
    )
    browser = await cm.__aenter__()
    if signed_in:
        await browser.context.add_cookies(
            [{"name": "session", "value": "ok", "url": site.base_url}]
        )
    return cm, browser


@pytest.fixture
async def launched(tmp_path, fake):
    state, site = fake
    try:
        cm, browser = await _open(tmp_path, site)
    except Exception as exc:  # no usable Chromium here
        pytest.skip(f"Chromium unavailable: {exc}")
    yield state, site, browser
    await cm.__aexit__(None, None, None)


async def test_full_flow_via_context_request(launched):
    _state, site, browser = launched
    my3 = My3(browser, site)
    my3.start_recording()
    account = await my3.open_account()
    assert account.cuid == CUID
    assert account.source == "spa_seed_response"

    bill_id, token = await my3.seed(account.cuid)
    bills, token = await my3.list_bills(account.cuid, bill_id, token)
    assert [(b.month, b.year) for b in bills] == [("July", 2026)]
    data, _ = await my3.download_pdf(account.cuid, bill_id, bills[0].billNumber, token)
    assert data == PDF

    # Redacted log: no ids, no tokens.
    dumped = json.dumps(my3.network.entries)
    assert CUID not in dumped and "tok" not in dumped
    assert any(e["via"] == "context.request" for e in my3.network.entries)


async def test_pdf_falls_back_to_page_fetch(launched):
    state, site, browser = launched
    state.pdf_requires_page = True
    my3 = My3(browser, site)
    account = await my3.open_account()
    bill_id, token = await my3.seed(account.cuid)
    _bills, token = await my3.list_bills(account.cuid, bill_id, token)
    data, _ = await my3.download_pdf(account.cuid, bill_id, "116", token)
    assert data == PDF


async def test_session_storage_fallback(launched, monkeypatch):
    state, site, browser = launched
    state.spa_calls_seed = False
    monkeypatch.setattr(my3_mod, "SEED_CAPTURE_TIMEOUT_SECONDS", 1.0)
    account = await My3(browser, site).open_account()
    assert (account.cuid, account.source) == (CUID, "session_storage")


async def test_signed_out_fails_fast_with_login_hint(tmp_path, fake):
    _state, site = fake
    try:
        cm, browser = await _open(tmp_path, site, signed_in=False)
    except Exception as exc:
        pytest.skip(f"Chromium unavailable: {exc}")
    try:
        started = time.monotonic()
        with pytest.raises(NotLoggedInError) as info:
            await My3(browser, site).open_account()
        assert "three-bill login" in str(info.value)
        assert time.monotonic() - started < 10
    finally:
        await cm.__aexit__(None, None, None)


@pytest.mark.parametrize("guard_delay_ms", [0, 1200])
async def test_recovers_like_the_live_spa_after_a_restart(launched, guard_delay_ms):
    state, site, browser = launched
    state.needs_recovery = True
    state.guard_delay_ms = guard_delay_ms
    account = await My3(browser, site).open_account()
    assert account.cuid == CUID


async def test_auth0_form_during_recovery_fails_fast(launched):
    state, site, browser = launched
    state.needs_recovery = True
    state.auth_form = True
    started = time.monotonic()
    with pytest.raises(NotLoggedInError) as info:
        await My3(browser, site).open_account()
    assert info.value.code == "sign_in_required"
    assert time.monotonic() - started < 10
