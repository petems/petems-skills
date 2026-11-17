---
name: three-phone-bill-download-petems
description: >-
  Download and verify a Three UK mobile bill PDF using the bundled three-bill
  CLI, which calls the My3 JSON API from a dedicated Patchright browser profile
  (resilient to SPA UI changes). Use when the user wants to download, grab,
  fetch or save a Three / Three UK phone bill or invoice as a PDF.
license: MIT
allowed-tools:
  - Bash
  - Read
---

# Download a Three UK bill PDF

When the user asks to download a bill from Three.co.uk, follow these steps.

The work is done by `three-bill`, a small Python CLI in this skill's
`three-bill/` directory. It drives its own Patchright Chromium on a dedicated
profile (`~/.three-bill/profile`), loads My3's `/account` page, and calls the
`/rp-server-b2c/` JSON API directly: seed, list bills, then the PDF. All of the
API shape checks (the `customer.financialAccount[0].id` billing arrangement,
deriving the month from `billCloseDate`, the fail-closed `isAnonymous === false`
check, the redux-persist double encoding, digit-only identifiers) live in
`three-bill/three_bill/contract.py`.

See `references/three-api-endpoints.md` for the endpoints, headers and response
shapes the CLI depends on.

## Prerequisites

- **three-bill on PATH.** Check with `command -v three-bill`. If it is
  missing, ask the user to install it (it needs `uv`):

  ```bash
  uv tool install --editable "<this skill's base directory>/three-bill"
  ```

  ```bash
  three-bill install-browser
  ```

  If the user would rather not install it, run every command below as
  `uv run --project "<this skill's base directory>/three-bill" three-bill ...`
  instead.
- **A My3 session in the three-bill profile.** Created once by the user with
  `three-bill login` (see step 2). It persists between runs.
- **poppler** for PDF verification (`brew install poppler` on macOS,
  `apt-get install poppler-utils` on Linux).

## Steps

### 1. Parse user request

Determine:

- **Target month(s)**: Which bill to download. Default to the latest (most recent) bill if not specified.
- **Save location**: Where to save the PDF. Default to `~/Desktop/` if not specified.

**Billing cycle note**: Three UK bills are generated on the 23rd/24th of
each month. The billing period runs from the 24th of one month to the
23rd of the next. Check today's date before proceeding. If today is
before the 24th and the user asks for the current month's bill, alert
them: "The current month's bill is not available yet. Three generates
new bills after the 23rd. I will look for last month's bill instead."
Then default to the previous month.

A bill's month is the month it was **issued** (its `billCloseDate`, the 24th).
"My July bill" is the one closing 24 July and covering up to 23 July.

Confirm parameters with the user before proceeding.

### 2. Download the bill

Run one of these via Bash. Each opens a browser window briefly, loads My3 and
closes it again. Expect it to take 10 to 30 seconds.

```bash
three-bill download --latest --out "<SAVE_LOCATION>"
```

```bash
three-bill download --month March --year 2026 --out "<SAVE_LOCATION>"
```

On success it prints one JSON object on stdout:

```json
{
  "path": "/Users/me/Desktop/Three_UK_Bill_July_2026_GBP33.08.pdf",
  "bytes": 1196342,
  "month": "July",
  "year": 2026,
  "billNumber": "116",
  "billAmount": 33.08,
  "billCloseDate": "2026-07-24T00:00:00Z",
  "billEndDate": "2026-07-23T00:00:00Z",
  "cuid": "949613941",
  "warnings": []
}
```

Keep `billAmount`, `billCloseDate`, `billEndDate` and `cuid` for step 4.
Mention any `warnings` to the user (for example a `null` `billAmount`, which
means step 4 has no amount to cross-check).

On failure it prints a JSON error on stderr and exits non-zero. Act on the exit
code:

- **3, not logged in.** The three-bill profile has no live My3 session. Ask the
  user to sign in themselves, in their own terminal or with the `!` prefix in
  Claude Code:

  ```bash
  ! three-bill login
  ```

  A browser window opens; they sign in to My3 there and the command returns
  once the session is confirmed. Never type, ask for, or handle the user's
  credentials. Once they say it worked, re-run the same `download` command.
- **4, profile busy.** Another `three-bill` run (or a leftover Chromium) holds
  the profile. Tell the user, wait for it to finish, and retry. Do not delete
  any lock file.
- **6, bill not found.** `details.available` lists the `{month, year}` pairs
  Three returned. Show them and ask the user to pick one. Do not guess.
- **5, 7 or 9.** See step 3.
- **8, browser shutdown unconfirmed.** The bill may well have been saved (stdout
  will say so), but a Chromium may still be running on the profile. Ask the user
  to check and quit it before the next run.

To see what bills exist without downloading, `three-bill list` prints
`{"bills": [{month, year, billNumber, billAmount, billCloseDate, billStartDate,
billEndDate, billPeriod}, ...]}`, newest first. The same exit codes apply.

### 3. Diagnostics on failure

For exit codes 5 (API contract changed), 7 (the PDF response was not a bill)
and 9 (unexpected status or network failure), the CLI has already saved a
screenshot and a redacted request log under `~/.three-bill/diagnostics/`. Their
paths are in the error's `details.diagnostics`. The log holds URL paths with
the customer and billing ids replaced, status codes and redacted headers: no
tokens, cookies or bodies.

1. Report the error code (for example `seed_shape_changed`,
   `pdf_content_type:text/html`) and both diagnostic paths to the user.
2. Point the user at `references/three-api-endpoints.md`. The snapshot may be
   out of date and need regenerating against the live SPA, with matching
   changes in `three-bill/three_bill/contract.py`.

### 4. Verify the PDF

1. Use the Read tool to view the downloaded PDF (pages "1-3"). If the Read tool cannot render the PDF, fall back to `pdftotext <file> -` via Bash.
2. Check:
   - **Month match**: The PDF shows `Bill date 24 <Mon> <YY>` and
     `Your bill period Up to 23 <Mon> <YY>` for the requested month. This is
     the authoritative check that the month was mapped correctly. Confirm it
     rather than trusting the API.
   - **Amount visible**: `Total charges after VAT` matches `billAmount` from
     step 2. If `billAmount` was `null`, there is nothing to compare against:
     read the total off the PDF, report it, and flag that the API did not
     supply a usable amount.
   - **Account match**: `Your account number` equals `cuid` from step 2.
   - **Valid bill indicators**: Hutchison 3G UK Ltd, a VAT reg. no., a due date.
3. Report a summary:
   - File saved to: `<full path>`
   - Billing period: `<month/year>`
   - Amount: `<amount>`
   - Verification: passed or failed (with details)

If verification fails, warn the user with specifics but keep the file.

## File naming

The CLI names the file; do not rename it.

- With an amount: `Three_UK_Bill_March_2026_GBP45.99.pdf`
- If `billAmount` was not a usable number: `Three_UK_Bill_March_2026.pdf`

## Error handling

| Exit | Error code(s) | Action |
| ---- | ------------- | ------ |
| n/a | `three-bill: command not found` | Install it (Prerequisites), or use the `uv run --project` form |
| 3 | `no_profile` | First run. Ask the user to run `! three-bill login` |
| 3 | `session_not_authenticated`, `auth_check_failed`, `auth_check_unparseable` | Auth0 may have logged in while My3 stayed anonymous, or the session expired. Only `isAnonymous === false` counts. Ask the user to run `! three-bill login` |
| 3 | `redirected_to_sign_in`, `not_on_account_page`, `seed_unauthorized`, `list_unauthorized` | Session expired. Ask the user to run `! three-bill login`, then retry once |
| 3 | `login_timeout` | (From `login`.) The user did not finish signing in. They can re-run it, with `--timeout 0` for no limit |
| 4 | `profile_busy`, `profile_busy_stray_chromium` | Another run holds the profile. Wait and retry; never delete lock files |
| 5 | `seed_shape_changed`, `no_auth_header` | Three changed the seed response. Report with diagnostics (step 3) |
| 5 | `list_shape_changed`, `bill_entry_shape_changed` | Three changed the list response. `details` names the field. Report with diagnostics |
| 5 | `persistor_missing`, `persistor_parse_failed`, `no_cuid_in_store` | The SPA's seed request was not seen and the redux-persist fallback failed. Retry once; if it persists, report with diagnostics |
| 5 | `multiple_accounts` | The My3 login covers more than one account, which three-bill does not support yet. Tell the user; do not guess |
| 5 | `invalid_identifier` | An id from Three was not digit-only, so no URL was built from it. Report with diagnostics |
| 6 | `bill_not_found` | Show `details.available` and ask the user to pick a month |
| 7 | `pdf_content_type:text/html`, `pdf_status:<n>` | Usually an auth redirect. Ask the user to re-login and retry once; otherwise report with diagnostics |
| 7 | `pdf_not_pdf`, `pdf_too_small`, `pdf_too_large` | Not a plausible bill (expected 0.5 to 2 MB). Nothing was saved. Report with diagnostics |
| 8 | `browser_shutdown_unconfirmed` | Chromium may still be running on `~/.three-bill/profile`. Ask the user to quit it before the next run |
| 9 | `seed_failed`, `list_failed` | Three returned 404 or 5xx. The API may have moved. Report with diagnostics |
| 9 | `navigation_failed`, `navigation_timeout`, `fetch_*` | Network problem reaching `www.three.co.uk`. Retry once, then report |
| 9 | `browser_closed` | The browser window was closed mid-run. Retry and leave the window alone |
| n/a | PDF verification mismatch (month/amount/account) | Warn user with specifics, keep the file |
