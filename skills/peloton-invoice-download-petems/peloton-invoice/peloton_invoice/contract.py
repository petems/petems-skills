"""The Peloton account contract, as pure functions.

Everything here is the Peloton-specific knowledge that used to live in the
skill's ``evaluate_script`` snippets: the Auth0 token cache, the GraphQL
response shapes, the identifier guards, the month mapping and the receipt
checks. None of it touches a browser, so all of it is unit-tested.
``references/peloton-api-endpoints.md`` is the source of truth; when that file
changes, this one changes with it.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from html import unescape
import json
import math
import re
from typing import Any
from urllib.parse import urlsplit

from skill_browser.errors import (
    ApiError,
    ContractChangedError,
    InvalidIdentifierError,
    NotFoundError,
    NotLoggedInError,
)
from skill_browser.months import MONTHS

TOOL_NAME = "peloton-invoice"

ENTRY_URL = "https://account.onepeloton.co.uk/mymembership"
ACCOUNT_BASE = "https://account.onepeloton.com"
GRAPHQL_URL = "https://graph.prod.k8s.onepeloton.com/graphql"
AUTH_HOST = "auth.onepeloton.com"
MEMBERS_HOST = "members.onepeloton.com"
API_HOSTS = ("graph.prod.k8s.onepeloton.com", "api.onepeloton.com")

# Exact texts only: the Auth0 login footer says "Membership Terms", so any
# looser word ("Membership") matches the sign-in page instantly.
SIGNED_IN_MARKERS = ("Memberships on file", "Membership details")
RECEIPT_MARKER = "Total amount paid"

TOKEN_KEY_PREFIX = "@@auth0spajs@@"
TOKEN_AUDIENCE = "::https://api.onepeloton.com/::"
VERIFIED_LOCALE = "en-GB"

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
# Older invoices have 32 lowercase hex chars; newer ones (live, 2026-11) a
# lowercase dashed UUID. Both are URL-path safe; nothing else is accepted.
_INVOICE_ID = re.compile(
    r"^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$"
)
_LOCALE = re.compile(r"^[a-z]{2}-[A-Z]{2}$")
_CURRENCY = re.compile(r"^[A-Z]{3}$")

SUBS_QUERY = (
    "query Subs($input: SubPelotonMemberInput!) { subPelotonMember(input: $input) "
    "{ subscriptions { id isActive status billingStrategy billingPlan { id subscriptionType } } } }"
)
HISTORY_QUERY = (
    "query PaymentHistory($input: SubPelotonSubscriptionInput!) "
    "{ subPelotonSubscription(input: $input) { id pastInvoices { id createdAt "
    "invoicePayments { paymentDate totalAmount { currencyCode centAmount } } "
    "billingSummary { totalAmount { currencyCode centAmount } tax { centAmount } } } } }"
)

INVOICE_BILLER = "AutoDebit"
BILLER_HINTS = {
    "Apple": "Billed by Apple. The receipt is in the App Store purchase history.",
    "Google": "Billed by Google. The receipt is in the Google Play order history.",
    "Amazon": "Billed by Amazon. The receipt is in the Amazon order history.",
    "Roku": "Billed by Roku. The receipt is in the Roku account's purchase history.",
    "Bango": (
        "Billed through a mobile carrier or partner via Bango. "
        "The charge is on that provider's bill."
    ),
    "NotBilled": "Never charged (for example PRE_DELIVERY), so there is no receipt.",
}


# -- identifiers -------------------------------------------------------------


def validate_subscription_id(value: Any) -> str:
    if not isinstance(value, str) or not _UUID.match(value):
        raise InvalidIdentifierError(
            "A subscription id is not a dashed UUID", field="subscriptionId"
        )
    return value


def validate_invoice_id(value: Any) -> str:
    if not isinstance(value, str) or not _INVOICE_ID.match(value):
        raise InvalidIdentifierError(
            "An invoice id is neither 32 lowercase hex characters nor a dashed UUID",
            field="invoiceId",
        )
    return value


def is_invoice_id(value: str) -> bool:
    return bool(_INVOICE_ID.match(value))


def validate_locale(value: Any) -> str:
    if not isinstance(value, str) or not _LOCALE.match(value):
        raise InvalidIdentifierError("The locale is not like en-GB", field="locale")
    return value


def host_of(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


def locale_from_url(url: str) -> str | None:
    """``/en-GB/mymembership...`` → ``en-GB``; None if the path has no locale."""
    segments = (urlsplit(url).path or "/").split("/")
    first = segments[1] if len(segments) > 1 else ""
    return first if _LOCALE.match(first) else None


def is_membership_url(url: str, account_host: str) -> bool:
    """On ``<account host>/<locale>/mymembership``, the page that proves a session."""
    if host_of(url) != account_host:
        return False
    segments = (urlsplit(url).path or "/").rstrip("/").split("/")
    return (
        len(segments) >= 3
        and bool(_LOCALE.match(segments[1]))
        and segments[2] == ("mymembership")
    )


def has_signed_in_marker(text: str) -> bool:
    return any(marker in text for marker in SIGNED_IN_MARKERS)


def country_of(locale: str) -> str:
    return validate_locale(locale)[3:]


def receipt_path(locale: str, subscription_id: str, invoice_id: str) -> str:
    """Built only from parts that passed their guards."""
    return (
        f"/{validate_locale(locale)}/mymembership/v2/subscriptions/"
        f"{validate_subscription_id(subscription_id)}/invoices/"
        f"{validate_invoice_id(invoice_id)}"
    )


# -- token -------------------------------------------------------------------


def is_token_key(key: str) -> bool:
    return key.startswith(TOKEN_KEY_PREFIX) and TOKEN_AUDIENCE in key


def pick_token(entries: Iterable[Any], now: float) -> str:
    """The first usable access token among raw Auth0 cache values.

    *entries* are the raw ``localStorage`` strings for keys that passed
    :func:`is_token_key`; *now* is Unix seconds. The first entry may be stale
    while a later one is valid, so every entry is tried.
    """
    entries = list(entries)
    if not entries:
        raise NotLoggedInError(
            "No Auth0 token cache on the account page.", code="no_token_key"
        )
    saw_expired = False
    for raw in entries:
        try:
            entry = json.loads(raw) if isinstance(raw, str) else None
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        body = entry.get("body")
        token = body.get("access_token") if isinstance(body, dict) else None
        if not isinstance(token, str) or len(token) < 20:
            continue
        expires = entry.get("expiresAt")
        if (
            isinstance(expires, int | float)
            and not isinstance(expires, bool)
            and math.isfinite(expires)
            and expires < now
        ):
            saw_expired = True
            continue
        return token
    if saw_expired:
        raise NotLoggedInError(
            "The Auth0 access token has expired.",
            code="token_expired",
            entries=len(entries),
        )
    raise NotLoggedInError(
        "No usable Auth0 access token.", code="no_access_token", entries=len(entries)
    )


# -- GraphQL -----------------------------------------------------------------


def check_gql_result(result: Any, prefix: str) -> dict[str, Any]:
    """Turn the in-page fetch result into a GraphQL body, or a typed error."""
    if not isinstance(result, dict):
        raise ApiError(
            "The in-page GraphQL fetch returned nothing", code="network_error"
        )
    if result.get("networkError"):
        raise ApiError(
            f"The GraphQL gateway was unreachable ({result['networkError']})",
            code="network_error",
            detail=result["networkError"],
        )
    status = result.get("status")
    if status in (401, 403):
        raise NotLoggedInError(
            f"The GraphQL gateway rejected the token (HTTP {status}).",
            code=f"{prefix}_unauthorized",
            status=status,
        )
    if status != 200:
        raise ApiError(
            f"The {prefix} query returned HTTP {status}",
            code=f"{prefix}_failed",
            status=status,
        )
    body = result.get("body")
    if result.get("parseError") or not isinstance(body, dict):
        raise ContractChangedError(
            f"The {prefix} response is not JSON", code=f"{prefix}_unparseable"
        )
    errors = body.get("errors")
    if errors:
        messages = [
            str(e.get("message"))[:200] if isinstance(e, dict) else str(e)[:200]
            for e in (errors if isinstance(errors, list) else [errors])
        ][:3]
        raise ContractChangedError(
            f"The {prefix} query returned GraphQL errors",
            code=f"{prefix}_graphql_error",
            messages=messages,
        )
    return body


def _data(body: dict[str, Any]) -> dict[str, Any]:
    data = body.get("data")
    return data if isinstance(data, dict) else {}


# -- subscriptions -----------------------------------------------------------


@dataclass(frozen=True)
class Subscription:
    id: str
    isActive: bool
    status: str | None
    billingStrategy: str | None
    plan: str | None

    @property
    def issues_invoices(self) -> bool:
        return self.billingStrategy == INVOICE_BILLER

    def as_dict(self) -> dict[str, Any]:
        out = asdict(self)
        if not self.issues_invoices:
            out["hint"] = BILLER_HINTS.get(
                self.billingStrategy or "",
                f"Billed via {self.billingStrategy}, not by Peloton.",
            )
        return out


def parse_subscriptions(body: dict[str, Any]) -> list[Subscription]:
    member = _data(body).get("subPelotonMember")
    subs = member.get("subscriptions") if isinstance(member, dict) else None
    if not isinstance(subs, list):
        raise ContractChangedError(
            "The subscriptions response changed shape",
            code="subs_shape_changed",
            dataKeys=sorted(_data(body).keys()),
        )
    out = []
    for sub in subs:
        if not isinstance(sub, dict):
            continue
        sid = sub.get("id")
        if not isinstance(sid, str) or not _UUID.match(sid):
            continue
        plan = sub.get("billingPlan")
        out.append(
            Subscription(
                id=sid,
                isActive=sub.get("isActive") is True,
                status=sub.get("status")
                if isinstance(sub.get("status"), str)
                else None,
                billingStrategy=sub.get("billingStrategy")
                if isinstance(sub.get("billingStrategy"), str)
                else None,
                plan=plan.get("id")
                if isinstance(plan, dict) and isinstance(plan.get("id"), str)
                else None,
            )
        )
    return out


def classify(
    subs: list[Subscription],
) -> tuple[list[Subscription], list[Subscription]]:
    """``(invoice candidates, other billers)``. Candidates: active first.

    A cancelled AutoDebit membership still has past invoices, so it stays a
    candidate.
    """
    candidates = [s for s in subs if s.issues_invoices]
    candidates.sort(key=lambda s: not s.isActive)  # stable: keeps API order
    return candidates, [s for s in subs if not s.issues_invoices]


# -- invoices ----------------------------------------------------------------


@dataclass(frozen=True)
class Invoice:
    id: str
    subscriptionId: str
    month: str
    year: int
    displayDate: str  # dd/mm/yyyy, as printed on the receipt
    paymentDate: str
    amount: str | None  # "45.00"
    currency: str | None  # "GBP"
    tax: str | None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def sort_key(self) -> datetime:
        return parse_date(self.paymentDate)


def parse_date(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("not a date")
    parsed = datetime.fromisoformat(value.strip())
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _cents(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def _get(obj: Any, *path: Any) -> Any:
    for key in path:
        if isinstance(key, int):
            obj = obj[key] if isinstance(obj, list) and len(obj) > key else None
        else:
            obj = obj.get(key) if isinstance(obj, dict) else None
    return obj


def parse_invoices(body: dict[str, Any], subscription_id: str) -> list[Invoice]:
    """The subscription's past invoices, newest first."""
    subscription_id = validate_subscription_id(subscription_id)
    sub = _data(body).get("subPelotonSubscription")
    raw = sub.get("pastInvoices") if isinstance(sub, dict) else None
    if not isinstance(raw, list):
        raise ContractChangedError(
            "The payment history response changed shape",
            code="history_shape_changed",
            dataKeys=sorted(sub.keys()) if isinstance(sub, dict) else [],
        )
    invoices = []
    for index, inv in enumerate(raw):
        iid = _get(inv, "id")
        # The id goes into a URL path, so it must be 32 hex chars or a dashed UUID.
        if not isinstance(iid, str) or not _INVOICE_ID.match(iid):
            raise ContractChangedError(
                "An invoice id changed shape",
                code="invoice_shape_changed",
                index=index,
                field="id",
            )
        date_text = _get(inv, "invoicePayments", 0, "paymentDate") or _get(
            inv, "createdAt"
        )
        try:
            # Payments land around 19:00 UTC, so the UTC date is the UK date.
            paid = parse_date(date_text)
        except ValueError:
            raise ContractChangedError(
                "An invoice payment date changed shape",
                code="invoice_shape_changed",
                index=index,
                field="paymentDate",
                value=str(date_text)[:40],
            ) from None
        cents = _cents(_get(inv, "billingSummary", "totalAmount", "centAmount"))
        if cents is None:
            cents = _cents(_get(inv, "invoicePayments", 0, "totalAmount", "centAmount"))
        currency = _get(inv, "billingSummary", "totalAmount", "currencyCode") or _get(
            inv, "invoicePayments", 0, "totalAmount", "currencyCode"
        )
        tax = _cents(_get(inv, "billingSummary", "tax", "centAmount"))
        invoices.append(
            Invoice(
                id=iid,
                subscriptionId=subscription_id,
                month=MONTHS[paid.month - 1],
                year=paid.year,
                displayDate=f"{paid.day:02d}/{paid.month:02d}/{paid.year}",
                paymentDate=date_text,
                amount=f"{cents / 100:.2f}" if cents is not None else None,
                currency=currency
                if isinstance(currency, str) and _CURRENCY.match(currency)
                else None,
                tax=f"{tax / 100:.2f}" if tax is not None else None,
            )
        )
    invoices.sort(key=lambda i: i.sort_key, reverse=True)
    return invoices


# -- selection ---------------------------------------------------------------

History = list[tuple[Subscription, list[Invoice]]]


def _summary(inv: Invoice) -> dict[str, Any]:
    return {
        "month": inv.month,
        "year": inv.year,
        "displayDate": inv.displayDate,
        "amount": inv.amount,
        "currency": inv.currency,
        "invoiceId": inv.id,
    }


def no_invoice_billers(others: list[Subscription]) -> NotFoundError:
    return NotFoundError(
        "No subscription on this account is billed by Peloton, so there is no "
        "Peloton invoice.",
        code="no_peloton_invoices",
        billers=[s.as_dict() for s in others],
    )


def select_invoice(
    history: History,
    *,
    month: str | None = None,
    year: int | None = None,
    invoice_id: str | None = None,
) -> Invoice:
    """Pick one invoice from the candidates' histories (primary first).

    * ``invoice_id``: exactly that invoice, on whichever subscription has it.
    * neither month nor year: the primary's newest, else the newest anywhere.
    * month and/or year: searched across every candidate. Without a year, the
      most recent year that has the month. More than one match is ambiguous.
    """
    everything = [inv for _sub, invoices in history for inv in invoices]
    available = [
        _summary(inv)
        for inv in sorted(everything, key=lambda i: i.sort_key, reverse=True)
    ]
    if not everything:
        raise NotFoundError(
            "There are no Peloton invoices on this account yet.",
            code="no_invoices",
            available=[],
        )
    if invoice_id is not None:
        validate_invoice_id(invoice_id)
        for inv in everything:
            if inv.id == invoice_id:
                return inv
        raise NotFoundError(
            "No invoice with that id", code="bill_not_found", available=available
        )
    if month is None and year is None:
        primary = history[0][1] if history else []
        if primary:
            return primary[0]
        return max(everything, key=lambda i: i.sort_key)

    matches = [
        inv
        for inv in everything
        if (month is None or inv.month == month) and (year is None or inv.year == year)
    ]
    if not matches:
        raise NotFoundError(
            f"No invoice for {month or ''} {year or ''}".strip(),
            code="bill_not_found",
            requested={"month": month, "year": year},
            available=available,
        )
    if year is None:
        newest_year = max(inv.year for inv in matches)
        matches = [inv for inv in matches if inv.year == newest_year]
    if month is None:
        return max(matches, key=lambda i: i.sort_key)
    if len(matches) > 1:
        # A plan change or a retried payment. Never guess which one.
        raise NotFoundError(
            f"{len(matches)} invoices in {month} {matches[0].year}. "
            "Pick one with --invoice-id.",
            code="ambiguous_month",
            options=[
                _summary(inv) for inv in sorted(matches, key=lambda i: i.sort_key)
            ],
        )
    return matches[0]


def shares_month(history: History, invoice: Invoice) -> bool:
    """True if another invoice was paid in the same month and year."""
    return any(
        inv.id != invoice.id and inv.month == invoice.month and inv.year == invoice.year
        for _sub, invoices in history
        for inv in invoices
    )


def invoice_filename(invoice: Invoice, *, several_in_month: bool) -> str:
    """``Peloton_Invoice_October_2026_GBP45.00.pdf``.

    An unknown currency is never labelled GBP: without both currency and
    amount, the amount is left out.
    """
    name = f"Peloton_Invoice_{invoice.month}_{invoice.year}"
    if invoice.amount is not None and invoice.currency is not None:
        name += f"_{invoice.currency}{invoice.amount}"
    if several_in_month:
        name += f"_{invoice.id[:8]}"
    return name + ".pdf"


def sanity_warnings(invoice: Invoice, locale: str) -> list[str]:
    warnings = []
    if locale != VERIFIED_LOCALE:
        warnings.append(
            f"locale {locale} is untested; only {VERIFIED_LOCALE} has been verified "
            "against the live site"
        )
    if invoice.amount is None:
        warnings.append("amount missing from the API; nothing to cross-check")
    if invoice.currency is None:
        warnings.append("currency missing from the API; filename has no amount")
    return warnings


# -- receipt -----------------------------------------------------------------


def has_amount(text: str, amount: str) -> bool:
    """*amount* as a whole number in *text*: ``45.00`` matches ``£45.00``, not ``145.00``."""
    pattern = r"(?<![\d.,])" + re.escape(amount) + r"(?![\d])"
    return re.search(pattern, text) is not None


def receipt_checks(text: str, invoice: Invoice) -> dict[str, bool]:
    """Cross-check the rendered receipt against the API before capturing it."""
    checks = {
        "hasEntity": "Peloton Interactive" in text,
        "hasVat": "VAT ID Number" in text,
        "hasTotal": RECEIPT_MARKER in text,
        "hasDate": invoice.displayDate in text,
    }
    if invoice.amount is not None:
        checks["hasAmount"] = has_amount(text, invoice.amount)
    return checks


def check_receipt_text(text: str, invoice: Invoice) -> None:
    checks = receipt_checks(text, invoice)
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        raise ContractChangedError(
            "The receipt page does not match the invoice from the API",
            code="receipt_mismatch",
            failed=failed,
        )


_SCRIPT_TAG = re.compile(r"<\s*script\b", re.I)
_CAPTURE_ERRORS = {
    "invalid_identifier": InvalidIdentifierError,
    "wrong_page": ContractChangedError,
    "receipt_not_rendered": ApiError,
}


def html_text(html: str) -> str:
    """Rough visible text of captured HTML, for content checks only."""
    body = re.sub(r"(?is)<(style|head)\b.*?</\1\s*>", " ", html)
    return unescape(re.sub(r"<[^>]+>", " ", body))


def check_capture_content(html: str, invoice: Invoice) -> None:
    """The sanitised HTML that gets printed must still show this receipt.

    The page is checked before capture, but sanitising can strip content (a
    class-substring selector once deleted the whole receipt and printed a
    blank page), so the exact HTML that is printed is checked again.
    """
    checks = receipt_checks(html_text(html), invoice)
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        raise ContractChangedError(
            "The captured receipt lost content the page showed",
            code="capture_mismatch",
            failed=failed,
        )


def validate_capture(result: Any) -> str:
    """The sanitised receipt HTML, or a typed error. Refuses anything with a script."""
    if not isinstance(result, str):
        raise ContractChangedError(
            "The receipt capture returned no HTML", code="capture_failed"
        )
    if result.startswith("ERROR:"):
        code = result[len("ERROR:") :]
        cls = _CAPTURE_ERRORS.get(code, ContractChangedError)
        raise cls(f"The receipt capture refused: {code}", code=code)
    if "<body" not in result:
        raise ContractChangedError(
            "The captured receipt has no <body>", code="body_missing"
        )
    if _SCRIPT_TAG.search(result):
        raise ContractChangedError(
            "The captured receipt still contains a script", code="script_survived"
        )
    return result
