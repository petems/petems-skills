"""Files, PDF checks, redaction, the login loop and the CLI runner."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

from skill_browser import cli, diagnostics, login
from skill_browser.errors import (
    EXIT_NOT_FOUND,
    EXIT_OUTPUT_EXISTS,
    LoginTimeoutError,
    NotFoundError,
    OutputExistsError,
    PdfInvalidError,
    SkillError,
)
from skill_browser.files import safe_component, write_private_atomic
from skill_browser.pdf import validate_pdf

GOOD = b"%PDF-1.7\n" + b"0" * 2000


# -- files -------------------------------------------------------------------


def test_write_private_atomic_creates_0600(tmp_path):
    path = tmp_path / "out" / "bill.pdf"
    write_private_atomic(path, b"data")
    assert path.read_bytes() == b"data"
    assert (path.stat().st_mode & 0o777) == 0o600
    assert [p.name for p in path.parent.iterdir()] == ["bill.pdf"]  # no temp left


def test_write_private_atomic_refuses_existing(tmp_path):
    path = tmp_path / "bill.pdf"
    path.write_bytes(b"old")
    with pytest.raises(OutputExistsError) as info:
        write_private_atomic(path, b"new")
    assert info.value.exit_code == EXIT_OUTPUT_EXISTS
    assert path.read_bytes() == b"old"
    assert [p.name for p in tmp_path.iterdir()] == ["bill.pdf"]


def test_write_private_atomic_overwrite(tmp_path):
    path = tmp_path / "bill.pdf"
    path.write_bytes(b"old")
    write_private_atomic(path, b"new", overwrite=True)
    assert path.read_bytes() == b"new"


@pytest.mark.parametrize(
    ("raw", "safe"),
    [("March", "March"), ("45.00", "45.00"), ("a/b", "a_b"), ("$(x)", "x"), ("", "_")],
)
def test_safe_component(raw, safe):
    assert safe_component(raw) == safe


# -- pdf ---------------------------------------------------------------------


def test_validate_pdf_ok():
    validate_pdf(200, "application/pdf; charset=binary", GOOD, min_bytes=1000)


@pytest.mark.parametrize(
    ("status", "ctype", "body", "code"),
    [
        (302, "text/html", b"", "pdf_status:302"),
        (200, "text/html", b"<html>", "pdf_content_type:text/html"),
        (200, "", GOOD, "pdf_content_type:none"),
        (200, "application/pdf", b"<html>" + b"0" * 2000, "pdf_not_pdf"),
        (200, "application/pdf", b"%PDF-1.7", "pdf_too_small"),
    ],
)
def test_validate_pdf_rejects(status, ctype, body, code):
    with pytest.raises(PdfInvalidError) as info:
        validate_pdf(status, ctype, body, min_bytes=1000)
    assert info.value.code == code


def test_validate_pdf_cap():
    with pytest.raises(PdfInvalidError) as info:
        validate_pdf(200, "application/pdf", GOOD, min_bytes=1, max_bytes=100)
    assert info.value.code == "pdf_too_large"


def test_validate_pdf_can_skip_content_type():
    validate_pdf(200, "", GOOD, min_bytes=1000, check_content_type=False)


# -- redaction ---------------------------------------------------------------


def test_redact_ids_drops_query_and_ids():
    url = "https://x.example/billing/84623147/pdf?token=abc#frag"
    assert diagnostics.redact_ids(url) == "/billing/<id>/pdf"
    hexid = "https://x.example/invoices/0123456789abcdef0123456789abcdef"
    assert diagnostics.redact_ids(hexid) == "/invoices/<id>"


def test_redact_headers():
    out = diagnostics.redact_headers(
        {"Authorization": "Bearer x", "set-cookie": "a=b", "content-type": "a/b"}
    )
    assert out == {
        "Authorization": "<redacted>",
        "set-cookie": "<redacted>",
        "content-type": "a/b",
    }


def test_network_log_filters_and_redacts():
    log = diagnostics.NetworkLog(match=lambda url: "/api/" in url)
    log.add("GET", "https://x/api/customer/1234567?x=1", 200, {"cookie": "s"}, "page")
    log.add("GET", "https://x/static/app.js", 200, {}, "page")
    assert log.entries == [
        {
            "via": "page",
            "method": "GET",
            "path": "/api/customer/<id>",
            "status": 200,
            "headers": {"cookie": "<redacted>"},
        }
    ]


# -- login loop --------------------------------------------------------------


class FakePage:
    url = "https://idp.example/login"


async def test_login_needs_stable_polls():
    answers = iter([True, False, True, True, True])
    calls = 0

    async def check():
        nonlocal calls
        calls += 1
        return next(answers)

    await login.wait_for_manual_login(
        FakePage(), check, tool="demo", timeout_seconds=5, poll_seconds=0
    )
    assert calls == 5


async def test_login_times_out():
    async def check():
        return False

    with pytest.raises(LoginTimeoutError) as info:
        await login.wait_for_manual_login(
            FakePage(), check, tool="demo", timeout_seconds=0.05, poll_seconds=0.01
        )
    assert "demo login" in str(info.value)


async def test_login_poll_swallows_errors_but_not_closed_window():
    async def flaky():
        raise RuntimeError("execution context destroyed")

    assert await login.poll_signed_in(flaky) is False

    async def closed():
        raise SkillError("gone", code="browser_closed")

    with pytest.raises(SkillError):
        await login.poll_signed_in(closed)


# -- cli runner --------------------------------------------------------------

TOOL = cli.Tool(name="demo-tool", description="demo", env_prefix="DEMO_TOOL")


def _parser():
    parser, sub = cli.build_parser(TOOL)
    get = sub.add_parser("get")
    cli.add_output_args(get)
    return parser


def test_run_success_prints_json(tmp_path, capsys):
    async def get(args):
        cli.emit({"ok": True, "out": args.out, "overwrite": args.overwrite})

    code = cli.run(TOOL, _parser(), {"get": get}, ["--home", str(tmp_path), "get"])
    assert code == 0
    assert json.loads(capsys.readouterr().out) == {
        "ok": True,
        "out": "~/Desktop",
        "overwrite": False,
    }
    assert (tmp_path.stat().st_mode & 0o777) == 0o700


def test_run_maps_errors_to_exit_codes(tmp_path, capsys):
    async def get(_args):
        raise NotFoundError("nope", code="bill_not_found", available=["May 2026"])

    code = cli.run(TOOL, _parser(), {"get": get}, ["--home", str(tmp_path), "get"])
    assert code == EXIT_NOT_FOUND
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "bill_not_found"
    assert err["details"] == {"available": ["May 2026"]}


def test_run_hides_unexpected_tracebacks(tmp_path, capsys):
    async def get(_args):
        raise ValueError("secret-token-123")

    code = cli.run(TOOL, _parser(), {"get": get}, ["--home", str(tmp_path), "get"])
    assert code == 1
    captured = capsys.readouterr()
    assert "secret-token-123" not in captured.err + captured.out


def test_env_prefix_drives_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("DEMO_TOOL_HOME", str(tmp_path / "h"))
    monkeypatch.setenv("DEMO_TOOL_HEADLESS", "1")
    args = _parser().parse_args(["get"])
    assert args.home == Path(tmp_path / "h")
    assert args.headless is True


async def test_diagnose_on_error_attaches_paths(tmp_path):
    class Page:
        url = "https://x.example/account/1234567?code=secret"

        async def screenshot(self, path):
            Path(path).write_bytes(b"png")

    args = _parser().parse_args(["--home", str(tmp_path), "get"])
    args.home = tmp_path
    with pytest.raises(PdfInvalidError) as info:
        async with cli.diagnose_on_error(TOOL, args, lambda: Page(), None):
            raise PdfInvalidError("bad", code="pdf_not_pdf")
    paths = info.value.details["diagnostics"]
    log = json.loads(Path(paths["network_log"]).read_text())
    assert log == {"error": "pdf_not_pdf", "page": "/account/<id>", "requests": []}
    assert os.stat(paths["screenshot"]).st_mode & 0o777 == 0o600


async def test_diagnose_on_error_ignores_other_errors(tmp_path):
    args = _parser().parse_args(["--home", str(tmp_path), "get"])
    args.home = tmp_path
    with pytest.raises(NotFoundError) as info:
        async with cli.diagnose_on_error(TOOL, args, lambda: None, None):
            raise NotFoundError("x")
    assert "diagnostics" not in info.value.details
    assert not (tmp_path / "diagnostics").exists()


def test_asyncio_not_leaking_loops():
    asyncio.run(asyncio.sleep(0))


async def test_wait_off_barrier_tolerates_a_bounce():
    from skill_browser.nav import wait_off_barrier

    class Page:
        url = "https://idp.example/auth"

    page = Page()

    async def come_back():
        await asyncio.sleep(0.1)
        page.url = "https://account.example/bills"

    def barrier(url):
        return "off-site" if "idp" in url else None

    task = asyncio.create_task(come_back())
    assert await wait_off_barrier(page, barrier, timeout=2, poll=0.02) is None
    await task

    page.url = "https://idp.example/auth"
    assert await wait_off_barrier(page, barrier, timeout=0.1, poll=0.02) == "off-site"
