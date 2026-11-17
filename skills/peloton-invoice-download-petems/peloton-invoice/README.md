# peloton-invoice

A small CLI that lists Peloton membership invoices through the account site's
GraphQL API and saves a receipt as a PDF. It drives its own
[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python)
Chromium on a dedicated profile (`~/.peloton-invoice/profile`), never your
everyday Chrome and never a `--remote-debugging-port` instance.

The browser plumbing (profile lease, human login, exit codes, redacted
diagnostics, atomic writes, HTML to PDF) comes from the shared
[`skill-browser`](../../../packages/skill-browser) package.

Peloton has no PDF download. The CLI opens the receipt page, cross-checks it
against the API, captures it with every script, handler, form and tracker
removed and a script-blocking Content-Security-Policy added, and prints that
copy in a throwaway, profile-less headless Chromium. Nothing is written to
disk except the final PDF.

## Install

```bash
uv tool install --editable /path/to/petems-skills/skills/peloton-invoice-download-petems/peloton-invoice
```

```bash
peloton-invoice install-browser
```

## Use

```bash
peloton-invoice login
```

```bash
peloton-invoice list
```

```bash
peloton-invoice download --latest --out ~/Desktop
```

```bash
peloton-invoice download --month October --year 2026 --out ~/Documents/receipts
```

```bash
peloton-invoice download --invoice-id 0123456789abcdef0123456789abcdef
```

`login` always opens a visible window and waits (15 minutes by default,
`--timeout 0` for no limit) while you sign in. It never sees or types your
password. `list` and `download` open a window too; pass `--headless` (or set
`PELOTON_INVOICE_HEADLESS=1`) to hide it. Headless has not been verified
against the live site.

`download` writes `Peloton_Invoice_<Month>_<Year>[_<CUR><amount>][_<id8>].pdf`
(mode 0600, atomically), refuses to replace an existing file unless given
`--overwrite`, and prints `{path, bytes, month, year, displayDate, amount,
currency, tax, invoiceId, subscriptionId, locale, warnings}`. The `_<id8>`
suffix appears only when a month has more than one invoice.

## Exit codes

| Code | Error | Meaning |
| ---- | ----- | ------- |
| 0 | | Success |
| 2 | | Bad arguments |
| 3 | `no_profile`, `redirected_to_sign_in`, `not_signed_in`, `no_token_key`, `no_access_token`, `token_expired`, `*_unauthorized` | No usable session. Run `peloton-invoice login` |
| 4 | `profile_busy`, `profile_busy_stray_chromium` | Another `peloton-invoice` (or a leftover Chromium) holds the profile |
| 5 | `*_shape_changed`, `*_graphql_error`, `*_unparseable`, `invoice_shape_changed`, `receipt_mismatch`, `membership_page_unrecognised`, `locale_not_found`, `body_missing`, `script_survived`, ... | The site or API changed. See `references/peloton-api-endpoints.md` |
| 6 | `bill_not_found`, `ambiguous_month`, `no_invoices`, `no_peloton_invoices` | Nothing (or more than one thing) matches; `details` says what exists |
| 7 | `pdf_not_pdf`, `pdf_too_small`, `pdf_too_large` | The rendered PDF was not plausible (a blank render is under 1 KB) |
| 8 | `browser_shutdown_unconfirmed` | Chromium may still be running on the profile |
| 9 | `network_error`, `*_failed`, `receipt_not_rendered`, `navigation_*` | Unexpected status, or the network failed |
| 10 | `output_exists` | The file exists; re-run with `--overwrite` to replace it |

Errors are JSON on stderr. For exit codes 5, 7 and 9 a redacted request log
(paths with ids replaced, status codes, redacted headers, no bodies) is written
under `~/.peloton-invoice/diagnostics/` and listed in `details.diagnostics`.
No screenshot is taken, because the receipt shows your name and address.

## Develop

From the repo root (a uv workspace, so `skill-browser` resolves locally):

```bash
uv run --package peloton-invoice --group dev pytest skills/peloton-invoice-download-petems/peloton-invoice
```

The `browser` tests run a real Chromium against a local fake of the account
site and GraphQL gateway. Point `PELOTON_INVOICE_TEST_CHROME` at a Chromium
binary if patchright's own is not installed.
