"""The My3 contract, without a browser."""

from __future__ import annotations

import json

import pytest
from skill_browser.diagnostics import redact_headers
from skill_browser.errors import (
    ContractChangedError,
    InvalidIdentifierError,
    NotFoundError,
    NotLoggedInError,
    PdfInvalidError,
)
from skill_browser.months import parse_month

from three_bill import contract
from three_bill.contract import Bill
from three_bill.my3 import (
    Site,
    auth_barrier,
    is_account_url,
    recovery_step,
    validate_pdf,
)


def _bill_entry(number="116", close="2026-07-24T00:00:00Z", amount=33.08, month=5):
    return {
        "month": month,
        "year": 2026,
        "data": {
            "billNumber": number,
            "billAmount": amount,
            "billPeriod": month,
            "billCloseDate": close,
            "billStartDate": "2026-06-24T00:00:00Z",
            "billEndDate": "2026-07-23T00:00:00Z",
        },
    }


# -- identifiers -------------------------------------------------------------


@pytest.mark.parametrize("value", ["949613941", 949613941])
def test_valid_cuid(value):
    assert contract.validate_cuid(value) == "949613941"


@pytest.mark.parametrize(
    "value",
    [
        "",
        "12345",
        "undefined",
        "949613941/../x",
        '949613941"',
        " 949613941",
        "9496 13941",
        None,
        True,
        9.5,
        ["1"],
    ],
)
def test_invalid_cuid(value):
    with pytest.raises(InvalidIdentifierError):
        contract.validate_cuid(value)


def test_invalid_identifier_is_a_contract_error():
    assert issubclass(InvalidIdentifierError, ContractChangedError)


def test_bill_number_must_be_digits():
    with pytest.raises(InvalidIdentifierError):
        contract.pdf_path("949613941", "949613941", "11/6")


def test_paths_are_built_only_from_validated_ids():
    assert contract.pdf_path("949613941", "949613941", "116") == (
        "/rp-server-b2c/care/v1/customer/949613941/billing-arrangement/949613941"
        "/bill/116/pdf?salesChannel=selfService"
    )
    assert "/ebill/v1/" in contract.list_path("949613941", "949613941")
    with pytest.raises(InvalidIdentifierError):
        contract.seed_path("REPLACE_WITH_CUID")


def test_cuid_from_seed_url():
    url = (
        "https://www.three.co.uk/rp-server-b2c/care/v1/B2C/customer/949613941"
        "?salesChannel=selfService&initId=Digital"
    )
    assert contract.cuid_from_seed_url(url) == "949613941"
    assert contract.is_seed_url(url)
    assert not contract.is_seed_url(url.replace("www.three.co.uk", "evil.example"))
    assert not contract.is_seed_url(url.replace("https", "http"))
    assert (
        contract.cuid_from_seed_url(
            "https://www.three.co.uk/rp-server-b2c/care/v1/customer/1/x"
        )
        is None
    )


# -- redux-persist -----------------------------------------------------------


def test_persistor_double_encoding():
    raw = json.dumps({"customerId": json.dumps("949613941"), "other": "{}"})
    assert contract.cuid_from_persistor(raw) == "949613941"


def test_persistor_bare_string():
    assert (
        contract.cuid_from_persistor(json.dumps({"customerId": "949613941"}))
        == "949613941"
    )


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        (None, "persistor_missing"),
        ("", "persistor_missing"),
        ("{not json", "persistor_parse_failed"),
        ("null", "persistor_parse_failed"),
        ('"str"', "persistor_parse_failed"),
        ("[1]", "persistor_parse_failed"),
        (json.dumps({"customerId": json.dumps("undefined")}), "no_cuid_in_store"),
        (json.dumps({"customerId": json.dumps("")}), "no_cuid_in_store"),
        (json.dumps({}), "no_cuid_in_store"),
    ],
)
def test_persistor_failures(raw, code):
    with pytest.raises(ContractChangedError) as info:
        contract.cuid_from_persistor(raw)
    assert info.value.code == code


# -- isAnonymous, fail closed ------------------------------------------------


def test_auth_ok():
    contract.check_auth_body(200, {"isAnonymous": False, "userId": "x"})


@pytest.mark.parametrize(
    ("status", "body", "code"),
    [
        (200, {"isAnonymous": True}, "session_not_authenticated"),
        (200, {}, "session_not_authenticated"),
        (200, {"isAnonymous": None}, "session_not_authenticated"),
        (200, {"isAnonymous": "false"}, "session_not_authenticated"),
        (200, {"isAnonymous": 0}, "session_not_authenticated"),
        (200, None, "auth_check_unparseable"),
        (200, [False], "auth_check_unparseable"),
        (500, {"isAnonymous": False}, "auth_check_failed"),
        (401, None, "auth_check_failed"),
    ],
)
def test_auth_fails_closed(status, body, code):
    with pytest.raises(NotLoggedInError) as info:
        contract.check_auth_body(status, body)
    assert info.value.code == code


# -- seed shape --------------------------------------------------------------


def test_seed_financial_account_array():
    body = {"customer": {"id": "111111111", "financialAccount": [{"id": "222222222"}]}}
    assert contract.bill_id_from_seed(body) == "222222222"


def test_seed_billing_arrangement_fallback():
    body = {
        "customer": {"financialAccount": [], "billingArrangement": {"id": 333333333}}
    }
    assert contract.bill_id_from_seed(body) == "333333333"


@pytest.mark.parametrize(
    "body",
    [
        # customer.id must never be used as the billing arrangement.
        {"customer": {"id": "111111111", "financialAccount": []}},
        {"customer": {"id": "111111111"}},
        # The old, wrong path: financialAccount as an object.
        {"customer": {"financialAccount": {"id": "222222222"}}},
        {"customer": {"financialAccount": [{"id": None}]}},
        {"customer": {"financialAccount": [{"id": True}]}},
        {"customer": {"financialAccount": [{"id": {"x": 1}}]}},
        None,
        [],
    ],
)
def test_seed_shape_changed(body):
    with pytest.raises(ContractChangedError) as info:
        contract.bill_id_from_seed(body)
    assert info.value.code == "seed_shape_changed"


def test_seed_bill_id_must_be_digits():
    with pytest.raises(InvalidIdentifierError):
        contract.bill_id_from_seed(
            {"customer": {"financialAccount": [{"id": "22/2222222"}]}}
        )


# -- bills list and month derivation -----------------------------------------


def test_month_from_close_date_not_month_field():
    # month: 5 is a billing-period counter; this is the JULY 2026 bill.
    [bill] = contract.parse_bills({"bills": [_bill_entry(month=5)]})
    assert (bill.month, bill.year) == ("July", 2026)


@pytest.mark.parametrize(
    ("close", "expected"),
    [
        ("2026-07-24T00:00:00Z", ("July", 2026)),
        ("2026-07-24T00:00:00", ("July", 2026)),  # naive = UTC
        ("2026-01-24T00:00:00.000Z", ("January", 2026)),
        ("2026-08-01T00:30:00+01:00", ("July", 2026)),  # UTC, not local
        ("2026-12-31T23:30:00-01:00", ("January", 2027)),
    ],
)
def test_month_and_year_in_utc(close, expected):
    assert contract.month_and_year(close) == expected


def test_bills_sorted_newest_first():
    body = {
        "bills": [
            _bill_entry("114", "2026-05-24T00:00:00Z"),
            _bill_entry("116", "2026-07-24T00:00:00Z"),
            _bill_entry("115", "2026-06-24T00:00:00Z"),
        ]
    }
    assert [b.billNumber for b in contract.parse_bills(body)] == ["116", "115", "114"]


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({}, "list_shape_changed"),
        ({"bills": {}}, "list_shape_changed"),
        (None, "list_shape_changed"),
        ({"bills": [{"month": 5}]}, "bill_entry_shape_changed"),
        ({"bills": [_bill_entry(number=None)]}, "bill_entry_shape_changed"),
        ({"bills": [_bill_entry(number=116)]}, "bill_entry_shape_changed"),
        ({"bills": [_bill_entry(number="11'6")]}, "bill_entry_shape_changed"),
        ({"bills": [_bill_entry(close=None)]}, "bill_entry_shape_changed"),
        ({"bills": [_bill_entry(close="yesterday")]}, "bill_entry_shape_changed"),
        (
            {"bills": [_bill_entry(close="1970-01-24T00:00:00Z")]},
            "bill_entry_shape_changed",
        ),
    ],
)
def test_list_shape_errors(body, code):
    with pytest.raises(ContractChangedError) as info:
        contract.parse_bills(body)
    assert info.value.code == code


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (33.08, 33.08),
        (40, 40.0),
        ("45.99", 45.99),
        (" 12.5 ", 12.5),
        (None, None),
        ("", None),
        ("  ", None),
        ("abc", None),
        ("NaN", None),
        ("inf", None),
        (float("nan"), None),
        (True, None),
        ({}, None),
    ],
)
def test_bill_amount_normalised(raw, expected):
    assert contract.normalise_amount(raw) == expected


def test_bad_amount_does_not_fail_the_list():
    [bill] = contract.parse_bills({"bills": [_bill_entry(amount="n/a")]})
    assert bill.billAmount is None


# -- choosing and naming -----------------------------------------------------


@pytest.mark.parametrize(
    ("arg", "name"),
    [("March", "March"), ("mar", "March"), ("3", "March"), ("SEPT", "September")],
)
def test_parse_month(arg, name):
    assert parse_month(arg) == name


@pytest.mark.parametrize("arg", ["13", "0", "ma", "Smarch", ""])
def test_parse_month_rejects(arg):
    with pytest.raises(ValueError):
        parse_month(arg)


def _bills():
    return contract.parse_bills(
        {
            "bills": [
                _bill_entry("116", "2026-07-24T00:00:00Z"),
                _bill_entry("115", "2026-06-24T00:00:00Z"),
                _bill_entry("104", "2025-07-24T00:00:00Z"),
            ]
        }
    )


def test_select_latest():
    assert contract.select_bill(_bills(), None, None).billNumber == "116"


def test_select_month_year():
    assert contract.select_bill(_bills(), "July", 2025).billNumber == "104"
    assert contract.select_bill(_bills(), "July", None).billNumber == "116"


def test_select_missing_lists_available():
    with pytest.raises(NotFoundError) as info:
        contract.select_bill(_bills(), "January", 2020)
    assert {"month": "June", "year": 2026} in info.value.details["available"]


def test_filename_with_and_without_amount():
    bill = _bills()[0]
    assert contract.bill_filename(bill) == "Three_UK_Bill_July_2026_GBP33.08.pdf"
    none = Bill(**{**bill.as_dict(), "billAmount": None})
    assert contract.bill_filename(none) == "Three_UK_Bill_July_2026.pdf"
    whole = Bill(**{**bill.as_dict(), "billAmount": 40.0})
    assert contract.bill_filename(whole) == "Three_UK_Bill_July_2026_GBP40.00.pdf"


def test_sanity_warnings():
    assert contract.sanity_warnings(_bills()[0]) == []
    odd = Bill(
        **{
            **_bills()[0].as_dict(),
            "billEndDate": "2026-06-23T00:00:00Z",
            "billAmount": None,
        }
    )
    assert len(contract.sanity_warnings(odd)) == 2


# -- redaction ---------------------------------------------------------------


def test_redact_url():
    url = (
        "https://www.three.co.uk/rp-server-b2c/care/v1/customer/949613941/"
        "billing-arrangement/949613941/bill/116/pdf?salesChannel=selfService&token=abc"
    )
    redacted = contract.redact_url(url)
    assert (
        redacted
        == "/rp-server-b2c/care/v1/customer/<cuid>/billing-arrangement/<billId>/bill/116/pdf"
    )
    assert (
        "949613941" not in redacted
        and "token" not in redacted
        and "three.co.uk" not in redacted
    )


def test_redact_url_catches_stray_ids():
    assert (
        contract.redact_url("https://x/rp-server-b2c/other/949613941")
        == "/rp-server-b2c/other/<id>"
    )


def test_redact_headers():
    headers = {
        "authorization": "t1",
        "uxfauthorization": "t2",
        "Cookie": "a=b",
        "set-cookie": "c=d",
        "x-session-id": "s",
        "content-type": "application/pdf",
    }
    out = redact_headers(headers)
    assert out["content-type"] == "application/pdf"
    assert {v for k, v in out.items() if k != "content-type"} == {"<redacted>"}


# -- URL-based session checks ------------------------------------------------


@pytest.mark.parametrize(
    ("url", "barrier"),
    [
        ("https://www.three.co.uk/account", False),
        ("https://www.three.co.uk/customer-logged", False),
        ("https://www.three.co.uk/customer-login", True),
        ("https://www.three.co.uk/customer-login/", True),
        ("https://auth.three.co.uk/u/login?state=x", True),
        ("http://www.three.co.uk/account", True),
        ("https://www.three.co.uk/account?next=/customer-login", False),
    ],
)
def test_auth_barrier(url, barrier):
    assert bool(auth_barrier(url, Site())) is barrier


def test_auth_barrier_never_echoes_full_url():
    reason = auth_barrier("https://auth.three.co.uk/authorize?code=SECRET", Site())
    assert "SECRET" not in reason


def test_is_account_url():
    assert is_account_url("https://www.three.co.uk/account", Site())
    assert is_account_url("https://www.three.co.uk/account/view-bill", Site())
    assert not is_account_url("https://www.three.co.uk/customer-logged", Site())
    assert not is_account_url("https://www.three.co.uk/accounting", Site())


# -- PDF checks --------------------------------------------------------------

GOOD = b"%PDF-1.7\n" + b"x" * 200_000


def test_pdf_ok():
    validate_pdf(200, "application/pdf", GOOD)
    validate_pdf(200, "application/pdf; charset=binary", GOOD)


@pytest.mark.parametrize(
    ("status", "ctype", "body", "code"),
    [
        (302, "text/html", None, "pdf_status:302"),
        (401, "application/json", None, "pdf_status:401"),
        (200, "text/html; charset=utf-8", b"<html>", "pdf_content_type:text/html"),
        (200, "", None, "pdf_content_type:none"),
        (200, "application/pdf", b"<html>" + b"x" * 200_000, "pdf_not_pdf"),
        (200, "application/pdf", b"%PDF-1.7 tiny", "pdf_too_small"),
        (200, "application/pdf", b"%PDF-" + b"x" * (21 * 1024 * 1024), "pdf_too_large"),
    ],
)
def test_pdf_rejected(status, ctype, body, code):
    with pytest.raises(PdfInvalidError) as info:
        validate_pdf(status, ctype, body)
    assert info.value.code == code


@pytest.mark.parametrize(
    ("url", "step"),
    [
        ("https://www.three.co.uk/account", "account"),
        ("https://www.three.co.uk/account/bills", "account"),
        ("https://auth.three.co.uk/authorize?client_id=x", "auth_silent"),
        ("https://auth.three.co.uk/u/login?state=x", "auth_form"),
        ("https://www.three.co.uk/customer-login", "sign_in_route"),
        ("https://www.three.co.uk/customer-logged", "landing"),
        ("https://www.three.co.uk/", "landing"),
    ],
)
def test_recovery_step(url, step):
    assert recovery_step(url, Site()) == step
