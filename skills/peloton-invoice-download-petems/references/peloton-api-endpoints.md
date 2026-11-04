# Peloton account invoices API (frozen snapshot)

**Last verified: 2026-11-04** against a UK All-Access (hardware) membership on
`account.onepeloton.com`.

This file is the contract the skill depends on. When the skill breaks,
regenerate it by loading the membership page in DevTools, watching the network
panel, and updating both this file and `SKILL.md` steps 3 to 6 together.

## Sites

| Host | Role |
| --- | --- |
| `account.onepeloton.co.uk/mymembership` | Entry URL. Redirects to `account.onepeloton.com/en-GB/mymembership` |
| `account.onepeloton.com` | Next.js account app. Membership details, payment history, receipts |
| `members.onepeloton.com` | Classes app. **No invoices here.** `/preferences/subscriptions` is a 404 |
| `auth.onepeloton.com` | Auth0 login. Footer contains "Membership Terms" (beware loose `wait_for` text) |
| `graph.prod.k8s.onepeloton.com/graphql` | Apollo GraphQL gateway used by the account app |
| `api.onepeloton.com` | Legacy REST API (`/api/me`, `/api/v2/user/subscriptions`). Not needed |

## Auth

- Bearer token from Auth0 SPA JS, stored in `localStorage` under a key shaped
  `@@auth0spajs@@::<client_id>::https://api.onepeloton.com/::openid profile email offline_access`.
- Value is JSON: `{ body: { access_token, ... }, expiresAt: <unix seconds> }`.
  Observed lifetime about 48 hours.
- The account app and the members app use **different** Auth0 client IDs, so
  read the key on whichever origin you are on. Filter by prefix and audience,
  not by a hardcoded client ID.
- Cookies alone are not enough: `api.onepeloton.com` returns
  `401 {"error_code":3020,"message":"Not logged in"}` without the bearer header.
- Headers the app sends to GraphQL: `authorization: Bearer <token>`,
  `content-type: application/json`, `apollographql-client-name: account`.
  Only `authorization` and `content-type` are strictly required.

## Identifiers

| Name | Format | Source |
| --- | --- | --- |
| Subscription ID | UUID with dashes (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) | `subPelotonMember.subscriptions[].id`. Also in the "Membership details" link |
| Invoice ID | 32 lowercase hex chars, no dashes | `subPelotonSubscription.pastInvoices[].id`. Also in each "View" link |

## GraphQL operations

### List subscriptions

The app's own operation is `MembershipAnalyticsData`. The skill uses a
trimmed equivalent:

```graphql
query Subs($input: SubPelotonMemberInput!) {
  subPelotonMember(input: $input) {
    subscriptions { id isActive status billingStrategy billingPlan { id subscriptionType } }
  }
}
```

Variables: `{ "input": { "billingStrategyFilters": [], "subscriptionTypeFilters": [], "country": "GB" } }`

Observed response (IDs redacted):

```jsonc
{ "data": { "subPelotonMember": { "subscriptions": [
  { "id": "<uuid>", "isActive": true,  "status": "Active",       "billingStrategy": "AutoDebit",
    "billingPlan": { "id": "ALL_ACCESS_MONTHLY", "subscriptionType": "Hardware" } },
  { "id": "<uuid>", "isActive": false, "status": "Discontinued", "billingStrategy": "NotBilled",
    "billingPlan": { "id": "PRE_DELIVERY", "subscriptionType": "DigitalPreDelivery" } }
] } } }
```

`billingStrategy` values seen in the app's filter list: `Amazon`, `Apple`,
`AutoDebit`, `Bango`, `Google`, `NotBilled`, `Roku`. Only `AutoDebit` has
Peloton-issued invoices. `Bango` is a carrier and partner billing platform, so
those charges appear on the mobile carrier's or partner's bill. Only
`AutoDebit` and `NotBilled` were observed on the reference account; the other
values come from the app's own filter list.

- `country` comes from the locale in the account URL (`/en-GB/` gives `GB`).
  Only `GB` has been verified.
- A member can have several `AutoDebit` subscriptions over time (for example a
  cancelled one and a newer active one). Each has its own `pastInvoices`, so an
  old invoice may only appear on the cancelled subscription.

### Payment history

The app's operation name is `PaymentHistory`. The skill requests a subset of
its fields:

```graphql
query PaymentHistory($input: SubPelotonSubscriptionInput!) {
  subPelotonSubscription(input: $input) {
    id
    pastInvoices {
      id
      createdAt
      invoicePayments { paymentDate totalAmount { currencyCode centAmount } }
      billingSummary { totalAmount { currencyCode centAmount } tax { centAmount } }
    }
  }
}
```

Variables: `{ "input": { "subscriptionId": "<uuid>" } }` (the app also sends
`featureFlags: [{ type: "IsV2MembershipDetails", value: true }]`. It is not required.)

Observed entry:

```jsonc
{
  "id": "<32-hex>",
  "createdAt": "2026-10-07T19:10:49.000Z",
  "invoicePayments": [{
    "label": "Amex 1234", "paymentType": "CREDIT_CARD",
    "paymentDate": "2026-10-07T19:10:49.000Z",
    "totalAmount": { "currencyCode": "GBP", "centAmount": 4500 }
  }],
  "offerings": [],   // empty on this account; the UI shows "Peloton All-Access"
  "billingSummary": {
    "totalAmount": { "currencyCode": "GBP", "centAmount": 4500 },
    "originalSubtotalInCents": { "currencyCode": "GBP", "centAmount": 3750 },
    "tax": { "currencyCode": "GBP", "centAmount": 750 },
    "discount": { "currencyCode": "GBP", "centAmount": 0 }
  }
}
```

- Returned newest-first. Sort by `paymentDate` anyway.
- `centAmount` is an integer in minor units (pence).
- The full history is returned in one call (18 invoices on the reference
  account, May 2025 to October 2026). The UI's year selector filters on the client side.
- Payments land around 19:00 UTC on the renewal day, so the UTC date matches the UK date.

## Receipt page

```text
https://account.onepeloton.com/{locale}/mymembership/v2/subscriptions/{subscriptionId}/invoices/{invoiceId}
```

`{locale}` is the path segment the account site redirected to (`en-GB` on the
reference account). `{subscriptionId}` must be the subscription the invoice
came from.

- `text/html`, rendered client-side. Wait for "Total amount paid".
- No PDF or download control. The site expects the user to print the page.
- Contents: Peloton logo, "Peloton Interactive UK Limited", registered address,
  "VAT ID Number", the member's name and billing address, then a table with
  Payment date (dd/mm/yyyy), Description, Subtotal, Tax, Discount, Total cost,
  Payment methods (masked card), Total paid, and "Total amount paid".
- A cookie consent overlay (`#fides-overlay`) is present. `<body>` carries a
  `fides-overlay-modal-link-shown` class, so never strip elements by
  `[class*="fides"]`.

### Offline capture hardening

The skill prints a captured copy, not the live page. Before serialising it:

- removes `script`, `noscript`, frames, `object`, `embed`, `link`, `style`,
  `meta`, `base`, `form`, and known tracker and consent elements;
- removes every `on*` attribute and any `javascript:` URL;
- prepends a CSP meta tag:
  `default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline' https:; img-src https: data:; font-src https: data:`.

Verified 2026-11-04: the hardened copy renders identically (94,288 bytes, the
same as the unhardened copy). Fonts load via the inlined `@import` from
`fonts.googleapis.com`, which `style-src https:` allows.

### Rendered PDF (reference)

Headless Chrome print of the captured HTML: 1 page A4, about 94 KB, text
extractable with `pdftotext`. A blank render is 872 bytes.

## MCP tool constraints

- `evaluate_script` `args` accepts element uids only. Inline values as literals.
- `evaluate_script` `filePath` output is JSON-encoded. Decode with `json.load` before use.
- `evaluate_script` `filePath` and `sourcePath` are sandboxed to the workspace
  roots (`/tmp` is rejected for both, verified 2026-11-04). The receipt capture therefore lands in the project
  directory, which is why the skill moves it to `/tmp` immediately and cleans up
  on every exit path.
- A `~` inside double quotes is not expanded by the shell. Resolve save paths
  to absolute before building commands.
- `get_network_request` prints full request headers, including the bearer token
  and cookies. Avoid it on authenticated Peloton requests.
- The MCP Chrome runs with `--remote-debugging-pipe`, so there is no CDP port
  to drive `Page.printToPDF` from outside. Print with a separate headless Chrome.

## Update procedure

If the skill fails with `*_shape_changed`, `*_graphql_error`, or a blank PDF:

1. Open `https://account.onepeloton.co.uk/mymembership` in a regular browser and log in.
2. DevTools, Network, filter `graphql`. Open "Membership details".
3. Find the `PaymentHistory` operation and compare its query and response with this file.
4. Click a "View" receipt link and compare the URL pattern and page text.
5. Update this file and the matching JavaScript in `SKILL.md` together.
6. Re-run the skill end-to-end before committing.
