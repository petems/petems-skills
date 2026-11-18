"""The Hyperoptic account site contract, as pure functions.

Everything here is Hyperoptic-specific knowledge that used to live in the
skill's snapshot-reading steps. None of it touches a browser, so all of it is
unit-tested. ``references/hyperoptic-site.md`` is the source of truth; when
that file changes, this one changes with it.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import re
from typing import Any
from urllib.parse import parse_qs, urlsplit

from skill_browser.errors import ContractChangedError, InvalidIdentifierError
from skill_browser.months import MONTHS

BASE_URL = "https://account.hyperoptic.com"
BILLS_PATH = "/bills-and-payments"
VIEW_BILL_PATH = "/bills-and-payments/view-bill"

# Routes on the account host that mean "not signed in".
_SIGN_IN_PATHS = ("/login", "/logout", "/auth", "/realms", "/protocol/openid-connect")

# Page text that only a signed-in account page shows.
SIGNED_IN_MARKERS = ("Dashboard", "Bills and payments", "Bills & payments", "My bills")

_DIGITS = re.compile(r"^\d+$")
_YEAR = re.compile(r"^20\d{2}$")
_AMOUNT = re.compile(r"^\d+\.\d{2}$")
_HEADING = re.compile(r"\b(" + "|".join(MONTHS) + r")\s+(20\d{2})\s+bill\b", re.I)
# The live View Bill page puts each value *before* its label (verified
# 2026-11-17): "£53.00 / Amount due / 9 November, 2026 / Bill date /
# 23 November, 2026 / Payment date". Reading label-then-value takes the
# payment date as the bill date, so only value-then-label is accepted.
_DATE = r"\d{1,2}(?:st|nd|rd|th)?\s+(?:" + "|".join(MONTHS) + r"),?\s+20\d{2}"
_AMOUNT_DUE = re.compile(r"£\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*Amount due\b", re.I)
_BILL_DATE = re.compile(r"(" + _DATE + r")\s*Bill date\b", re.I)


@dataclass(frozen=True)
class Bill:
    invoiceId: str
    month: str
    year: int
    amount: str | None
    billDate: str | None
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def host_of(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


def auth_barrier(url: str, base_url: str = BASE_URL) -> str | None:
    """Why *url* is not a signed-in account page, from the URL alone, else None.

    Keycloak lives on another host, so any off-host URL is a barrier. The
    scheme must match *base_url* (https for the real site; tests use http).
    """
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    base = urlsplit(base_url)
    if host != (base.hostname or "").lower() or parts.scheme != base.scheme:
        return f"off-site redirect to {host or 'an unknown host'}"
    path = (parts.path or "/").lower().rstrip("/") or "/"
    for blocker in _SIGN_IN_PATHS:
        if path == blocker or path.startswith(blocker + "/"):
            return f"sign-in route {blocker}"
    return None


def has_signed_in_marker(text: str) -> bool:
    return any(marker.lower() in text.lower() for marker in SIGNED_IN_MARKERS)


def validate_invoice_id(value: Any) -> str:
    text = str(value) if isinstance(value, str | int) else ""
    if not _DIGITS.match(text):
        raise InvalidIdentifierError("invoiceId is not digit-only", field="invoiceId")
    return text


def invoice_id_from_url(url: str, base_url: str = BASE_URL) -> str | None:
    """The ``invoiceId`` of a View Bill URL, or None if *url* is not one."""
    if auth_barrier(url, base_url):
        return None
    parts = urlsplit(url)
    if parts.path.rstrip("/") != VIEW_BILL_PATH:
        return None
    values = parse_qs(parts.query).get("invoiceId", [])
    if len(values) != 1 or not _DIGITS.match(values[0]):
        return None
    return values[0]


def normalise_amount(raw: str | None) -> str | None:
    """``"1,053.5"`` → ``"1053.50"``. None if it is not a plain GBP amount."""
    if raw is None:
        return None
    text = raw.replace(",", "").strip()
    if not re.match(r"^\d+(?:\.\d{1,2})?$", text):
        return None
    whole, _, pence = text.partition(".")
    result = f"{int(whole)}.{(pence + '00')[:2]}"
    return result if _AMOUNT.match(result) else None


def parse_view_bill(text: str, url: str, base_url: str = BASE_URL) -> Bill:
    """Read one View Bill page's body text and URL into a validated :class:`Bill`."""
    invoice_id = invoice_id_from_url(url, base_url)
    if invoice_id is None:
        raise ContractChangedError(
            "The View Bill URL has no digit-only invoiceId",
            code="view_bill_shape_changed",
            field="invoiceId",
        )
    heading = _HEADING.search(text)
    if not heading:
        raise ContractChangedError(
            "The View Bill page has no '<Month> <Year> bill' heading",
            code="view_bill_shape_changed",
            field="heading",
        )
    month = heading.group(1).capitalize()
    year_text = heading.group(2)
    if month not in MONTHS or not _YEAR.match(year_text):
        raise ContractChangedError(
            "The View Bill heading is not a month and year",
            code="view_bill_shape_changed",
            field="heading",
        )

    warnings: list[str] = []
    due = _AMOUNT_DUE.search(text)
    amount = normalise_amount(due.group(1) if due else None)
    if amount is None:
        warnings.append(
            "amount_unreadable: no plain '£<amount>' before 'Amount due'; "
            "the filename omits the amount"
        )
    date = _BILL_DATE.search(text)
    bill_date = " ".join(date.group(1).split()) if date else None
    if bill_date is None:
        warnings.append("bill_date_unreadable: no date before 'Bill date'")
    return Bill(invoice_id, month, int(year_text), amount, bill_date, warnings)


def months_back(month: str, year: int, count: int = 13) -> list[tuple[str, int]]:
    """``(month, year)`` from the given month backwards, *count* entries."""
    index = MONTHS.index(month)
    out: list[tuple[str, int]] = []
    for step in range(count):
        offset = index - step
        out.append((MONTHS[offset % 12], year + offset // 12))
    return out


def bill_filename(bill: Bill) -> str:
    amount = f"_GBP{bill.amount}" if bill.amount else ""
    return f"Hyperoptic_Bill_{bill.month}_{bill.year}{amount}.pdf"


def is_billing_url(url: str, base_url: str = BASE_URL) -> bool:
    """Requests worth logging for diagnostics: account-host API and billing paths."""
    parts = urlsplit(url)
    if (parts.hostname or "").lower() != host_of(base_url):
        return False
    path = parts.path.lower()
    return "/api/" in path or "/billing" in path or path.startswith(BILLS_PATH)


def is_bill_pdf_url(url: str, invoice_id: str) -> bool:
    """The fallback PDF request: a path containing ``/billing/<invoiceId>``."""
    path = urlsplit(url).path
    return re.search(rf"/billing/{re.escape(invoice_id)}(?:/|$)", path) is not None
