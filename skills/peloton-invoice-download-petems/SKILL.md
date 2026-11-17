---
name: peloton-invoice-download-petems
description: >-
  Download and verify Peloton membership invoices (All-Access and App
  memberships billed by Peloton to a card) as PDFs using the bundled
  peloton-invoice CLI, which reads the Peloton account GraphQL API from a
  dedicated Patchright browser profile and prints the receipt page to PDF. Use
  this skill whenever the user wants to download, grab, fetch, or save a
  Peloton invoice, receipt, or membership bill, including for expense or
  fitness reimbursement claims. Memberships billed through an app store or a
  mobile carrier have no Peloton invoice; the skill says so and points to the
  right biller.
license: MIT
allowed-tools:
  - Bash
  - Read
---

# Download a Peloton membership invoice PDF

When the user asks for a Peloton invoice or receipt, follow these steps.

The work is done by `peloton-invoice`, a small Python CLI in this skill's
`peloton-invoice/` directory. It drives its own Patchright Chromium on a
dedicated profile (`~/.peloton-invoice/profile`), loads the membership page,
reads the Auth0 token from the page's cache (the token never leaves the CLI),
and calls the same GraphQL API the site uses to list subscriptions and
invoices. Peloton has no PDF download, so the CLI opens the receipt page,
cross-checks it against the API, captures it with all scripts, handlers,
forms and trackers removed and a script-blocking Content-Security-Policy
added, and prints it in a throwaway headless browser. Nothing but the final
PDF touches the disk, so there is nothing to clean up.

All the shape checks (token cache, subscription billers, invoice id formats,
the UTC payment month, the receipt cross-check, the capture) live in
`peloton-invoice/peloton_invoice/contract.py`. See
`references/peloton-api-endpoints.md` for the URLs, GraphQL operations and
response shapes the CLI depends on.

## Prerequisites

- **peloton-invoice on PATH.** Check with `command -v peloton-invoice`. If it
  is missing, ask the user to install it (it needs `uv`):

  ```bash
  uv tool install --editable "<this skill's base directory>/peloton-invoice"
  ```

  ```bash
  peloton-invoice install-browser
  ```

  If the user would rather not install it, run every command below as
  `uv run --project "<this skill's base directory>/peloton-invoice" peloton-invoice ...`
  instead.
- **A Peloton session in the peloton-invoice profile.** Created once by the
  user with `peloton-invoice login` (see step 3). It persists between runs.
- **poppler** for PDF verification (`brew install poppler` on macOS,
  `apt-get install poppler-utils` on Linux).

## Steps

### 1. Parse user request

Determine:

- **Target month(s)**: Which invoice(s) to download. Default to the latest if
  not specified. Multiple months are supported: run the CLI once per month.
- **Save location**: Where to save the PDF(s). Default to `~/Desktop/` if not
  specified.

**Billing cycle note**: Peloton charges monthly on the membership renewal
date, which is fixed per account (shown as "Renews DD/MM/YYYY" on the
membership page). On the reference account that is around the 7th. If the
user asks for the current month's invoice and the renewal date has not passed
yet, tell them it does not exist yet and offer the previous month's instead.
`peloton-invoice list` shows the real dates, so confirm there rather than
guessing.

An invoice's month is the month it was **paid** (the payment date on the
receipt).

Confirm parameters with the user before proceeding.

### 2. Download the invoice

Run one of these via Bash. Each opens a browser window briefly and closes it
again. Expect it to take 15 to 45 seconds. Pass the save location in
**single** quotes so spaces, `$`, backticks and parentheses stay literal. The
CLI expands a leading `~` itself, so `'~/Desktop'` works. If the path contains
a single quote, write it as `'\''` inside the quotes.

```bash
peloton-invoice download --latest --out '<SAVE_LOCATION>'
```

```bash
peloton-invoice download --month October --year 2026 --out '<SAVE_LOCATION>'
```

```bash
peloton-invoice download --invoice-id <INVOICE_ID> --out '<SAVE_LOCATION>'
```

On success it prints one JSON object on stdout:

```json
{
  "path": "/Users/me/Desktop/Peloton_Invoice_October_2026_GBP45.00.pdf",
  "bytes": 94288,
  "month": "October",
  "year": 2026,
  "displayDate": "07/10/2026",
  "amount": "45.00",
  "currency": "GBP",
  "tax": "7.50",
  "invoiceId": "0123456789abcdef0123456789abcdef",
  "subscriptionId": "11111111-1111-4111-8111-111111111111",
  "locale": "en-GB",
  "warnings": []
}
```

Keep `displayDate` and `amount` for step 5. Mention any `warnings` to the user
(an untested locale, or a missing amount or currency).

The CLI searches every Peloton-billed subscription, including cancelled ones,
so an old invoice on a previous membership is found without extra steps.

To see what exists without downloading, `peloton-invoice list` prints
`{"locale", "subscriptions": [{id, isActive, status, billingStrategy, plan,
hint?}], "invoices": [{subscriptionId, invoices: [...]}], "warnings"}`, newest
first. The same exit codes apply.

On failure it prints a JSON error on stderr and exits non-zero. Act on the exit
code.

### 3. Handle failures by exit code

- **3, not logged in.** The profile has no live Peloton session. Ask the user
  to sign in themselves, in their own terminal or with the `!` prefix in
  Claude Code:

  ```bash
  ! peloton-invoice login
  ```

  A browser window opens; they sign in to Peloton there and the command
  returns once the membership page loads signed in. Never type, ask for, or
  handle the user's credentials. Once they say it worked, re-run the same
  `download` command.
- **4, profile busy.** Another `peloton-invoice` run (or a leftover Chromium)
  holds the profile. Tell the user, wait for it to finish, and retry. Do not
  delete any lock file.
- **6, nothing to download.** Read `error`:
  - `bill_not_found`: `details.available` lists `{month, year, displayDate,
    amount, currency, invoiceId}` across all subscriptions. Show them and ask
    the user to pick one. Do not guess.
  - `ambiguous_month`: the month has more than one invoice (a plan change or a
    retried payment). Show `details.options` and ask which they want (or all
    of them), then re-run with `--invoice-id` for each.
  - `no_peloton_invoices`: no subscription is billed by Peloton. Each entry in
    `details.billers` has a `hint`: Apple, Google, Amazon and Roku receipts are
    in that store's purchase history; `Bango` charges are on the mobile
    carrier's or partner's bill; `NotBilled` was never charged. Tell the user
    which applies. Nothing was saved.
  - `no_invoices`: Peloton bills this account but has issued no invoice yet.
- **5, 7 or 9.** See step 4.
- **8, browser shutdown unconfirmed.** The invoice may well have been saved
  (stdout will say so), but a Chromium may still be running on the profile.
  Ask the user to check and quit it before the next run.
- **10, output exists.** A file of that name is already at the save location.
  Ask the user whether to overwrite it, save elsewhere, or skip. Re-run with
  `--overwrite` only if they say to overwrite. Never report the existing file
  as the new download.

### 4. Diagnostics on failure

For exit codes 5 (site or API changed), 7 (the rendered PDF was not plausible)
and 9 (unexpected status, network failure, or the receipt never rendered), the
CLI has already saved a redacted request log under
`~/.peloton-invoice/diagnostics/`. Its path is in `details.diagnostics`. The
log holds URL paths with ids replaced, status codes and redacted headers: no
token, cookies or bodies. No screenshot is saved, because the receipt shows the
user's name and billing address.

1. Report the error code (for example `history_shape_changed`,
   `receipt_mismatch` with `details.failed`, `receipt_not_rendered`,
   `pdf_too_small`) and the diagnostics path to the user.
2. For `network_error`, `receipt_not_rendered` or `navigation_*`, retry once
   before reporting.
3. Point the user at `references/peloton-api-endpoints.md`. The snapshot may be
   out of date and need regenerating against the live site, with matching
   changes in `peloton-invoice/peloton_invoice/contract.py` and `account.py`.

### 5. Verify the PDF

1. Run, substituting `displayDate` and `amount` from step 2 and the `path`. If
   `amount` was `null`, remove it from the list:

   ```bash
   txt=$(pdftotext -layout '<PATH>' - 2>/dev/null)
   ok=1
   for needle in '<DISPLAY_DATE>' '<AMOUNT>' 'VAT ID Number' 'Total amount paid'; do
     printf '%s' "$txt" | grep -qF -- "$needle" || { echo "MISSING: $needle"; ok=0; }
   done
   [ "$ok" = 1 ] && echo VERIFY_OK
   ```

2. Also view it with the Read tool (pages "1"), and confirm visually that it is
   the expected receipt: "Peloton Interactive UK Limited" (or the regional
   entity), the payment date, the subtotal / tax / total, and the amount paid.
3. Report:
   - File saved to: `<path>`
   - Payment date: `<dd/mm/yyyy>` (`<Month Year>`)
   - Amount: `<amount>` (VAT `<tax>`)
   - Verification: `VERIFY_OK`, or what was missing

If verification fails, warn the user with specifics and ask whether to keep the
file. The CLI already checked the live receipt against the API before printing,
so a failure here usually means a rendering problem.

## File naming

The CLI names the file; do not rename it.

- Amount and currency known: `Peloton_Invoice_October_2026_GBP45.00.pdf`
- Amount or currency unknown: `Peloton_Invoice_October_2026.pdf` (an unknown
  currency is never labelled GBP)
- More than one invoice in the month: the first 8 characters of the invoice id
  are appended, `Peloton_Invoice_October_2026_GBP45.00_a1b2c3d4.pdf`

## Error handling

| Exit | Error code(s) | Action |
| ---- | ------------- | ------ |
| n/a | `peloton-invoice: command not found` | Install it (Prerequisites), or use the `uv run --project` form |
| 3 | `no_profile` | First run. Ask the user to run `! peloton-invoice login` |
| 3 | `redirected_to_sign_in`, `not_signed_in` | Session expired. Ask the user to run `! peloton-invoice login`, then retry |
| 3 | `no_token_key`, `no_access_token`, `token_expired` | The page has no usable Auth0 token. Retry once (a reload often refreshes it); if it persists, ask the user to log in again |
| 3 | `subs_unauthorized`, `history_unauthorized` | Token rejected. Retry once, then ask the user to log in again |
| 3 | `login_timeout` | (From `login`.) The user did not finish signing in. They can re-run it, with `--timeout 0` for no limit |
| 4 | `profile_busy`, `profile_busy_stray_chromium` | Another run holds the profile. Wait and retry; never delete lock files |
| 5 | `subs_*`, `history_*` (`_shape_changed`, `_graphql_error`, `_unparseable`), `invoice_shape_changed` | The GraphQL schema moved. Report with diagnostics (step 4) |
| 5 | `membership_page_unrecognised`, `locale_not_found` | The account site's landing page changed. Report with diagnostics |
| 5 | `receipt_mismatch` | The receipt page did not show the API's date, amount, entity or VAT id (`details.failed`). Nothing was saved. Report |
| 5 | `wrong_page`, `body_missing`, `script_survived`, `capture_failed`, `invalid_identifier` | The receipt capture refused. Nothing was saved. Report with diagnostics |
| 6 | `bill_not_found` | Show `details.available` and ask the user to pick |
| 6 | `ambiguous_month` | Show `details.options`, ask which, re-run with `--invoice-id` |
| 6 | `no_peloton_invoices` | Explain the biller from `details.billers[].hint`. Nothing to download |
| 6 | `no_invoices` | Peloton has not issued an invoice yet |
| 7 | `pdf_not_pdf`, `pdf_too_small`, `pdf_too_large` | The print came out blank or broken (a blank render is under 1 KB). Nothing was saved. Report |
| 8 | `browser_shutdown_unconfirmed` | Chromium may still be running on `~/.peloton-invoice/profile`. Ask the user to quit it before the next run |
| 9 | `receipt_not_rendered` | The receipt never showed "Total amount paid" within 20 seconds. Retry once, then report |
| 9 | `network_error`, `subs_failed`, `history_failed`, `navigation_*` | Gateway or site unreachable, or an unexpected status. Retry once, then report |
| 9 | `browser_closed` | The browser window was closed mid-run. Retry and leave the window alone |
| 10 | `output_exists` | Ask: overwrite (re-run with `--overwrite`), save elsewhere, or skip |
| n/a | `MISSING:` lines in step 5 | Warn the user with specifics; ask whether to keep the file |
