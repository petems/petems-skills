"""``hyperoptic-bill``: list and download Hyperoptic bills from a dedicated browser profile.

The command shape, JSON output and exit codes come from skill_browser.cli.
"""

from __future__ import annotations

import argparse
from datetime import date
from pathlib import Path
import sys
from typing import Any

from skill_browser import cli
from skill_browser.files import write_private_atomic
from skill_browser.months import parse_month

from hyperoptic_bill import contract
from hyperoptic_bill.site import TOOL_NAME, Hyperoptic, Site

TOOL = cli.Tool(
    name=TOOL_NAME,
    description="List and download Hyperoptic bills from a dedicated browser profile.",
    env_prefix="HYPEROPTIC_BILL",
    # Keycloak's login cookies have no expiry, so Chromium drops them on exit.
    keep_session_cookies=True,
)


async def _with_site(args: argparse.Namespace, work: Any) -> None:
    async with cli.session(TOOL, args) as browser:
        site = Hyperoptic(browser, Site())
        site.start_recording()
        async with cli.diagnose_on_error(TOOL, args, lambda: site.page, site.network):
            # Emitted inside the profile block, so a result is never lost to an
            # unconfirmed close that raises on the way out.
            cli.emit(await work(site))


async def cmd_list(args: argparse.Namespace) -> None:
    year = args.year or date.today().year

    async def work(site: Hyperoptic) -> dict[str, Any]:
        bills = await site.list_bills(year)
        return {"year": year, "bills": [bill.as_dict() for bill in bills]}

    await _with_site(args, work)


async def cmd_download(args: argparse.Namespace) -> None:
    month = parse_month(args.month) if args.month else None
    out_dir = Path(args.out).expanduser()

    async def work(site: Hyperoptic) -> dict[str, Any]:
        bill = await site.find_bill(month, args.year)
        data, via = await site.download_pdf(bill)
        path = out_dir / contract.bill_filename(bill)
        write_private_atomic(path, data, overwrite=args.overwrite)
        return {
            "path": str(path),
            "bytes": len(data),
            "month": bill.month,
            "year": bill.year,
            "invoiceId": bill.invoiceId,
            "amount": bill.amount,
            "billDate": bill.billDate,
            "via": via,
            "warnings": bill.warnings,
        }

    await _with_site(args, work)


async def cmd_login(args: argparse.Namespace) -> None:
    from hyperoptic_bill.login import interactive_login

    async with cli.session(
        TOOL, args, require_existing=False, headless=False
    ) as browser:
        result = await interactive_login(
            browser, Hyperoptic(browser, Site()), timeout_seconds=args.timeout
        )
        cli.emit({**result, "profile": str(args.profile)})


def build_parser() -> argparse.ArgumentParser:
    parser, sub = cli.build_parser(TOOL)
    listing = sub.add_parser(
        "list", help="open each month of a year and print its bills, newest first"
    )
    listing.add_argument("--year", type=int, help="year (default: this year)")
    download = sub.add_parser("download", help="download one bill PDF")
    which = download.add_mutually_exclusive_group()
    which.add_argument(
        "--latest", action="store_true", help="the newest bill (default)"
    )
    which.add_argument("--month", help="bill month: March, mar or 3")
    download.add_argument("--year", type=int, help="bill year, e.g. 2026")
    cli.add_output_args(download)
    return parser


def validate(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    year = getattr(args, "year", None)
    if year is not None and not 2000 <= year <= 2099:
        parser.error("--year must be a four-digit year")
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
