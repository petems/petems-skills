"""The shared CLI shape: global flags, ``login``/``install-browser``, JSON in and out.

Every tool built on this prints one JSON document on stdout on success, and a
JSON error on stderr with an exit code from :mod:`skill_browser.errors` on
failure. A traceback is never printed unless ``--verbose`` is given, because
tracebacks can carry tokens.
"""

from __future__ import annotations

import argparse
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

from skill_browser import diagnostics
from skill_browser.browser import BrowserManager, open_profile
from skill_browser.errors import (
    EXIT_UNEXPECTED,
    ApiError,
    ContractChangedError,
    PdfInvalidError,
    SkillError,
)
from skill_browser.lease import secure_mkdir

DIAGNOSTIC_ERRORS = (ContractChangedError, ApiError, PdfInvalidError)

Handler = Callable[[argparse.Namespace], Awaitable[None]]


@dataclass(frozen=True)
class Tool:
    """Identity of one skill CLI: its command name, env prefix and state directory."""

    name: str
    description: str
    env_prefix: str
    browser_locale: str = "en-GB"
    # Carry no-expiry cookies across runs (see BrowserManager). Turn on for
    # sites whose login does not survive a browser restart.
    keep_session_cookies: bool = False

    @property
    def default_home(self) -> Path:
        return Path(f"~/.{self.name}")

    def env(self, suffix: str) -> str | None:
        return os.environ.get(f"{self.env_prefix}_{suffix}") or None


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, default=str), flush=True)


def _env_flag(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


def build_parser(tool: Tool) -> tuple[argparse.ArgumentParser, Any]:
    """The parser with global flags plus ``login`` and ``install-browser``.

    Returns ``(parser, subparsers)`` so the tool can add its own commands.
    """
    parser = argparse.ArgumentParser(prog=tool.name, description=tool.description)
    parser.add_argument(
        "--home",
        type=Path,
        default=Path(tool.env("HOME") or tool.default_home),
        help=f"state directory (default {tool.default_home}; env {tool.env_prefix}_HOME)",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        default=_env_flag(tool.env("HEADLESS")),
        help=f"run without a window (env {tool.env_prefix}_HEADLESS=1). login is always headed",
    )
    parser.add_argument(
        "--chrome-path",
        default=tool.env("CHROME_PATH"),
        help="use this Chromium binary instead of patchright's",
    )
    parser.add_argument(
        "--diagnostic-screenshot",
        action="store_true",
        default=_env_flag(tool.env("DIAGNOSTIC_SCREENSHOT")),
        help=(
            "on a site-change, API or PDF error, also save a screenshot of the "
            "page (it can show personal details; off by default; "
            f"env {tool.env_prefix}_DIAGNOSTIC_SCREENSHOT=1)"
        ),
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    login = sub.add_parser("login", help="sign in yourself in a visible browser window")
    login.add_argument(
        "--timeout",
        type=float,
        default=900,
        help="seconds to wait for sign-in; 0 = no limit",
    )
    sub.add_parser("install-browser", help="download patchright's Chromium")
    return parser, sub


def add_output_args(command: argparse.ArgumentParser) -> None:
    command.add_argument(
        "--out", default="~/Desktop", help="output directory (default ~/Desktop)"
    )
    command.add_argument(
        "--overwrite",
        action="store_true",
        help="replace an existing file of the same name (default: refuse, exit 10)",
    )


@asynccontextmanager
async def session(
    tool: Tool,
    args: argparse.Namespace,
    *,
    require_existing: bool = True,
    headless: bool | None = None,
) -> AsyncIterator[BrowserManager]:
    """The tool's dedicated profile, leased for the block's whole life."""
    async with open_profile(
        args.profile,
        tool=tool.name,
        headless=args.headless if headless is None else headless,
        executable_path=args.chrome_path,
        require_existing=require_existing,
        locale=tool.browser_locale,
        keep_session_cookies=tool.keep_session_cookies,
    ) as browser:
        yield browser


@asynccontextmanager
async def diagnose_on_error(
    tool: Tool,
    args: argparse.Namespace,
    page_source: Callable[[], Any],
    network: diagnostics.NetworkLog | None,
    *,
    redact: Callable[[str], str] = diagnostics.redact_ids,
    screenshot: bool = True,
) -> AsyncIterator[None]:
    """On a contract, API or PDF error, save diagnostics and list them in ``details``.

    The redacted request log is always written. A screenshot is taken only
    when the user passed ``--diagnostic-screenshot``, because signed-in pages
    show names, account numbers and addresses. Pass ``screenshot=False`` for
    a tool whose pages should never be captured, even on request.
    """
    try:
        yield
    except DIAGNOSTIC_ERRORS as exc:
        try:
            exc.details["diagnostics"] = await diagnostics.capture(
                page_source(),
                args.home / "diagnostics",
                tool=tool.name,
                error=exc,
                network=network,
                redact=redact,
                screenshot=screenshot
                and bool(getattr(args, "diagnostic_screenshot", False)),
            )
        except Exception:
            logging.getLogger(__name__).debug("Diagnostics failed", exc_info=True)
        raise


def install_browser() -> int:
    """Install the Chromium build that matches this patchright version."""
    return subprocess.call([sys.executable, "-m", "patchright", "install", "chromium"])


def run(
    tool: Tool,
    parser: argparse.ArgumentParser,
    handlers: dict[str, Handler],
    argv: list[str] | None = None,
    *,
    validate: Callable[[argparse.Namespace, argparse.ArgumentParser], None]
    | None = None,
) -> int:
    """Parse, dispatch to ``handlers[command]``, and map errors to exit codes."""
    import asyncio

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    args.home = args.home.expanduser()
    args.profile = args.home / "profile"

    if args.command == "install-browser":
        return install_browser()
    if validate:
        validate(args, parser)
    secure_mkdir(args.home)

    try:
        asyncio.run(handlers[args.command](args))
    except SkillError as exc:
        print(json.dumps(exc.as_dict(), indent=2, default=str), file=sys.stderr)
        return exc.exit_code
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # last resort: never print a traceback with tokens in it
        print(
            json.dumps(
                {
                    "error": "unexpected",
                    "message": type(exc).__name__,
                    "exit_code": EXIT_UNEXPECTED,
                }
            ),
            file=sys.stderr,
        )
        if args.verbose:
            raise
        return EXIT_UNEXPECTED
    return 0
