# three-bill

A small CLI that lists and downloads Three UK bill PDFs through the My3 JSON
API. It drives its own [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python)
Chromium on a dedicated profile (`~/.three-bill/profile`), never your everyday
Chrome and never a `--remote-debugging-port` instance.

The browser layer follows `ramp-mcp-server`: one browser per profile, enforced
by an `flock` on `~/.three-bill/profile.lock`, and the lock is released only
once Chromium is confirmed to have exited.

## Install

```bash
uv tool install --editable /path/to/petems-skills/skills/three-phone-bill-download-petems/three-bill
```

```bash
three-bill install-browser
```

## Use

```bash
three-bill login
```

```bash
three-bill list
```

```bash
three-bill download --latest --out ~/Desktop
```

```bash
three-bill download --month March --year 2026 --out ~/Documents/bills
```

`login` always opens a visible window and waits (15 minutes by default,
`--timeout 0` for no limit) while you sign in. It never sees or types your
password. `list` and `download` open a window too; pass `--headless` (or set
`THREE_BILL_HEADLESS=1`) to hide it. Headless has not been verified against the
live site.

`download` writes `Three_UK_Bill_<Month>_<Year>[_GBP<amount>].pdf` (mode 0600,
atomically) and prints `{path, bytes, month, year, billNumber, billAmount,
billCloseDate, billEndDate, cuid, warnings}`.

## Exit codes

| Code | Error | Meaning |
| ---- | ----- | ------- |
| 0 | | Success |
| 2 | | Bad arguments |
| 3 | `not_logged_in`, `no_profile`, `session_not_authenticated`, `redirected_to_sign_in`, ... | No usable My3 session. Run `three-bill login` |
| 4 | `profile_busy`, `profile_busy_stray_chromium` | Another `three-bill` (or a leftover Chromium) holds the profile |
| 5 | `seed_shape_changed`, `list_shape_changed`, `bill_entry_shape_changed`, `persistor_*`, `no_auth_header`, `invalid_identifier`, ... | The My3 API contract changed. See `references/three-api-endpoints.md` |
| 6 | `bill_not_found` | No bill for that month; `details.available` lists what exists |
| 7 | `pdf_status:<n>`, `pdf_content_type:<type>`, `pdf_not_pdf`, `pdf_too_small`, `pdf_too_large` | The PDF response was not a plausible bill |
| 8 | `browser_shutdown_unconfirmed` | Chromium may still be running on the profile |
| 9 | `seed_failed`, `list_failed`, `navigation_failed`, `navigation_timeout`, ... | Three answered with an unexpected status, or the network failed |

Errors are JSON on stderr. For exit codes 5, 7 and 9 a screenshot and a
redacted request log (paths with ids replaced, status codes, redacted headers,
no bodies) are written under `~/.three-bill/diagnostics/` and listed in
`details.diagnostics`.

## Develop

```bash
uv sync --group dev
```

```bash
uv run pytest -m 'not browser'
```

The `browser` tests run a real Chromium against a local fake of the My3 API.
Point `THREE_BILL_TEST_CHROME` at a Chromium binary if patchright's own is not
installed.
