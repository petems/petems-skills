# Three UK My3 API — frozen snapshot

**Last verified: 2026-05-17** against a personal account on `www.three.co.uk`.

This file is the contract the skill depends on. When the skill breaks, regenerate this file by running the skill in DevTools, watching the network panel, and updating both this file and `SKILL.md` step 4/5 together.

## Identifiers

| Name | Where it comes from | Notes |
| --- | --- | --- |
| `cuid` (customer ID) | `_tms_persistUser` cookie, `cuid` field | Not HttpOnly, JS-readable. URL-decode then JSON-parse. |
| `billId` (billing arrangement ID) | Seed response, `financialAccount.id` (or `billingArrangement.id`) | For personal accounts equals `cuid`. Do not hardcode that; read it from the seed response. |
| `billNumber` | List response, `bills[i].data.billNumber` | Short 3-digit suffix (e.g. `113`). Per-account, monotonically increasing. |

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

- `uxfauthorization` — opaque token string. Required for every subsequent call.

#### Seed: response body fields we read

- `financialAccount.id` (or `billingArrangement.id`) — the `billId`.

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
      "month": 3,                 // 0-indexed (0=Jan, 11=Dec)
      "year": 2026,
      "data": {
        "billNumber": "113",
        "billAmount": "45.99",
        "billCloseDate": "...",
        "billStartDate": "...",
        "billEndDate": "...",
        "paymentDueDate": "..."
      }
    },
    // ...
  ]
}
```

#### List bills: response headers we re-read

- `uxfauthorization` — overwrites the saved token (rotated).

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

- April 2026 bill: 1,192,590 bytes
- March 2026 bill: 1,190,524 bytes

## Update procedure

If the skill starts failing with `seed_failed`, `list_shape_changed`, or `pdf_content_type:...`:

1. Open `https://www.three.co.uk/account` in a regular browser and log in.
2. Open DevTools → Network → filter for `rp-server-b2c`.
3. Click through the bills section and watch the requests.
4. Compare the live URLs, headers, and body shapes against this file.
5. Update both this file and the matching JavaScript in `SKILL.md` steps 3, 4, and 5.
6. Re-run the skill end-to-end before committing.
