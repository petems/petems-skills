"""html_to_pdf and goto against a real headless Chromium. Offline."""

from __future__ import annotations

import pytest

from skill_browser.browser import open_profile
from skill_browser.errors import ApiError, NotLoggedInError
from skill_browser.nav import goto
from skill_browser.pdf import html_to_pdf, validate_pdf

pytestmark = pytest.mark.browser

HTML = """<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>h1 { font-size: 40px }</style></head>
<body><h1>Total amount paid</h1><p>%s</p></body></html>""" % ("lorem ipsum " * 400)


@pytest.fixture
async def browser(tmp_path):
    cm = open_profile(
        tmp_path / "profile", tool="demo", headless=True, require_existing=False
    )
    try:
        b = await cm.__aenter__()
    except Exception as exc:
        pytest.skip(f"Chromium unavailable: {exc}")
    yield b
    await cm.__aexit__(None, None, None)


async def test_html_to_pdf(browser):
    data = await html_to_pdf(browser, HTML)
    validate_pdf(200, "application/pdf", data, min_bytes=5_000)


async def test_goto_network_failure_is_typed(browser):
    with pytest.raises(ApiError) as info:
        await goto(
            browser.page,
            "http://127.0.0.1:9/nothing?secret=1",
            tool="demo",
            barrier=lambda url: None,
        )
    assert info.value.code == "navigation_failed"
    assert "secret" not in str(info.value)


async def test_goto_ignores_barrier_on_about_blank(browser):
    await browser.page.set_content("<p>login</p>")

    def barrier(url):
        return "sign-in page"

    # A failed navigation that leaves about:blank is not sign-in evidence.
    with pytest.raises(ApiError):
        await goto(browser.page, "http://127.0.0.1:9/", tool="demo", barrier=barrier)


def test_not_logged_in_is_exit_3():
    assert NotLoggedInError("x").exit_code == 3


async def _reopen(tmp_path, keep):
    cm = open_profile(
        tmp_path / "home" / "profile",
        tool="demo",
        headless=True,
        require_existing=False,
        keep_session_cookies=keep,
    )
    try:
        return cm, await cm.__aenter__()
    except Exception as exc:
        pytest.skip(f"Chromium unavailable: {exc}")


SESSION = {"name": "KEYCLOAK_IDENTITY", "value": "abc", "url": "https://idp.example/"}


@pytest.mark.parametrize("keep", [True, False])
async def test_session_cookies_survive_restart_only_when_kept(tmp_path, keep):
    cm, b = await _reopen(tmp_path, keep)
    await b.context.add_cookies([SESSION])  # no expiry: a session cookie
    await cm.__aexit__(None, None, None)

    saved = tmp_path / "home" / "session-cookies.json"
    assert saved.exists() is keep
    if keep:
        assert saved.stat().st_mode & 0o777 == 0o600

    cm, b = await _reopen(tmp_path, keep)
    try:
        names = [c["name"] for c in await b.context.cookies()]
        assert ("KEYCLOAK_IDENTITY" in names) is keep
    finally:
        await cm.__aexit__(None, None, None)


class _Rotator:
    """A page whose background fetch rotates a no-expiry session cookie."""

    def __init__(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import threading
        import time

        state = self
        self.issued = 0

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path == "/":
                    body = b"<script>setTimeout(() => fetch('/rotate'), 300)</script>ok"
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                else:
                    time.sleep(0.7)
                    state.issued += 1
                    body = b"{}"
                    self.send_response(200)
                    self.send_header("Set-Cookie", f"TOKEN=t{state.issued}; Path=/")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/"


async def test_saved_cookie_is_the_last_rotated_one(tmp_path):
    rot = _Rotator()
    try:
        cm, b = await _reopen(tmp_path, True)
        await b.page.goto(rot.url)
        # Close at once, while the background rotation is still in flight.
        await cm.__aexit__(None, None, None)
        assert rot.issued == 1

        cm, b = await _reopen(tmp_path, True)
        try:
            tokens = [
                c["value"] for c in await b.context.cookies() if c["name"] == "TOKEN"
            ]
            assert tokens == ["t1"]
        finally:
            await cm.__aexit__(None, None, None)
    finally:
        rot.server.shutdown()
