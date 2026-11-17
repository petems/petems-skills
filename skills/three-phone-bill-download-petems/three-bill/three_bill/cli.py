"""``three-bill``: list and download Three UK bills from a dedicated browser profile.

The command shape, JSON output and exit codes come from skill_browser.cli.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
from typing import Any

from skill_browser import cli
from skill_browser.files import write_private_atomic
from skill_browser.months import parse_month

from three_bill import contract
from three_bill.my3 import TOOL_NAME, My3, Site

TOOL = cli.Tool(
    name=TOOL_NAME,
    description="List and download Three UK bills from a dedicated browser profile.",
    env_prefix="THREE_BILL",
    # Kept from the version verified against the live site.
    browser_locale="en-US",
    # WIRELESS_SECURITY_TOKEN and USER_SESSION_STATUS have no expiry, so
    # Chromium drops them on exit (seen live, 2026-11-17).
    keep_session_cookies=True,
)


async def _with_account(args: argparse.Namespace, work: Any) -> None:
    """Open the profile, confirm the session, run *work*, settle the profile."""
    async with cli.session(TOOL, args) as browser:
        my3 = My3(browser, Site())
        my3.start_recording()
        async with cli.diagnose_on_error(
            TOOL, args, lambda: my3.page, my3.network, redact=contract.redact_url
        ):
            account = await my3.open_account()
            bill_id, token = await my3.seed(account.cuid)
            bills, token = await my3.list_bills(account.cuid, bill_id, token)
            # Emitted inside the profile block, so a result is never lost to an
            # unconfirmed close that raises on the way out.
            cli.emit(await work(my3, account.cuid, bill_id, bills, token))


async def cmd_list(args: argparse.Namespace) -> None:
    async def work(_my3, _cuid, _bill_id, bills, _token):
        return {"bills": [bill.as_dict() for bill in bills]}

    await _with_account(args, work)


async def cmd_download(args: argparse.Namespace) -> None:
    month = parse_month(args.month) if args.month else None
    out_dir = Path(args.out).expanduser()

    async def work(my3: My3, cuid, bill_id, bills, token):
        bill = contract.select_bill(bills, month, args.year)
        data, _ = await my3.download_pdf(cuid, bill_id, bill.billNumber, token)
        path = out_dir / contract.bill_filename(bill)
        write_private_atomic(path, data, overwrite=args.overwrite)
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

    async with cli.session(
        TOOL, args, require_existing=False, headless=False
    ) as browser:
        result = await interactive_login(
            browser, My3(browser, Site()), timeout_seconds=args.timeout
        )
        cli.emit({**result, "profile": str(args.profile)})


def build_parser() -> argparse.ArgumentParser:
    parser, sub = cli.build_parser(TOOL)
    sub.add_parser("list", help="print the available bills as JSON, newest first")
    download = sub.add_parser("download", help="download one bill PDF")
    which = download.add_mutually_exclusive_group()
    which.add_argument(
        "--latest", action="store_true", help="the newest bill (default)"
    )
    which.add_argument("--month", help="issue month: March, mar or 3")
    download.add_argument("--year", type=int, help="issue year, e.g. 2026")
    cli.add_output_args(download)
    return parser


def validate(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    if args.command != "download":
        return
    if args.latest and args.year:
        parser.error("--latest cannot be combined with --year")
    if args.month:
        try:
            parse_month(args.month)
        except ValueError as exc:
            parser.error(str(exc))


def main(argv: list[str] | None = None) -> int:
    return cli.run(
        TOOL,
        build_parser(),
        {"login": cmd_login, "list": cmd_list, "download": cmd_download},
        argv,
        validate=validate,
    )


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
