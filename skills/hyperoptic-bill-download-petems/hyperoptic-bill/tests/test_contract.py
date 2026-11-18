"""The pure Hyperoptic contract: URLs, page text, validation and filenames."""

from __future__ import annotations

import pytest
from skill_browser.errors import ContractChangedError, InvalidIdentifierError

from hyperoptic_bill import contract
from hyperoptic_bill.contract import Bill

BASE = contract.BASE_URL
VIEW = f"{BASE}/bills-and-payments/view-bill?invoiceId=84623147"

# Shape of the live page text (2026-11-17): each value comes before its label.
PAGE = """Bills and paymentsView Bill
Service status:
Active
October 2026 bill
£53.00
Amount due
9 October, 2026
Bill date
23 October, 2026
Payment date
Direct Debit
Payment method
Bill breakdown
Download PDF bill
Your package
£53.00
Monthly service charge
£73.00
"""


# -- auth barrier --------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "barrier"),
    [
        (f"{BASE}/bills-and-payments", None),
        (f"{BASE}/", None),
        (f"{BASE}/login", "sign-in route /login"),
        (
            f"{BASE}/realms/hyperoptic/protocol/openid-connect/auth",
            "sign-in route /realms",
        ),
        (
            "https://sso.hyperoptic.com/auth?x=1",
            "off-site redirect to sso.hyperoptic.com",
        ),
        (
            "http://account.hyperoptic.com/bills-and-payments",
            "off-site redirect to account.hyperoptic.com",
        ),
        ("about:blank", "off-site redirect to an unknown host"),
    ],
)
def test_auth_barrier(url, barrier):
    assert contract.auth_barrier(url) == barrier


def test_auth_barrier_never_echoes_query():
    reason = contract.auth_barrier("https://idp.example/auth?code=SECRET")
    assert "SECRET" not in reason


def test_auth_barrier_with_test_base_url():
    base = "http://127.0.0.1:8123"
    assert contract.auth_barrier(f"{base}/bills-and-payments", base) is None
    assert contract.auth_barrier(f"{BASE}/bills-and-payments", base) is not None


def test_signed_in_marker():
    assert contract.has_signed_in_marker("Welcome\nDASHBOARD\n")
    assert contract.has_signed_in_marker(PAGE)
    assert not contract.has_signed_in_marker("Sign in to your account\nPassword")


# -- identifiers ---------------------------------------------------------------


def test_invoice_id_from_url():
    assert contract.invoice_id_from_url(VIEW) == "84623147"
    assert contract.invoice_id_from_url(f"{BASE}/bills-and-payments") is None
    assert contract.invoice_id_from_url(f"{VIEW}&invoiceId=2") is None
    assert (
        contract.invoice_id_from_url(
            f"{BASE}/bills-and-payments/view-bill?invoiceId=12;rm"
        )
        is None
    )
    assert (
        contract.invoice_id_from_url(
            "https://evil.example/bills-and-payments/view-bill?invoiceId=1"
        )
        is None
    )


@pytest.mark.parametrize("value", ["84623147", 84623147])
def test_validate_invoice_id(value):
    assert contract.validate_invoice_id(value) == "84623147"


@pytest.mark.parametrize("value", ["", "12a", "1 2", None, "../1", 1.5])
def test_validate_invoice_id_rejects(value):
    with pytest.raises(InvalidIdentifierError):
        contract.validate_invoice_id(value)


# -- amounts -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "out"),
    [
        ("53.00", "53.00"),
        ("53", "53.00"),
        ("53.5", "53.50"),
        ("1,053.50", "1053.50"),
        ("007.10", "7.10"),
        ("53.001", None),
        ("-5.00", None),
        ("abc", None),
        (None, None),
    ],
)
def test_normalise_amount(raw, out):
    assert contract.normalise_amount(raw) == out


# -- view bill page ------------------------------------------------------------


def test_parse_view_bill():
    bill = contract.parse_view_bill(PAGE, VIEW)
    assert bill == Bill("84623147", "October", 2026, "53.00", "9 October, 2026", [])


def test_bill_date_is_not_the_payment_date():
    """Regression: label-then-value parsing took the payment date (live, 2026-11-17)."""
    bill = contract.parse_view_bill(PAGE, VIEW)
    assert bill.billDate == "9 October, 2026"
    assert "23 October" not in (bill.billDate or "")


def test_parse_view_bill_tolerates_layout():
    text = "october 2026 BILL\n£ 1,234.5 Amount due\n9th   October 2026  Bill date"
    bill = contract.parse_view_bill(text, VIEW)
    assert (bill.month, bill.year, bill.amount, bill.billDate) == (
        "October",
        2026,
        "1234.50",
        "9th October 2026",
    )


def test_missing_amount_is_a_warning_not_a_failure():
    bill = contract.parse_view_bill("March 2026 bill\n9 March, 2026\nBill date", VIEW)
    assert bill.amount is None
    assert bill.warnings[0].startswith("amount_unreadable")


def test_missing_bill_date_is_a_warning():
    bill = contract.parse_view_bill("March 2026 bill\n£1.00\nAmount due", VIEW)
    assert bill.billDate is None
    assert any(w.startswith("bill_date_unreadable") for w in bill.warnings)


def test_missing_heading_fails():
    with pytest.raises(ContractChangedError) as info:
        contract.parse_view_bill("Amount due £53.00", VIEW)
    assert info.value.code == "view_bill_shape_changed"
    assert info.value.details["field"] == "heading"


def test_missing_invoice_id_fails():
    with pytest.raises(ContractChangedError) as info:
        contract.parse_view_bill(PAGE, f"{BASE}/bills-and-payments/view-bill")
    assert info.value.details["field"] == "invoiceId"


def test_bad_year_in_heading_fails():
    with pytest.raises(ContractChangedError):
        contract.parse_view_bill("October 1999 bill\nAmount due £1.00", VIEW)


# -- month iteration -----------------------------------------------------------


def test_months_back_within_year():
    assert contract.months_back("March", 2026, 3) == [
        ("March", 2026),
        ("February", 2026),
        ("January", 2026),
    ]


def test_months_back_crosses_year_boundary():
    out = contract.months_back("February", 2026)
    assert len(out) == 13
    assert out[:4] == [
        ("February", 2026),
        ("January", 2026),
        ("December", 2025),
        ("November", 2025),
    ]
    assert out[-1] == ("February", 2025)


# -- filenames and URL classes -------------------------------------------------


def test_filename():
    bill = Bill("1", "March", 2026, "53.00", None)
    assert contract.bill_filename(bill) == "Hyperoptic_Bill_March_2026_GBP53.00.pdf"
    no_amount = Bill("1", "March", 2026, None, None)
    assert contract.bill_filename(no_amount) == "Hyperoptic_Bill_March_2026.pdf"


def test_is_billing_url():
    assert contract.is_billing_url(f"{BASE}/api/billing/1")
    assert contract.is_billing_url(f"{BASE}/billing/84623147")
    assert contract.is_billing_url(f"{BASE}/bills-and-payments")
    assert not contract.is_billing_url(f"{BASE}/static/app.js")
    assert not contract.is_billing_url("https://tracker.example/api/x")


def test_is_bill_pdf_url():
    assert contract.is_bill_pdf_url(f"{BASE}/api/billing/84623147?x=1", "84623147")
    assert contract.is_bill_pdf_url(f"{BASE}/billing/84623147/pdf", "84623147")
    assert not contract.is_bill_pdf_url(f"{BASE}/api/billing/846231470", "84623147")
    assert not contract.is_bill_pdf_url(f"{BASE}/api/billing/1", "84623147")
