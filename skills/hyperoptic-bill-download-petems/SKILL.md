---
name: hyperoptic-bill-download-petems
description: >-
  Download and verify Hyperoptic broadband bill PDFs using the bundled
  hyperoptic-bill CLI, which drives a dedicated Patchright browser profile.
  Use this skill whenever the user mentions Hyperoptic bills, broadband
  invoices, internet bill downloads, or wants to grab/fetch/save a bill from
  their Hyperoptic account. Also trigger when the user asks to download bills
  for expense tracking, filing, or record-keeping from Hyperoptic.
license: MIT
allowed-tools:
  - Bash
  - Read
---

# Download a Hyperoptic bill PDF

When the user asks to download a bill from Hyperoptic, follow these steps.

The work is done by `hyperoptic-bill`, a small Python CLI in this skill's
`hyperoptic-bill/` directory. It drives its own Patchright Chromium on a
dedicated profile (`~/.hyperoptic-bill/profile`), opens
`/bills-and-payments`, clicks the month, reads the View Bill page (invoice ID,
heading, amount, bill date) and catches the "Download PDF bill" download. All
of the page parsing and validation (digit-only invoice ID, month and year from
the heading, the amount format) lives in
`hyperoptic-bill/hyperoptic_bill/contract.py`.

See `references/hyperoptic-site.md` for the URLs, page markers and selectors
the CLI depends on.

## Prerequisites

- **hyperoptic-bill on PATH.** Check with `command -v hyperoptic-bill`. If it
  is missing, ask the user to install it (it needs `uv`):

  ```bash
  uv tool install --editable "<this skill's base directory>/hyperoptic-bill"
  ```

  ```bash
  hyperoptic-bill install-browser
  ```

  If the user would rather not install it, run every command below as
  `uv run --project "<this skill's base directory>/hyperoptic-bill" hyperoptic-bill ...`
  instead.
- **A Hyperoptic session in the hyperoptic-bill profile.** Created once by the
  user with `hyperoptic-bill login` (see step 2). It persists between runs.
- **poppler** for PDF verification (`brew install poppler` on macOS,
  `apt-get install poppler-utils` on Linux).

## Steps

### 1. Parse user request

Determine:

- **Target month(s)**: Which bill(s) to download. Default to the latest if not
  specified. Multiple months are supported (one CLI run per month).
- **Save location**: Where to save the PDF(s). Default to `~/Desktop/` if not
  specified.

**Billing cycle note**: Hyperoptic generates bills around the 9th of each
month. If the user asks for the current month's bill and it is early in the
month (before the 10th), warn them it may not be available yet and offer to
download the previous month's bill instead.

Confirm parameters with the user before proceeding.

### 2. Download the bill

Run one of these via Bash. Each opens a browser window, loads the account
site and closes it again. Expect 10 to 30 seconds, longer for `--latest` if
the current month has no bill yet (each empty month costs a few seconds). Pass the save location in
**single** quotes so spaces, `$`, backticks and parentheses stay literal. The
CLI expands a leading `~` itself, so `'~/Desktop'` works. If the path contains
a single quote, write it as `'\''` inside the quotes.

```bash
hyperoptic-bill download --latest --out '<SAVE_LOCATION>'
```

```bash
hyperoptic-bill download --month March --year 2026 --out '<SAVE_LOCATION>'
```

For several months, run one `download` per month, one after another. Never run
them in parallel: the second run would get exit code 4.

On success it prints one JSON object on stdout:

```json
{
  "path": "/Users/me/Desktop/Hyperoptic_Bill_October_2026_GBP53.00.pdf",
  "bytes": 84213,
  "month": "October",
  "year": 2026,
  "invoiceId": "84623147",
  "amount": "53.00",
  "billDate": "9 October, 2026",
  "via": "download",
  "warnings": []
}
```

Keep `month`, `year`, `amount` and `billDate` for step 4. Mention any
`warnings` to the user (for example `amount_unreadable`, which means the
amount was not read and the filename omits it).

On failure it prints a JSON error on stderr and exits non-zero. Act on the
exit code:

- **3, not logged in.** The profile has no live Hyperoptic session. Ask the
  user to sign in themselves, in their own terminal or with the `!` prefix in
  Claude Code:

  ```bash
  ! hyperoptic-bill login
  ```

  A browser window opens; they sign in there and the command returns once the
  session is confirmed. Never type, ask for, or handle the user's
  credentials. Once they say it worked, re-run the same `download` command.
- **4, profile busy.** Another `hyperoptic-bill` run (or a leftover Chromium)
  holds the profile. Tell the user, wait for it to finish, and retry. Do not
  delete any lock file.
- **6, not found.** `bill_not_found`: no bill for that month (or, for
  `--latest`, in the 13 months tried, listed in `details.tried`).
  `year_not_available`: `details.available` lists the years the selector
  offers. Show what exists and ask the user to pick. Do not guess.
  `hyperoptic-bill list --year <YEAR>` shows every bill in a year, slowly.
- **5, 7 or 9.** See step 3.
- **8, browser shutdown unconfirmed.** The bill may well have been saved
  (stdout will say so), but a Chromium may still be running on the profile.
  Ask the user to check and quit it before the next run.
- **10, output exists.** `details.path` already exists. Ask the user whether
  to overwrite it or keep the existing file. Re-run with `--overwrite` only if
  they say so. Never report the existing file as the new download.

### 3. Diagnostics on failure

For exit codes 5 (site changed), 7 (no PDF, or not a plausible one) and 9
(network failure), the CLI has already saved a redacted request log
under `~/.hyperoptic-bill/diagnostics/`. Its path is in the
error's `details.diagnostics`. The log holds URL paths with ids replaced,
status codes and redacted headers: no cookies, query strings or bodies.

1. Report the error code (for example `view_bill_shape_changed`,
   `no_download`) and the diagnostics path to the user.
   If the log is not enough to see what changed, offer to re-run with
   `--diagnostic-screenshot` (a global flag, before the command) to also
   save a screenshot. Ask first: it can show the user's name, account
   number and address.
2. Point the user at `references/hyperoptic-site.md`. The snapshot may be out
   of date and need regenerating against the live site, with matching changes
   in `hyperoptic-bill/hyperoptic_bill/contract.py` and `site.py`.

### 4. Verify the PDF

1. Use the Read tool to view the downloaded PDF (pages "1-2"). If the Read
   tool cannot render the PDF, fall back to `pdftotext <file> -` via Bash.
2. Check:
   - **Month match**: The bill date on the PDF matches `month` / `year` (and
     `billDate`) from step 2.
   - **Amount visible**: The total matches `amount` from step 2. If `amount`
     was `null`, read the total off the PDF and report it.
   - **Valid bill**: Hyperoptic branding, an account number, and a VAT/charge
     breakdown are present.
3. Report a summary:
   - File saved to: `<full path>`
   - Billing period: `<month/year>`
   - Amount: `<amount>`
   - Verification: passed or failed (with details)

If verification fails, warn the user with specifics but keep the file.

## File naming

The CLI names the file; do not rename it.

- With an amount: `Hyperoptic_Bill_March_2026_GBP53.00.pdf`
- If the amount was not readable: `Hyperoptic_Bill_March_2026.pdf`

## Error handling

| Exit | Error code(s) | Action |
| ---- | ------------- | ------ |
| n/a | `hyperoptic-bill: command not found` | Install it (Prerequisites), or use the `uv run --project` form |
| 3 | `no_profile` | First run. Ask the user to run `! hyperoptic-bill login` |
| 3 | `redirected_to_sign_in` | Session expired (redirected to Keycloak). Ask the user to run `! hyperoptic-bill login`, then retry once |
| 3 | `login_timeout` | (From `login`.) The user did not finish signing in. They can re-run it, with `--timeout 0` for no limit |
| 4 | `profile_busy`, `profile_busy_stray_chromium` | Another run holds the profile. Wait and retry; never delete lock files |
| 5 | `bills_page_shape_changed` | The bills page no longer lists month names. Report with diagnostics |
| 5 | `view_bill_shape_changed` | `details.field` names what is missing (`heading`, `invoiceId`, `Amount due`). Report with diagnostics |
| 5 | `year_selector_missing` | The year selector moved or changed. Report with diagnostics |
| 5 | `download_control_missing`, `wrong_page` | The "Download PDF bill" control is gone, or the page moved off this bill. Retry once, then report with diagnostics |
| 5 | `invalid_identifier` | The invoice ID was not digit-only. Report with diagnostics |
| 6 | `bill_not_found`, `year_not_available` | Show what exists (`details.tried` / `details.available`) and ask the user to pick |
| 7 | `no_download`, `download_failed` | Clicking the control produced no PDF. Retry once; otherwise report with diagnostics |
| 7 | `pdf_not_pdf`, `pdf_too_small`, `pdf_too_large`, `pdf_status:<n>`, `pdf_content_type:<type>` | Not a plausible bill. Nothing was saved. Report with diagnostics |
| 8 | `browser_shutdown_unconfirmed` | Chromium may still be running on `~/.hyperoptic-bill/profile`. Ask the user to quit it before the next run |
| 9 | `navigation_failed`, `navigation_timeout` | Network problem reaching `account.hyperoptic.com`. Retry once, then report |
| 9 | `browser_closed` | The browser window was closed mid-run. Retry and leave the window alone |
| 10 | `output_exists` | Ask: overwrite (re-run with `--overwrite`) or keep the existing file |
| n/a | PDF verification mismatch (month/amount) | Warn user with specifics, keep the file |
