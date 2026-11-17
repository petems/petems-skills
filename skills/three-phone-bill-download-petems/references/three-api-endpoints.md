# Three UK My3 API (frozen snapshot)

**Last verified: 2026-11-17** by a live `three-bill login` and `download --latest`
against a personal account on `www.three.co.uk`. Login state lives in the
no-expiry `WIRELESS_SECURITY_TOKEN` and `USER_SESSION_STATUS` cookies, which the
CLI carries across runs (`~/.three-bill/session-cookies.json`); the SPA rebuilds
its sessionStorage from them. After Auth0, wait for the SPA to reach `/account`
and write `persist:user` before navigating, or `/account` bounces to
`/customer-login`.

This file is the contract the `three-bill` CLI depends on. The checks that
enforce it live in `three-bill/three_bill/contract.py` (pure, unit-tested) and
the calls in `three-bill/three_bill/my3.py`. When the skill breaks, regenerate
this file (see Update procedure) and change those modules with it.

## Identifiers

| Name | Where it comes from | Notes |
| --- | --- | --- |
| `cuid` (customer ID) | The SPA's own seed request path while `/account` loads. Fallback: `customerId` in `sessionStorage["persist:customerProfilePersistor"]` | redux-persist double-encodes; parse twice. Empty on `/customer-logged`. Equals the dashboard "Account Number". |
| `billId` (billing arrangement ID) | Seed response, `customer.financialAccount[0].id` | For personal accounts equals `cuid`. Do not hardcode that; read it from the seed response. |
| `billNumber` | List response, `bills[i].data.billNumber` | Short 3-digit suffix (e.g. `116`). Per-account, monotonically increasing. The PDF prints it as `<cuid><billNumber>`. |

**Not** `_tms_persistUser`. That cookie's value is the literal string `false`
(a remember-me flag) and has never contained a `cuid`.

## Auth

Three's API uses a rotating `uxfauthorization` token returned as a
**response header** on every `/rp-server-b2c/` call. The SPA reads it
via the CORS `Access-Control-Expose-Headers` mechanism. The token also
lives in the `WIRELESS_SECURITY_TOKEN` cookie, but that cookie is
HttpOnly, so JS cannot read it directly.

Pattern: each call returns a *new* `uxfauthorization` header. The CLI keeps it
in a Python variable and sends it as `authorization` on the next call. The
first call is the seed call below, which requires no `Authorization` header.
The CLI makes its own seed call rather than reusing the token from the SPA's,
because the SPA spends that token on its own next call.

Seed and list run as same-origin `fetch(..., {credentials: 'include'})` inside
the page (`page.evaluate(js, arg)`), so the HttpOnly session cookies flow
automatically. The PDF is fetched with Playwright's `context.request`, which
shares the persistent context's cookies, with an in-page fetch as fallback.

### Session check (no auth header required)

```text
GET https://www.three.co.uk/rp-server-b2c/authentication/v1/B2C/user
    ?salesChannel=selfService
```

Body field read: `isAnonymous`. Only a literal `false` counts as signed in. A
missing, `null`, string or numeric value fails closed. An Auth0 login can
succeed while this stays `true` (the browser killed mid-flow).

### Pages

- `/customer-login`: sign-in entry; hands off to `auth.three.co.uk` (Auth0).
- `/customer-logged`: post-login marketing landing page. Does **not** populate
  customer state; the cuid reads as `"undefined"` there.
- `/account`: the dashboard. Loading it fires the seed request and fills the
  redux-persist store.

## Endpoints

### Seed (no auth header required)

```text
GET https://www.three.co.uk/rp-server-b2c/care/v1/B2C/customer/{cuid}
    ?salesChannel=selfService
    &initId=Digital
    &levelOfData=owningIndividual,financialAccount
```

#### Seed: response headers we read

- `uxfauthorization`: opaque token string. Required for every subsequent call.

#### Seed: response body fields we read

Top-level keys observed: `customer`, `collectionStatus`,
`equinitiCustomerIndicator`. Everything useful is nested under `customer`:

- `customer.financialAccount[0].id`: the `billId`. Note `financialAccount` is
  an **array**, and it is `[]` in the redux store even when the API returns it.
- `customer.id`: the customer ID (matches `cuid`).
- `customer.owningIndividual.id`: a separate individual ID, not used here.

### List bills

```text
GET https://www.three.co.uk/rp-server-b2c/ebill/v1/customer/{cuid}/billing-arrangement/{billId}/bill
    ?salesChannel=selfService
```

#### List bills: request headers

- `Authorization: <uxfauthorization-from-seed>`

#### List bills: response body shape

```jsonc
{
  "bills": [
    {
      // NOT a calendar month. This is a billing-period counter and always
      // equals data.billPeriod. The entry below is the JULY 2026 bill.
      "month": 5,
      "year": 2026,
      "billStartDate": "2026-06-24T00:00:00Z",
      "slimInd": false,
      "data": {
        "billNumber": "116",
        "billAmount": 33.08,      // a number, not a string
        "billPeriod": 5,
        "billCloseDate": "2026-07-24T00:00:00Z",   // derive the month from this
        "billStartDate": "2026-06-24T00:00:00Z",
        "billEndDate": "2026-07-23T00:00:00Z",
        "paymentDueDate": "2026-08-12T00:00:00Z",
        "currency": "GBP",
        "totalTaxAmount": 5.51,
        "totalChargesBeforeTax": 27.57,
        "prevMonth": { "previousBillAmount": 41.69, /* ... */ }
      }
    },
    // ...
  ]
}
```

The list is returned newest-first, but sort by `billCloseDate` rather than
relying on that.

#### Month mapping

A bill closing on the 24th covers the 24th of the previous month to the 23rd
of the close month. "My July bill" means the bill *issued* in July:
`billCloseDate` = 24 Jul, `billEndDate` = 23 Jul. Observed on this account:

| `month` | `billCloseDate` | Calendar label | `billNumber` | Amount |
| --- | --- | --- | --- | --- |
| 5 | 2026-07-24 | July 2026 | 116 | £33.08 |
| 4 | 2026-06-24 | June 2026 | 115 | £41.69 |
| 3 | 2026-05-24 | May 2026 | 114 | £33.08 |

#### List bills: response headers we re-read

- `uxfauthorization`: overwrites the saved token (rotated).

### Download PDF

```text
GET https://www.three.co.uk/rp-server-b2c/care/v1/customer/{cuid}/billing-arrangement/{billId}/bill/{billNumber}/pdf
    ?salesChannel=selfService
```

Note the path prefix is `/care/v1/`, **not** `/ebill/v1/`.

#### PDF: request headers

- `Authorization: <uxfauthorization-from-list>`

#### PDF: response

- `Content-Type: application/pdf`
- Body is the raw PDF bytes (~1.2 MB on this account).

#### PDF: reference byte sizes

Sanity-check values from this account only:

- July 2026 bill (billNumber 116): 1,196,342 bytes, 4 pages
- April 2026 bill: 1,192,590 bytes
- March 2026 bill: 1,190,524 bytes

## Update procedure

If the CLI starts failing with `seed_failed`, `seed_shape_changed`,
`list_shape_changed`, or `pdf_content_type:...`:

1. Open `https://www.three.co.uk/account` in a regular browser and log in.
2. Open DevTools → Network → filter for `rp-server-b2c`.
3. Click through the bills section and watch the requests.
4. Compare the live URLs, headers, and body shapes against this file.
5. Update this file, `three-bill/three_bill/contract.py` and its tests in
   `three-bill/tests/test_contract.py` together.
6. Re-run `three-bill list` and `three-bill download --latest` end-to-end, and
   the skill's PDF verification step, before committing.

The redacted request log in `~/.three-bill/diagnostics/` from a failed run is a
good starting point for step 4.
