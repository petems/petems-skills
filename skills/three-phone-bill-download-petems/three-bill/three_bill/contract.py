"""The My3 API contract, as pure functions.

Everything here is the Three-specific knowledge that used to live in the
skill's ``evaluate_script`` snippets. None of it touches a browser, so all of it
is unit-tested. ``references/three-api-endpoints.md`` is the source of truth;
when that file changes, this one changes with it.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
import json
import math
import re
from typing import Any
from urllib.parse import urlsplit

from three_bill.errors import (
    BillNotFoundError,
    ContractChangedError,
    InvalidIdentifierError,
    NotLoggedInError,
)

BASE_URL = "https://www.three.co.uk"
API_PREFIX = "/rp-server-b2c"

MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)

_DIGITS = re.compile(r"^\d+$")

# The SPA's own seed call. The cuid is the last path segment.
_SEED_PATH = re.compile(r"^/rp-server-b2c/care/v1/B2C/customer/(\d+)/?$")


# -- identifiers -------------------------------------------------------------


def validate_identifier(field: str, value: Any, *, min_digits: int = 1) -> str:
    """Return *value* as a digit-only string, or raise.

    Every identifier ends up in a URL path, so anything that is not plain
    digits (a quote, a ``/``, ``undefined``) is refused before a URL is built.
    """
    if isinstance(value, bool) or not isinstance(value, str | int):
        raise InvalidIdentifierError(
            f"{field} is not a string or integer",
            field=field,
            type=type(value).__name__,
        )
    text = str(value)
    if not _DIGITS.match(text) or len(text) < min_digits:
        raise InvalidIdentifierError(
            f"{field} is not a digit-only identifier of at least {min_digits} digits",
            field=field,
            value=text[:40],
        )
    return text


def validate_cuid(value: Any) -> str:
    return validate_identifier("cuid", value, min_digits=6)


def cuid_from_seed_url(url: str) -> str | None:
    """The cuid in a ``/care/v1/B2C/customer/<cuid>`` URL, else None."""
    match = _SEED_PATH.match(urlsplit(url).path)
    return match.group(1) if match else None


def is_seed_url(url: str, base_url: str = BASE_URL) -> bool:
    parts = urlsplit(url)
    base = urlsplit(base_url)
    return (
        parts.scheme == base.scheme
        and parts.netloc == base.netloc
        and _SEED_PATH.match(parts.path) is not None
    )


def cuid_from_persistor(raw: str | None) -> str:
    """Read ``customerId`` out of ``persist:customerProfilePersistor``.

    redux-persist double-encodes: the outer value is JSON whose values are
    themselves JSON strings, so ``customerId`` arrives as ``"\\"949613941\\""``.
    Only populated once ``/account`` has loaded; on ``/customer-logged`` it
    reads as ``""`` or ``"undefined"``.
    """
    if not raw:
        raise ContractChangedError(
            "sessionStorage has no persist:customerProfilePersistor",
            code="persistor_missing",
        )
    try:
        outer = json.loads(raw)
    except ValueError as exc:
        raise ContractChangedError(
            "persist:customerProfilePersistor is not JSON",
            code="persistor_parse_failed",
        ) from exc
    if not isinstance(outer, dict):
        raise ContractChangedError(
            "persist:customerProfilePersistor is not a JSON object",
            code="persistor_parse_failed",
            type=type(outer).__name__,
        )
    value = outer.get("customerId")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            pass  # already a bare string
    text = "" if value is None else str(value)
    if not re.match(r"^\d{6,}$", text):
        raise ContractChangedError(
            "No customer ID in the redux store (are you on /customer-logged "
            "rather than /account?)",
            code="no_cuid_in_store",
            value=text[:40],
            outer_keys=sorted(outer)[:25],
        )
    return text


# -- auth --------------------------------------------------------------------


def check_auth_body(status: int, body: Any) -> None:
    """Fail closed: only a literal ``isAnonymous is False`` is a session.

    An Auth0 login can succeed while the Three backend session stays anonymous
    (the browser killed mid-flow), so the header saying "My3 account" proves
    nothing. A missing or non-boolean field is a failure, not permission.
    """
    if status != 200:
        raise NotLoggedInError(
            f"The My3 auth check returned HTTP {status}",
            code="auth_check_failed",
            status=status,
        )
    if not isinstance(body, dict):
        raise NotLoggedInError(
            "The My3 auth check body was not a JSON object",
            code="auth_check_unparseable",
        )
    if body.get("isAnonymous") is not False:
        raise NotLoggedInError(
            "The My3 session is anonymous",
            code="session_not_authenticated",
            is_anonymous=body.get("isAnonymous"),
            body_keys=sorted(body)[:25],
        )


# -- seed and list -----------------------------------------------------------


def bill_id_from_seed(body: Any) -> str:
    """``customer.financialAccount[0].id``, or ``customer.billingArrangement.id``.

    Never ``customer.id``: that is the cuid, and the fact that it equals the
    billing arrangement on personal accounts does not prove it does so in
    general. A request built from a guess may be misrouted.
    """
    if not isinstance(body, dict):
        raise ContractChangedError(
            "Seed body is not a JSON object",
            code="seed_shape_changed",
            field="body",
        )
    customer = body.get("customer", body)
    if not isinstance(customer, dict):
        customer = {}

    raw: Any = None
    accounts = customer.get("financialAccount")
    if isinstance(accounts, list) and accounts and isinstance(accounts[0], dict):
        raw = accounts[0].get("id")
    if raw is None:
        arrangement = customer.get("billingArrangement")
        if isinstance(arrangement, dict):
            raw = arrangement.get("id")
    if raw is None or isinstance(raw, bool) or not isinstance(raw, str | int):
        raise ContractChangedError(
            "Seed body has no customer.financialAccount[0].id",
            code="seed_shape_changed",
            field="billId",
            body_keys=sorted(body)[:25],
            customer_keys=sorted(customer)[:25],
        )
    return validate_identifier("billId", raw, min_digits=6)


@dataclass(frozen=True)
class Bill:
    month: str
    year: int
    billNumber: str
    billAmount: float | None
    billCloseDate: str
    billStartDate: Any
    billEndDate: Any
    billPeriod: Any

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def parse_close_date(value: Any) -> datetime:
    """``billCloseDate`` as an aware UTC datetime. A naive value is read as UTC."""
    if not isinstance(value, str) or not value:
        raise ValueError("not a non-empty string")
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def month_and_year(close_date: Any) -> tuple[str, int]:
    """The calendar month a user means by "my July bill".

    That is the month the bill was *issued*: ``billCloseDate``, in UTC. Never the
    entry's ``month`` field, which is a billing-period counter (the bill closing
    24 Jul 2026 has ``month: 5``).
    """
    closed = parse_close_date(close_date)
    return MONTHS[closed.month - 1], closed.year


def normalise_amount(value: Any) -> float | None:
    """A finite number, a numeric string coerced, otherwise None.

    ``billAmount`` only names the file and is cross-checked against the PDF; it
    never reaches a URL, so a bad value must not abort the download.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        number = float(value)
    elif isinstance(value, str):
        if not value.strip():
            return None
        try:
            number = float(value)
        except ValueError:
            return None
    else:
        return None
    return number if math.isfinite(number) else None


def parse_bills(body: Any) -> list[Bill]:
    """Validate and normalise the list-bills response, newest first."""
    if not isinstance(body, dict) or not isinstance(body.get("bills"), list):
        raise ContractChangedError(
            "List-bills body has no 'bills' array",
            code="list_shape_changed",
            body_keys=sorted(body)[:25] if isinstance(body, dict) else [],
        )
    bills: list[tuple[datetime, Bill]] = []
    for index, entry in enumerate(body["bills"]):
        data = entry.get("data") if isinstance(entry, dict) else None
        if not isinstance(data, dict):
            raise ContractChangedError(
                f"Bill {index} has no data object",
                code="bill_entry_shape_changed",
                index=index,
                field="data",
            )
        number = data.get("billNumber")
        # Strictly a string of digits: it goes into a URL path segment.
        if not isinstance(number, str) or not _DIGITS.match(number):
            raise ContractChangedError(
                f"Bill {index} has no usable billNumber",
                code="bill_entry_shape_changed",
                index=index,
                field="billNumber",
                value=str(number)[:40],
                data_keys=sorted(data)[:25],
            )
        try:
            closed = parse_close_date(data.get("billCloseDate"))
        except (TypeError, ValueError):
            raise ContractChangedError(
                f"Bill {index} has no parseable billCloseDate",
                code="bill_entry_shape_changed",
                index=index,
                field="billCloseDate",
                value=str(data.get("billCloseDate"))[:40],
            ) from None
        if not 2000 <= closed.year <= 2100:
            raise ContractChangedError(
                f"Bill {index} closes in an implausible year",
                code="bill_entry_shape_changed",
                index=index,
                field="billCloseDate_year",
                value=closed.year,
            )
        bills.append(
            (
                closed,
                Bill(
                    month=MONTHS[closed.month - 1],
                    year=closed.year,
                    billNumber=number,
                    billAmount=normalise_amount(data.get("billAmount")),
                    billCloseDate=data["billCloseDate"],
                    billStartDate=data.get("billStartDate"),
                    billEndDate=data.get("billEndDate"),
                    billPeriod=data.get("billPeriod"),
                ),
            )
        )
    bills.sort(key=lambda pair: pair[0], reverse=True)
    return [bill for _, bill in bills]


# -- choosing a bill ---------------------------------------------------------


def parse_month(value: str) -> str:
    """``March``, ``mar`` or ``3`` → ``March``."""
    text = value.strip()
    if _DIGITS.match(text):
        number = int(text)
        if 1 <= number <= 12:
            return MONTHS[number - 1]
    else:
        lowered = text.lower()
        for name in MONTHS:
            if len(lowered) >= 3 and name.lower().startswith(lowered):
                return name
    raise ValueError(f"not a month: {value!r}")


def select_bill(bills: list[Bill], month: str | None, year: int | None) -> Bill:
    """The newest bill, or the one issued in *month* / *year*."""
    if not bills:
        raise BillNotFoundError("Three returned no bills", available=[])
    if month is None and year is None:
        return bills[0]
    for bill in bills:
        if (month is None or bill.month == month) and (
            year is None or bill.year == year
        ):
            return bill
    raise BillNotFoundError(
        f"No bill issued in {month or ''} {year or ''}".strip(),
        requested={"month": month, "year": year},
        available=[{"month": b.month, "year": b.year} for b in bills],
    )


def sanity_warnings(bill: Bill) -> list[str]:
    """Soft checks: Three closes on the 24th, and the period ends the 23rd."""
    warnings: list[str] = []
    try:
        closed = parse_close_date(bill.billCloseDate)
        if closed.day != 24:
            warnings.append(f"billCloseDate is day {closed.day}, expected 24")
        ended = parse_close_date(bill.billEndDate)
        if (ended.year, ended.month) != (closed.year, closed.month):
            warnings.append("billEndDate is not in the same month as billCloseDate")
    except (TypeError, ValueError):
        warnings.append("billEndDate is missing or unparseable")
    if bill.billAmount is None:
        warnings.append("billAmount was not a usable number; omitted from the filename")
    return warnings


def bill_filename(bill: Bill) -> str:
    amount = "" if bill.billAmount is None else f"_GBP{bill.billAmount:.2f}"
    return f"Three_UK_Bill_{bill.month}_{bill.year}{amount}.pdf"


# -- URLs --------------------------------------------------------------------


def auth_check_path() -> str:
    return f"{API_PREFIX}/authentication/v1/B2C/user?salesChannel=selfService"


def seed_path(cuid: str) -> str:
    cuid = validate_cuid(cuid)
    return (
        f"{API_PREFIX}/care/v1/B2C/customer/{cuid}"
        "?salesChannel=selfService&initId=Digital"
        "&levelOfData=owningIndividual,financialAccount"
    )


def list_path(cuid: str, bill_id: str) -> str:
    cuid = validate_cuid(cuid)
    bill_id = validate_identifier("billId", bill_id, min_digits=6)
    return (
        f"{API_PREFIX}/ebill/v1/customer/{cuid}"
        f"/billing-arrangement/{bill_id}/bill?salesChannel=selfService"
    )


def pdf_path(cuid: str, bill_id: str, bill_number: str) -> str:
    """Note ``/care/v1/``, not ``/ebill/v1/``."""
    cuid = validate_cuid(cuid)
    bill_id = validate_identifier("billId", bill_id, min_digits=6)
    bill_number = validate_identifier("billNumber", bill_number)
    return (
        f"{API_PREFIX}/care/v1/customer/{cuid}/billing-arrangement/{bill_id}"
        f"/bill/{bill_number}/pdf?salesChannel=selfService"
    )


# -- redaction ---------------------------------------------------------------

_SENSITIVE_HEADER = re.compile(r"auth|cookie|token|session|secret|key", re.I)


def redact_url(url: str) -> str:
    """Path only, with identifiers replaced. Query and fragment are dropped."""
    path = urlsplit(url).path or "/"
    path = re.sub(r"/customer/\d+", "/customer/<cuid>", path)
    path = re.sub(r"/billing-arrangement/\d+", "/billing-arrangement/<billId>", path)
    return re.sub(r"\d{6,}", "<id>", path)


def redact_headers(headers: dict[str, str] | None) -> dict[str, str]:
    return {
        name: ("<redacted>" if _SENSITIVE_HEADER.search(name) else value)
        for name, value in (headers or {}).items()
    }


def host_of(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()
