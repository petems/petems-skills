"""``three-bill``: list and download Three UK bills from a dedicated browser profile.

stdout carries one JSON document on success. Errors go to stderr as JSON, with
an exit code per failure class (see :mod:`three_bill.errors`).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

from three_bill import contract
from three_bill.browser import open_profile
from three_bill.errors import (
    EXIT_UNEXPECTED,
    ApiError,
    ContractChangedError,
    PdfInvalidError,
    ThreeBillError,
)
from three_bill.lease import secure_mkdir
from three_bill.my3 import My3, Site

DEFAULT_HOME = Path("~/.three-bill")
DIAGNOSTIC_ERRORS = (ContractChangedError, ApiError, PdfInvalidError)


def _emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2), flush=True)


def write_private_atomic(path: Path, data: bytes) -> None:
    """Write via a temp file in the same directory, mode 0600, then replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        tmp.replace(path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


async def _with_account(args: argparse.Namespace, work: Any) -> None:
    """Open the profile, confirm the session, run *work*, settle the profile."""
    async with open_profile(
        args.profile, headless=args.headless, executable_path=args.chrome_path
    ) as browser:
        my3 = My3(browser, Site())
        my3.start_recording()
        try:
            account = await my3.open_account()
            bill_id, token = await my3.seed(account.cuid)
            bills, token = await my3.list_bills(account.cuid, bill_id, token)
            # Emitted inside the profile block, so a result is never lost to an
            # unconfirmed close that raises on the way out.
            _emit(await work(my3, account.cuid, bill_id, bills, token))
        except DIAGNOSTIC_ERRORS as exc:
            try:
                exc.details["diagnostics"] = await my3.capture_diagnostics(
                    args.home / "diagnostics", exc
                )
            except Exception:
                logging.getLogger(__name__).debug("Diagnostics failed", exc_info=True)
            raise


async def cmd_list(args: argparse.Namespace) -> None:
    async def work(_my3, _cuid, _bill_id, bills, _token):
        return {"bills": [bill.as_dict() for bill in bills]}

    await _with_account(args, work)


async def cmd_download(args: argparse.Namespace) -> None:
    month = contract.parse_month(args.month) if args.month else None
    out_dir = Path(args.out).expanduser()

    async def work(my3: My3, cuid, bill_id, bills, token):
        bill = contract.select_bill(bills, month, args.year)
        data, _ = await my3.download_pdf(cuid, bill_id, bill.billNumber, token)
        path = out_dir / contract.bill_filename(bill)
        write_private_atomic(path, data)
        return {
            "path": str(path),
            "bytes": len(data),
            "month": bill.month,
            "year": bill.year,
            "billNumber": bill.billNumber,
            "billAmount": bill.billAmount,
            "billCloseDate": bill.billCloseDate,
            "billEndDate": bill.billEndDate,
            "cuid": cuid,
            "warnings": contract.sanity_warnings(bill),
        }

    await _with_account(args, work)


async def cmd_login(args: argparse.Namespace) -> None:
    from three_bill.login import interactive_login

    _emit(
        await interactive_login(
            args.profile,
            timeout_seconds=args.timeout,
            executable_path=args.chrome_path,
        )
    )


def cmd_install_browser(_args: argparse.Namespace) -> int:
    """Install the Chromium build that matches this patchright version."""
    return subprocess.call([sys.executable, "-m", "patchright", "install", "chromium"])


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="three-bill",
        description="List and download Three UK bills from a dedicated browser profile.",
    )
    parser.add_argument(
        "--home",
        type=Path,
        default=Path(os.environ.get("THREE_BILL_HOME", DEFAULT_HOME)),
        help="state directory (default ~/.three-bill; env THREE_BILL_HOME)",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        default=_env_flag("THREE_BILL_HEADLESS"),
        help="run list/download without a window (env THREE_BILL_HEADLESS=1). login is always headed",
    )
    parser.add_argument(
        "--chrome-path",
        default=os.environ.get("THREE_BILL_CHROME_PATH") or None,
        help="use this Chromium binary instead of patchright's",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    login = sub.add_parser("login", help="sign in to My3 in a visible browser window")
    login.add_argument(
        "--timeout",
        type=float,
        default=900,
        help="seconds to wait for sign-in; 0 = no limit",
    )
    sub.add_parser("list", help="print the available bills as JSON, newest first")

    download = sub.add_parser("download", help="download one bill PDF")
    which = download.add_mutually_exclusive_group()
    which.add_argument(
        "--latest", action="store_true", help="the newest bill (default)"
    )
    which.add_argument("--month", help="issue month: March, mar or 3")
    download.add_argument("--year", type=int, help="issue year, e.g. 2026")
    download.add_argument(
        "--out", default="~/Desktop", help="output directory (default ~/Desktop)"
    )

    sub.add_parser("install-browser", help="download patchright's Chromium")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    args.home = args.home.expanduser()
    args.profile = args.home / "profile"

    if args.command == "install-browser":
        return cmd_install_browser(args)
    if args.command == "download":
        if args.latest and args.year:
            parser.error("--latest cannot be combined with --year")
        if args.month:
            try:
                contract.parse_month(args.month)
            except ValueError as exc:
                parser.error(str(exc))
    secure_mkdir(args.home)

    command = {"login": cmd_login, "list": cmd_list, "download": cmd_download}[
        args.command
    ]
    try:
        asyncio.run(command(args))
    except ThreeBillError as exc:
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


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
