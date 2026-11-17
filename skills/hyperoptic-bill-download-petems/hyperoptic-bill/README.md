# hyperoptic-bill

A small CLI that lists and downloads Hyperoptic broadband bill PDFs from the
account site. It drives its own [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python)
Chromium on a dedicated profile (`~/.hyperoptic-bill/profile`), never your
everyday Chrome and never a `--remote-debugging-port` instance.

The browser plumbing (profile lease, human login, exit codes, diagnostics)
comes from the shared [`skill-browser`](../../../packages/skill-browser)
package. This directory holds only the Hyperoptic-specific parts:
`contract.py` (pure, unit-tested page parsing) and `site.py` (browser driving).

## Install

```bash
uv tool install --editable /path/to/petems-skills/skills/hyperoptic-bill-download-petems/hyperoptic-bill
```

```bash
hyperoptic-bill install-browser
```

## Use

```bash
hyperoptic-bill login
```

```bash
hyperoptic-bill download --latest --out ~/Desktop
```

```bash
hyperoptic-bill download --month March --year 2026 --out ~/Documents/bills
```

```bash
hyperoptic-bill list --year 2026
```

`login` always opens a visible window and waits (15 minutes by default,
`--timeout 0` for no limit) while you sign in. It never sees or types your
password. `list` and `download` open a window too; pass `--headless` (or set
`HYPEROPTIC_BILL_HEADLESS=1`) to hide it. Headless has not been verified
against the live site.

`download` writes `Hyperoptic_Bill_<Month>_<Year>[_GBP<amount>].pdf` (mode
0600, atomically, refusing to replace an existing file unless `--overwrite`)
and prints `{path, bytes, month, year, invoiceId, amount, billDate, via,
warnings}`. `via` is `download` (the browser download event) or `network`
(the captured `/billing/<invoiceId>` response, the fallback).

`list` clicks each month of the year in turn, so it takes a while.

## Exit codes

| Code | Error | Meaning |
| ---- | ----- | ------- |
| 0 | | Success |
| 2 | | Bad arguments |
| 3 | `no_profile`, `redirected_to_sign_in`, `login_timeout` | No usable session. Run `hyperoptic-bill login` |
| 4 | `profile_busy`, `profile_busy_stray_chromium` | Another `hyperoptic-bill` (or a leftover Chromium) holds the profile |
| 5 | `bills_page_shape_changed`, `view_bill_shape_changed`, `year_selector_missing`, `download_control_missing`, `wrong_page`, `invalid_identifier` | The site changed. See `references/hyperoptic-site.md` |
| 6 | `bill_not_found`, `year_not_available` | Nothing for that month or year |
| 7 | `no_download`, `download_failed`, `pdf_not_pdf`, `pdf_too_small`, `pdf_too_large`, `pdf_status:<n>`, `pdf_content_type:<type>` | The PDF was missing or not plausible |
| 8 | `browser_shutdown_unconfirmed` | Chromium may still be running on the profile |
| 9 | `navigation_failed`, `navigation_timeout` | Network problem reaching the site |
| 10 | `output_exists` | The file already exists; pass `--overwrite` to replace it |

Errors are JSON on stderr. For exit codes 5, 7 and 9 a screenshot and a
redacted request log (paths with ids replaced, status codes, redacted headers,
no bodies) are written under `~/.hyperoptic-bill/diagnostics/` and listed in
`details.diagnostics`.

## Develop

From the repo root (a uv workspace, so the local `skill-browser` is used):

```bash
uv run --package hyperoptic-bill --group dev pytest skills/hyperoptic-bill-download-petems/hyperoptic-bill
```

The `browser` tests run a real Chromium against a local fake of the account
site. Deselect them with `-m 'not browser'`. Point
`HYPEROPTIC_BILL_TEST_CHROME` at a Chromium binary if patchright's own is not
installed.
