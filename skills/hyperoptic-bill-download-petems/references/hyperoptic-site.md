# Hyperoptic account site (frozen snapshot)

**Last verified: 2026-11-17** by a live `hyperoptic-bill login` and
`download --latest` against a personal account on `account.hyperoptic.com`
(session, bills page, month click, View Bill text, PDF via the download event).
Not yet exercised live: the year selector (other years) and the `/billing/<id>`
network fallback.

This file is the contract the CLI depends on. The checks that enforce it live
in `hyperoptic-bill/hyperoptic_bill/contract.py` (pure, unit-tested) and the
browser driving in `hyperoptic-bill/hyperoptic_bill/site.py`. When the skill
breaks, regenerate this file (see Update procedure) and change those modules
with it.

## Hosts and sign-in

| What | Value |
| --- | --- |
| Account site | `https://account.hyperoptic.com/` |
| Sign-in | Keycloak on `auth.hyperoptic.com` (seen live 2026-11-17 by `hyperoptic-bill login`). The SPA bounces through it on load. Its login cookies have no expiry, so the CLI keeps them in `~/.hyperoptic-bill/session-cookies.json` |
| Sign-in barrier (CLI) | Any host other than `account.hyperoptic.com`, plain `http`, or a path under `/login`, `/logout`, `/auth`, `/realms`, `/protocol/openid-connect` |
| Signed-in markers | Body text contains one of `Dashboard`, `Bills and payments`, `Bills & payments`, `My bills` |

`login` waits for the barrier to clear and a marker to show on three
consecutive one-second polls, then proves the bills page loads.

## Pages

### Bills page

`https://account.hyperoptic.com/bills-and-payments`. Always navigate here
directly: sidebar links can be covered by overlays.

| Element | How the CLI finds it |
| --- | --- |
| Cookie banner | `get_by_role("button", name=/^accept/i)`, clicked if present (best effort) |
| Year selector | First `get_by_role("combobox")`. Native `<select>`: `select_option(label="<year>")`. Otherwise click it, then `get_by_role("option", name="<year>")`. Defaults to the current year, so it is only touched for other years |
| Month names | `get_by_text("<Month>", exact=True)`, January to December. The page is "ready" once `January` is present |

Clicking a month that has a bill navigates to the View Bill page. A month
without a bill does not respond; the CLI treats no navigation within 6 seconds
as "no bill that month".

### View Bill page

`https://account.hyperoptic.com/bills-and-payments/view-bill?invoiceId=<digits>`

The content renders after the navigation. The CLI waits for `Amount due`, then
for the body text to stop changing, then parses `inner_text("body")`:

| Field | Pattern | On failure |
| --- | --- | --- |
| `invoiceId` | The single `invoiceId` query parameter, digits only | `view_bill_shape_changed` (field `invoiceId`) |
| Month, year | `<Month> <YYYY> bill` (e.g. `October 2026 bill`) | `view_bill_shape_changed` (field `heading`) |
| Amount | `£<amount>` then `Amount due` (value before label), commas allowed, normalised to `\d+\.\d{2}` | `amount: null` plus an `amount_unreadable` warning |
| Bill date | e.g. `9 October, 2026` then `Bill date`. The next value is the payment date, so label-then-value is wrong | `billDate: null` plus a `bill_date_unreadable` warning |

Also on the page: "View previous bill" and "View next bill" buttons (unused by
the CLI, which reloads the bills page for each month).

### Download

The "Download PDF bill" control (`get_by_role("button" | "link", name="Download
PDF bill")`, falling back to `get_by_text`). Clicking it makes the browser
download `Invoice-<invoiceId>.pdf`. The CLI catches Playwright's download
event and reads the file from Playwright's temp location (never
`~/Downloads`).

Fallback: if no download event arrives within 30 seconds, the CLI uses a
response captured during the click whose path contains
`/billing/<invoiceId>` and whose content type is a PDF.

The CLI rejects anything under 20 KB, over 20 MB, or not starting with
`%PDF-`. The 20 KB floor is a guess that has not been checked against a real
bill's size; record the real size here after the first live run.

## Billing cycle

Bills are generated around the 9th of each month.

## Update procedure

1. Use Chrome DevTools MCP (investigation only) to sign in and walk the pages
   above. Note the URLs, the visible text of the heading, amount and date
   rows, and the role and name of the download control.
2. Update this file, then `contract.py` (patterns, markers, barrier paths) and
   `site.py` (selectors), and the fake in `tests/test_browser_fake_site.py`.
3. Run the tests, then one live `hyperoptic-bill download --latest`, and
   update **Last verified**.
