"""The pure Peloton contract: token cache, GraphQL shapes, selection, filenames."""

from __future__ import annotations

import json

import pytest
from skill_browser.errors import (
    ApiError,
    ContractChangedError,
    InvalidIdentifierError,
    NotFoundError,
    NotLoggedInError,
)

from peloton_invoice import contract
from peloton_invoice.contract import Invoice, Subscription

NOW = 1_800_000_000.0
TOKEN = "eyJ" + "a" * 40
SUB1 = "11111111-1111-4111-8111-111111111111"
SUB2 = "22222222-2222-4222-8222-222222222222"
INV = "0123456789abcdef0123456789abcdef"


def entry(token=TOKEN, expires=NOW + 3600):
    return json.dumps({"body": {"access_token": token}, "expiresAt": expires})


# -- token -------------------------------------------------------------------


def test_token_key_filter():
    good = "@@auth0spajs@@::abc::https://api.onepeloton.com/::openid profile"
    assert contract.is_token_key(good)
    assert not contract.is_token_key("@@auth0spajs@@::abc::https://other/::openid")
    assert not contract.is_token_key("x::https://api.onepeloton.com/::")


def test_pick_token_first_valid():
    assert contract.pick_token([entry()], NOW) == TOKEN


def test_pick_token_skips_stale_and_malformed():
    entries = [
        "not json",
        json.dumps([1, 2]),
        json.dumps({"body": "x"}),
        entry(token="short"),
        entry(token=42),
        entry(expires=NOW - 1),
        entry(token="eyJ" + "b" * 40),
    ]
    assert contract.pick_token(entries, NOW) == "eyJ" + "b" * 40


def test_pick_token_without_expiry_is_accepted():
    raw = json.dumps({"body": {"access_token": TOKEN}})
    assert contract.pick_token([raw], NOW) == TOKEN


@pytest.mark.parametrize(
    ("entries", "code"),
    [
        ([], "no_token_key"),
        (["garbage", entry(token="x")], "no_access_token"),
        ([entry(expires=NOW - 10), "garbage"], "token_expired"),
    ],
)
def test_pick_token_errors(entries, code):
    with pytest.raises(NotLoggedInError) as info:
        contract.pick_token(entries, NOW)
    assert info.value.code == code
    assert TOKEN not in json.dumps(info.value.as_dict())


# -- urls and identifiers ----------------------------------------------------


@pytest.mark.parametrize(
    ("url", "ok"),
    [
        ("https://account.onepeloton.com/en-GB/mymembership", True),
        ("https://account.onepeloton.com/en-GB/mymembership/", True),
        ("https://account.onepeloton.com/en-GB/mymembership/v2/x", True),
        ("https://account.onepeloton.com/mymembership", False),
        ("https://account.onepeloton.com/EN-gb/mymembership", False),
        ("https://members.onepeloton.com/en-GB/mymembership", False),
        ("https://auth.onepeloton.com/en-GB/mymembership", False),
    ],
)
def test_is_membership_url(url, ok):
    assert contract.is_membership_url(url, "account.onepeloton.com") is ok


def test_locale_and_country():
    url = "https://account.onepeloton.com/en-GB/mymembership"
    assert contract.locale_from_url(url) == "en-GB"
    assert contract.locale_from_url("https://x/mymembership") is None
    assert contract.country_of("de-DE") == "DE"


def test_markers_are_exact():
    assert contract.has_signed_in_marker("... Memberships on file ...")
    assert not contract.has_signed_in_marker("Membership Terms | Subscriptions")


def test_receipt_path_only_from_valid_parts():
    assert contract.receipt_path("en-GB", SUB1, INV) == (
        f"/en-GB/mymembership/v2/subscriptions/{SUB1}/invoices/{INV}"
    )
    for bad in (
        ("en-GB/..", SUB1, INV),
        ("en-GB", "../x", INV),
        ("en-GB", SUB1, INV.upper()),
    ):
        with pytest.raises(InvalidIdentifierError):
            contract.receipt_path(*bad)


# -- GraphQL results ---------------------------------------------------------


def test_gql_ok():
    assert contract.check_gql_result({"status": 200, "body": {"data": {}}}, "subs") == {
        "data": {}
    }


@pytest.mark.parametrize(
    ("result", "cls", "code"),
    [
        (None, ApiError, "network_error"),
        ({"networkError": "timeout"}, ApiError, "network_error"),
        ({"status": 401}, NotLoggedInError, "subs_unauthorized"),
        ({"status": 500}, ApiError, "subs_failed"),
        ({"status": 200, "parseError": True}, ContractChangedError, "subs_unparseable"),
        (
            {"status": 200, "body": {"errors": [{"message": "boom"}]}},
            ContractChangedError,
            "subs_graphql_error",
        ),
    ],
)
def test_gql_errors(result, cls, code):
    with pytest.raises(cls) as info:
        contract.check_gql_result(result, "subs")
    assert info.value.code == code


# -- subscriptions -----------------------------------------------------------


def subs_body(*subs):
    return {"data": {"subPelotonMember": {"subscriptions": list(subs)}}}


def sub(sid, strategy="AutoDebit", active=True, status="Active"):
    return {
        "id": sid,
        "isActive": active,
        "status": status,
        "billingStrategy": strategy,
        "billingPlan": {"id": "ALL_ACCESS_MONTHLY"},
    }


def test_parse_subscriptions_filters_bad_ids():
    subs = contract.parse_subscriptions(
        subs_body(sub(SUB1), sub("not-a-uuid"), {"id": 5}, "junk")
    )
    assert [s.id for s in subs] == [SUB1]
    assert subs[0].plan == "ALL_ACCESS_MONTHLY"


def test_parse_subscriptions_shape_changed():
    with pytest.raises(ContractChangedError) as info:
        contract.parse_subscriptions({"data": {"other": {}}})
    assert info.value.code == "subs_shape_changed"
    assert info.value.details["dataKeys"] == ["other"]


def test_classify_active_first_and_hints():
    subs = contract.parse_subscriptions(
        subs_body(
            sub(SUB2, active=False, status="Cancelled"),
            sub("33333333-3333-4333-8333-333333333333", "NotBilled", active=False),
            sub(SUB1),
            sub("44444444-4444-4444-8444-444444444444", "Bango"),
        )
    )
    candidates, others = contract.classify(subs)
    assert [s.id for s in candidates] == [SUB1, SUB2]
    hints = {s.billingStrategy: s.as_dict()["hint"] for s in others}
    assert "mobile carrier" in hints["Bango"]
    assert "Never charged" in hints["NotBilled"]
    assert "hint" not in candidates[0].as_dict()


def test_unknown_biller_gets_generic_hint():
    s = Subscription(SUB1, True, "Active", "Venmo", None)
    assert "Venmo" in s.as_dict()["hint"]


# -- invoices ----------------------------------------------------------------


def inv(iid, date, cents=4500, currency="GBP", tax=750, created=None):
    return {
        "id": iid,
        "createdAt": created or date,
        "invoicePayments": [
            {
                "paymentDate": date,
                "totalAmount": {"currencyCode": currency, "centAmount": cents},
            }
        ]
        if date
        else [],
        "billingSummary": {
            "totalAmount": {"currencyCode": currency, "centAmount": cents},
            "tax": {"centAmount": tax},
        },
    }


def history_body(*invoices):
    return {
        "data": {"subPelotonSubscription": {"id": SUB1, "pastInvoices": list(invoices)}}
    }


def hexid(n):
    return f"{n:032x}"


def test_parse_invoices_fields_and_order():
    invoices = contract.parse_invoices(
        history_body(
            inv(hexid(1), "2026-09-07T19:10:49.000Z"),
            inv(hexid(2), "2026-10-07T19:10:49.000Z", cents=4999, tax=None),
        ),
        SUB1,
    )
    first = invoices[0]
    assert first.as_dict() == {
        "id": hexid(2),
        "subscriptionId": SUB1,
        "month": "October",
        "year": 2026,
        "displayDate": "07/10/2026",
        "paymentDate": "2026-10-07T19:10:49.000Z",
        "amount": "49.99",
        "currency": "GBP",
        "tax": None,
    }
    assert invoices[1].tax == "7.50"


def test_parse_invoices_month_is_utc():
    # 23:30 on 31 Oct in UTC-1 is 00:30 on 1 Nov in UTC: November.
    invoices = contract.parse_invoices(
        history_body(inv(hexid(1), "2026-10-31T23:30:00-01:00")), SUB1
    )
    assert (invoices[0].month, invoices[0].displayDate) == ("November", "01/11/2026")


def test_parse_invoices_falls_back_to_created_at():
    invoices = contract.parse_invoices(
        history_body(inv(hexid(1), None, created="2026-05-07T19:00:00Z")), SUB1
    )
    assert invoices[0].month == "May"


@pytest.mark.parametrize(
    ("raw", "field"),
    [
        (inv("ABCDEF" + "0" * 26, "2026-01-01T00:00:00Z"), "id"),
        (inv(hexid(1) + "/..", "2026-01-01T00:00:00Z"), "id"),
        (inv("1234ABCD-1a2b-3c4d-5e6f-1234567890ab", "2026-01-01T00:00:00Z"), "id"),
        (inv("1234abcd-1a2b-3c4d-5e6f-1234567890ab/..", "2026-01-01T00:00:00Z"), "id"),
        (inv(hexid(1), "yesterday"), "paymentDate"),
        ({"id": hexid(1)}, "paymentDate"),
    ],
)
def test_parse_invoices_guards(raw, field):
    with pytest.raises(ContractChangedError) as info:
        contract.parse_invoices(history_body(raw), SUB1)
    assert info.value.code == "invoice_shape_changed"
    assert info.value.details["field"] == field


def test_parse_invoices_accepts_both_id_formats():
    """Live (2026-11-17): the newest invoice has a dashed UUID, older ones 32 hex."""
    uuid_id = "1234abcd-1a2b-3c4d-5e6f-1234567890ab"
    invoices = contract.parse_invoices(
        history_body(
            inv(uuid_id, "2026-11-07T19:00:00Z"),
            inv(hexid(1), "2026-10-07T19:00:00Z"),
        ),
        SUB1,
    )
    assert [i.id for i in invoices] == [uuid_id, hexid(1)]
    assert contract.validate_invoice_id(uuid_id) == uuid_id
    assert contract.receipt_path("en-GB", SUB1, uuid_id).endswith(
        "/invoices/" + uuid_id
    )


def test_parse_invoices_bad_amounts_become_none():
    invoices = contract.parse_invoices(
        history_body(
            inv(hexid(1), "2026-01-07T19:00:00Z", cents=True, currency="gbp"),
            inv(hexid(2), "2026-02-07T19:00:00Z", cents=-5, currency=None),
        ),
        SUB1,
    )
    for invoice in invoices:
        assert invoice.amount is None
        assert invoice.currency is None


def test_parse_invoices_shape_changed():
    with pytest.raises(ContractChangedError) as info:
        contract.parse_invoices(
            {"data": {"subPelotonSubscription": {"id": SUB1}}}, SUB1
        )
    assert info.value.code == "history_shape_changed"


# -- selection ---------------------------------------------------------------


def make(iid, sid, date, amount="45.00", currency="GBP"):
    paid = contract.parse_date(date)
    return Invoice(
        id=iid,
        subscriptionId=sid,
        month=contract.MONTHS[paid.month - 1],
        year=paid.year,
        displayDate=f"{paid.day:02d}/{paid.month:02d}/{paid.year}",
        paymentDate=date,
        amount=amount,
        currency=currency,
        tax="7.50",
    )


ACTIVE = Subscription(SUB1, True, "Active", "AutoDebit", None)
OLD = Subscription(SUB2, False, "Cancelled", "AutoDebit", None)
OCT = make(hexid(1), SUB1, "2026-10-07T19:00:00Z")
SEP = make(hexid(2), SUB1, "2026-09-07T19:00:00Z")
MAR24 = make(hexid(3), SUB2, "2024-03-07T19:00:00Z")
MAR25 = make(hexid(4), SUB1, "2025-03-07T19:00:00Z")


def test_latest_from_primary():
    history = [(ACTIVE, [OCT, SEP]), (OLD, [MAR24])]
    assert contract.select_invoice(history) == OCT


def test_latest_falls_back_to_newest_candidate():
    newer_old = make(hexid(5), SUB2, "2026-11-01T19:00:00Z")
    history = [(ACTIVE, []), (OLD, [MAR24, newer_old])]
    assert contract.select_invoice(history) == newer_old


def test_month_found_on_cancelled_subscription():
    history = [(ACTIVE, [OCT, SEP, MAR25]), (OLD, [MAR24])]
    picked = contract.select_invoice(history, month="March", year=2024)
    assert picked == MAR24
    assert picked.subscriptionId == SUB2


def test_month_without_year_picks_most_recent_year():
    history = [(ACTIVE, [OCT, SEP, MAR25]), (OLD, [MAR24])]
    assert contract.select_invoice(history, month="March") == MAR25


def test_year_only_picks_newest_in_year():
    history = [(ACTIVE, [OCT, SEP])]
    assert contract.select_invoice(history, year=2026) == OCT


def test_ambiguous_month():
    retry = make(hexid(9), SUB1, "2026-10-09T19:00:00Z")
    history = [(ACTIVE, [retry, OCT])]
    with pytest.raises(NotFoundError) as info:
        contract.select_invoice(history, month="October", year=2026)
    assert info.value.code == "ambiguous_month"
    assert [o["invoiceId"] for o in info.value.details["options"]] == [
        hexid(1),
        hexid(9),
    ]
    assert contract.select_invoice(history, invoice_id=hexid(9)) == retry
    assert contract.shares_month(history, retry)
    assert not contract.shares_month([(ACTIVE, [OCT, SEP])], OCT)


def test_missing_month_lists_available():
    history = [(ACTIVE, [OCT, SEP]), (OLD, [MAR24])]
    with pytest.raises(NotFoundError) as info:
        contract.select_invoice(history, month="January", year=2019)
    assert info.value.code == "bill_not_found"
    available = info.value.details["available"]
    assert [(a["month"], a["year"]) for a in available] == [
        ("October", 2026),
        ("September", 2026),
        ("March", 2024),
    ]


def test_unknown_invoice_id():
    with pytest.raises(NotFoundError) as info:
        contract.select_invoice([(ACTIVE, [OCT])], invoice_id=hexid(77))
    assert info.value.code == "bill_not_found"
    with pytest.raises(InvalidIdentifierError):
        contract.select_invoice([(ACTIVE, [OCT])], invoice_id="nope")


def test_no_invoices_at_all():
    with pytest.raises(NotFoundError) as info:
        contract.select_invoice([(ACTIVE, []), (OLD, [])])
    assert info.value.code == "no_invoices"


def test_no_invoice_billers_error():
    apple = Subscription(SUB1, True, "Active", "Apple", None)
    err = contract.no_invoice_billers([apple])
    assert err.code == "no_peloton_invoices"
    assert "App Store" in err.details["billers"][0]["hint"]


# -- filenames and warnings --------------------------------------------------


def test_filename_variants():
    assert contract.invoice_filename(OCT, several_in_month=False) == (
        "Peloton_Invoice_October_2026_GBP45.00.pdf"
    )
    assert contract.invoice_filename(OCT, several_in_month=True) == (
        f"Peloton_Invoice_October_2026_GBP45.00_{hexid(1)[:8]}.pdf"
    )
    no_currency = make(hexid(1), SUB1, "2026-10-07T19:00:00Z", currency=None)
    assert contract.invoice_filename(no_currency, several_in_month=False) == (
        "Peloton_Invoice_October_2026.pdf"
    )
    no_amount = make(hexid(1), SUB1, "2026-10-07T19:00:00Z", amount=None)
    assert contract.invoice_filename(no_amount, several_in_month=False) == (
        "Peloton_Invoice_October_2026.pdf"
    )
    usd = make(hexid(1), SUB1, "2026-10-07T19:00:00Z", currency="USD")
    assert "USD45.00" in contract.invoice_filename(usd, several_in_month=False)


def test_sanity_warnings():
    assert contract.sanity_warnings(OCT, "en-GB") == []
    warns = contract.sanity_warnings(
        make(hexid(1), SUB1, "2026-10-07T19:00:00Z", amount=None, currency=None),
        "de-DE",
    )
    assert len(warns) == 3


# -- receipt -----------------------------------------------------------------

RECEIPT = (
    "Peloton Interactive UK Limited VAT ID Number GB1 Payment date 07/10/2026 "
    "Total £45.00 Total amount paid"
)


def test_receipt_checks_pass():
    contract.check_receipt_text(RECEIPT, OCT)


def test_receipt_mismatch_names_failed_checks():
    with pytest.raises(ContractChangedError) as info:
        contract.check_receipt_text(RECEIPT.replace("45.00", "40.00"), OCT)
    assert info.value.code == "receipt_mismatch"
    assert info.value.details["failed"] == ["hasAmount"]


@pytest.mark.parametrize(
    ("text", "ok"),
    [
        ("Total £45.00 paid", True),
        ("Total\n45.00\n", True),
        ("Total £145.00 paid", False),
        ("Total £1,045.00 paid", False),
        ("Total £45.001", False),
        ("Total £0.45.00", False),
    ],
)
def test_amount_must_be_a_whole_number(text, ok):
    """Review finding: 45.00 must not pass on a receipt that says 145.00."""
    assert contract.has_amount(text, "45.00") is ok


def test_receipt_with_a_larger_total_is_a_mismatch():
    with pytest.raises(ContractChangedError) as info:
        contract.check_receipt_text(RECEIPT.replace("£45.00", "£145.00"), OCT)
    assert info.value.details["failed"] == ["hasAmount"]


CAPTURE = (
    "<!DOCTYPE html><html><head><style>.x{content:'45.00'}</style></head>"
    "<body><p>Peloton Interactive UK Limited</p><p>VAT ID Number GB1</p>"
    "<td>07/10/2026</td><td>&pound;45.00</td><p>Total amount paid</p></body></html>"
)


def test_capture_content_passes():
    contract.check_capture_content(CAPTURE, OCT)


def test_capture_that_lost_the_receipt_fails():
    """Sanitising once stripped the whole receipt; the printed HTML is re-checked."""
    stripped = "<!DOCTYPE html><html><head><style>.x{content:'45.00'}</style></head><body></body></html>"
    with pytest.raises(ContractChangedError) as info:
        contract.check_capture_content(stripped, OCT)
    assert info.value.code == "capture_mismatch"
    # Text inside <style> does not count as receipt content.
    assert "hasAmount" in info.value.details["failed"]


def test_receipt_without_amount_skips_amount_check():
    no_amount = make(hexid(1), SUB1, "2026-10-07T19:00:00Z", amount=None)
    assert "hasAmount" not in contract.receipt_checks(RECEIPT, no_amount)


@pytest.mark.parametrize(
    ("result", "cls", "code"),
    [
        (None, ContractChangedError, "capture_failed"),
        ("ERROR:wrong_page", ContractChangedError, "wrong_page"),
        ("ERROR:receipt_not_rendered", ApiError, "receipt_not_rendered"),
        ("ERROR:invalid_identifier", InvalidIdentifierError, "invalid_identifier"),
        ("<html><head></head></html>", ContractChangedError, "body_missing"),
        (
            "<html><body><SCRIPT>x</SCRIPT></body></html>",
            ContractChangedError,
            "script_survived",
        ),
    ],
)
def test_validate_capture_rejects(result, cls, code):
    with pytest.raises(cls) as info:
        contract.validate_capture(result)
    assert info.value.code == code


def test_validate_capture_ok():
    html = "<!DOCTYPE html>\n<html><body>Total amount paid</body></html>"
    assert contract.validate_capture(html) == html
