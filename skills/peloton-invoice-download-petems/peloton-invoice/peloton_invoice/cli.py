"""``peloton-invoice``: list and download Peloton membership invoices as PDFs.

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
from skill_browser.pdf import html_to_pdf, validate_pdf

from peloton_invoice import contract
from peloton_invoice.account import PelotonAccount, Site

TOOL = cli.Tool(
    name=contract.TOOL_NAME,
    description="List and download Peloton membership invoices from a dedicated browser profile.",
    env_prefix="PELOTON_INVOICE",
)

# A good receipt prints to about 94 KB; a blank render was 872 bytes.
PDF_MIN_BYTES = 20_000


def make_site() -> Site:
    """Overridden in tests to point at a local fake."""
    return Site()


async def _with_history(args: argparse.Namespace, work: Any) -> None:
    """Open the profile, confirm the session, load every candidate's invoices."""
    async with cli.session(TOOL, args) as browser:
        account = PelotonAccount(browser, make_site())
        account.start_recording()
        async with cli.diagnose_on_error(
            TOOL,
            args,
            lambda: account.page,
            account.network,
            # The receipt shows the member's name and billing address.
            screenshot=False,
        ):
            locale = await account.open_membership()
            token = await account.token()
            subs = await account.subscriptions(token, locale)
            candidates, others = contract.classify(subs)
            history = [(sub, await account.invoices(token, sub)) for sub in candidates]
            # Emitted inside the profile block, so a result is never lost to an
            # unconfirmed close that raises on the way out.
            cli.emit(
                await work(browser, account, locale, subs, candidates, others, history)
            )


async def cmd_list(args: argparse.Namespace) -> None:
    async def work(_browser, _account, locale, subs, _candidates, _others, history):
        return {
            "locale": locale,
            "subscriptions": [s.as_dict() for s in subs],
            "invoices": [
                {"subscriptionId": sub.id, "invoices": [i.as_dict() for i in invoices]}
                for sub, invoices in history
            ],
            "warnings": []
            if locale == contract.VERIFIED_LOCALE
            else [f"locale {locale} is untested"],
        }

    await _with_history(args, work)


async def cmd_download(args: argparse.Namespace) -> None:
    month = parse_month(args.month) if args.month else None
    out_dir = Path(args.out).expanduser()

    async def work(browser, account, locale, _subs, candidates, others, history):
        if not candidates:
            raise contract.no_invoice_billers(others)
        invoice = contract.select_invoice(
            history, month=month, year=args.year, invoice_id=args.invoice_id
        )
        html = await account.receipt_html(locale, invoice)
        contract.check_capture_content(html, invoice)
        data = await html_to_pdf(browser, html)
        validate_pdf(200, "", data, min_bytes=PDF_MIN_BYTES, check_content_type=False)
        name = contract.invoice_filename(
            invoice, several_in_month=contract.shares_month(history, invoice)
        )
        path = out_dir / name
        write_private_atomic(path, data, overwrite=args.overwrite)
        return {
            "path": str(path),
            "bytes": len(data),
            "month": invoice.month,
            "year": invoice.year,
            "displayDate": invoice.displayDate,
            "amount": invoice.amount,
            "currency": invoice.currency,
            "tax": invoice.tax,
            "invoiceId": invoice.id,
            "subscriptionId": invoice.subscriptionId,
            "locale": locale,
            "warnings": contract.sanity_warnings(invoice, locale),
        }

    await _with_history(args, work)


async def cmd_login(args: argparse.Namespace) -> None:
    from peloton_invoice.login import interactive_login

    async with cli.session(
        TOOL, args, require_existing=False, headless=False
    ) as browser:
        account = PelotonAccount(browser, make_site())
        result = await interactive_login(browser, account, timeout_seconds=args.timeout)
        cli.emit({**result, "profile": str(args.profile)})


def build_parser() -> argparse.ArgumentParser:
    parser, sub = cli.build_parser(TOOL)
    sub.add_parser(
        "list", help="print subscriptions and invoices as JSON, newest first"
    )
    download = sub.add_parser("download", help="download one invoice as a PDF")
    which = download.add_mutually_exclusive_group()
    which.add_argument(
        "--latest", action="store_true", help="the newest invoice (default)"
    )
    which.add_argument("--month", help="payment month: October, oct or 10")
    which.add_argument("--invoice-id", help="exactly this invoice (its id from `list`)")
    download.add_argument("--year", type=int, help="payment year, e.g. 2026")
    cli.add_output_args(download)
    return parser


def validate(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    if args.command != "download":
        return
    if args.year and (args.latest or args.invoice_id):
        parser.error("--year only combines with --month (or on its own)")
    if args.month:
        try:
            parse_month(args.month)
        except ValueError as exc:
            parser.error(str(exc))
    if args.invoice_id and not contract.is_invoice_id(args.invoice_id):
        parser.error(
            "--invoice-id must be 32 lowercase hex characters or a dashed UUID"
        )


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
