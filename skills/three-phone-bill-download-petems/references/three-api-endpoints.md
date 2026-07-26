# Three UK My3 API (frozen snapshot)

**Last verified: 2026-07-27** against a personal account on `www.three.co.uk`.

This file is the contract the skill depends on. When the skill breaks, regenerate this file by running the skill in DevTools, watching the network panel, and updating both this file and `SKILL.md` step 4/5 together.

## Identifiers

| Name | Where it comes from | Notes |
| --- | --- | --- |
| `cuid` (customer ID) | `sessionStorage["persist:customerProfilePersistor"]`, `customerId` field | redux-persist double-encodes: parse the outer JSON, then parse the `customerId` value again. Only populated once `/account` has loaded. Equals the "Account Number" on the dashboard. |
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

Pattern: each call returns a *new* `uxfauthorization` header. Save it to a `window.` global and use it on the next call. The first call is the seed call below, which requires no `Authorization` header.

All fetches use `credentials: 'include'` so the HttpOnly session cookie flows automatically.

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

## MCP tool constraints

Not API behaviour, but these break the skill just as effectively:

- `evaluate_script` `args` accepts **element uids from a snapshot only**.
  Passing a `cuid` string fails with "No snapshot found for page". Inline
  values as literals in the function body.
- `evaluate_script` `filePath` is sandboxed to the configured workspace roots.
  `/tmp` is rejected. Write inside the project directory.
- `filePath` output is JSON-encoded and the extension is normalised to
  `.json`. A returned base64 string arrives wrapped in `"` quotes; strip them
  before `base64 -d`.

## Update procedure

If the skill starts failing with `seed_failed`, `list_shape_changed`, or `pdf_content_type:...`:

1. Open `https://www.three.co.uk/account` in a regular browser and log in.
2. Open DevTools → Network → filter for `rp-server-b2c`.
3. Click through the bills section and watch the requests.
4. Compare the live URLs, headers, and body shapes against this file.
5. Update both this file and the matching JavaScript in `SKILL.md` steps 3, 4, and 5.
6. Re-run the skill end-to-end before committing.
