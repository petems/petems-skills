---
name: peloton-invoice-download-petems
description: >-
  Download and verify Peloton membership invoices (All-Access / App
  subscription receipts) as PDFs via Chrome DevTools, using the Peloton
  account GraphQL API to find invoices and headless Chrome to print them.
  Use this skill whenever the user wants to download, grab, fetch, or save a
  Peloton invoice, receipt, or membership bill, including for expense or
  fitness reimbursement claims.
license: MIT
allowed-tools:
  - mcp__chrome-devtools__navigate_page
  - mcp__chrome-devtools__take_snapshot
  - mcp__chrome-devtools__take_screenshot
  - mcp__chrome-devtools__click
  - mcp__chrome-devtools__press_key
  - mcp__chrome-devtools__wait_for
  - mcp__chrome-devtools__list_network_requests
  - mcp__chrome-devtools__evaluate_script
  - mcp__chrome-devtools__new_page
  - mcp__chrome-devtools__list_pages
  - mcp__chrome-devtools__select_page
  - Bash
  - Read
---

# Download a Peloton membership invoice PDF

When the user asks for a Peloton invoice or receipt, follow these steps.

Peloton does not offer a PDF download. Each payment in the membership
"Payment history" table links to an HTML receipt page. This skill:

1. uses Chrome DevTools MCP to reach the logged-in account site,
2. calls the same GraphQL API the site uses to list invoices (no table
   scraping, so month matching is exact),
3. opens the receipt page, captures its rendered HTML with the scripts
   removed, and
4. prints that HTML to PDF with a separate headless Chrome.

See `references/peloton-api-endpoints.md` for a frozen snapshot of the URLs,
GraphQL operations, and response shapes this skill depends on.

## Prerequisites

- **Chrome DevTools MCP server** configured and running (`npx @anthropic-ai/chrome-devtools-mcp@latest`)
- The MCP server registered in Claude Code settings under `mcpServers`
- **Google Chrome** (or Chromium) installed locally, for the headless print step
- **poppler** installed for PDF verification (`brew install poppler` on macOS, `apt-get install poppler-utils` on Linux)
- If MCP tools are unavailable, stop and ask the user to set up Chrome DevTools MCP first
- **Stale browser lock**: If a tool call fails with "The browser is already running",
  check for a stale lock file and orphaned Chrome process:

  ```bash
  ls -la ~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock
  readlink ~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock
  # If the PID is an old MCP Chrome (not regular Chrome), kill it
  kill <PID>
  ```

## Token hygiene

The GraphQL API is authorised with an Auth0 bearer token that lives in the
page's `localStorage`. Treat it as a secret:

- The snippets below read it inside the page and **never return it**. Keep it that way.
- Do **not** call `get_network_request` on `graph.prod.k8s.onepeloton.com` or
  `api.onepeloton.com` requests. Its output prints the `authorization` header
  and every cookie in full.

## Temporary files and cleanup

The captured receipt holds the user's name and billing address. Every
temporary file the skill creates lives in one of two places:

| Placeholder | What | Where |
| --- | --- | --- |
| `<WORK>` | Decoded HTML and the unrenamed PDF | `mktemp -d /tmp/peloton_invoice.XXXXXX` (created in step 6) |
| `<CAPTURE>` | Raw `evaluate_script` output, only if `<WORK>` is rejected | `<PROJECT_DIR>/.peloton_receipt_<RAND>.json`, moved into `<WORK>` immediately |

`<PROJECT_DIR>` is the current working directory (`pwd`), and `<RAND>` is the
random suffix of `<WORK>` (the part after `peloton_invoice.`).

**Run the cleanup command on every exit path**: after a successful save, after
a verification failure, after any `error` result or diagnostic capture, when
the user aborts, and before ending your turn for any other reason. Do not leave
a receipt behind because a later step failed.

```bash
rm -rf "<WORK>"
find "<PROJECT_DIR>" -maxdepth 1 -name '.peloton_receipt_*' -exec rm -f {} +
if find "<PROJECT_DIR>" -maxdepth 1 -name '.peloton_receipt_*' | grep -q . || [ -e "<WORK>" ]; then
  echo CLEANUP_INCOMPLETE
else
  echo CLEANUP_OK
fi
```

Use `find`, not a glob such as `rm -f .peloton_receipt_*`: in zsh an unmatched
glob is an error, so the `rm` never runs. If `<WORK>` was never created, skip
the `rm -rf` line but still run the `find` lines. If the output is
`CLEANUP_INCOMPLETE`, tell the user which file is left over.

## Steps

### 1. Parse user request

Determine:

- **Target month(s)**: Which invoice(s) to download. Default to the latest if not specified. Multiple months are supported (process them one at a time).
- **Save location**: Where to save the PDF(s). Default to `~/Desktop/` if not specified.

Resolve the save location to an absolute path now, and record the result as
`<SAVE_DIR>`. Never put `~` inside quotes in a later command: the shell does
not expand a quoted tilde, so `mkdir -p "~/Desktop"` creates a literal `~`
directory under the current directory.

```bash
python3 -I -c 'import os,sys; print(os.path.realpath(os.path.expanduser(sys.argv[1])))' '<RAW_SAVE_LOCATION>'
```

- Put the user's text inside the single quotes as-is. If it contains a single
  quote or a newline, do not run the command: ask the user for a different path.
- The printed path is `<SAVE_DIR>` (for the default, e.g. `/Users/<name>/Desktop`).
  Spaces and other characters are fine, because every later command passes it in single quotes.

**Billing cycle note**: Peloton charges monthly on the membership renewal
date, which is fixed per account (shown as "Renews DD/MM/YYYY" on the
membership page). On the reference account that is around the 7th. If the
user asks for the current month's invoice and the renewal date has not passed
yet, tell them it does not exist yet and offer the previous month's instead.
Step 4 lists the real dates, so confirm there rather than guessing.

Confirm parameters with the user before proceeding.

### 2. Navigate to the membership page and handle login

1. Navigate to `https://account.onepeloton.co.uk/mymembership`. It redirects to
   `https://account.onepeloton.com/en-GB/mymembership` when logged in, or to
   the Auth0 login form on `auth.onepeloton.com` when not.
2. Take a snapshot. If the snapshot is too large, use `evaluate_script` to
   return `location.href` and `document.body.innerText.slice(0, 2000)` instead.
3. **Cookie consent**: If "Accept All Cookies" is visible, click it. For other overlays, press Escape.
4. **Check login state**: Logged in if the URL is on `account.onepeloton.com` and
   the page shows "Memberships on file" or "Membership details".
5. **If not logged in**:
   - Tell the user: "Please log in to your Peloton account in the Chrome browser window. I will wait for you to complete login."
   - Use `wait_for` with timeout 120000ms and text `["Memberships on file", "Membership details"]`.
     Do **not** wait for generic words such as "Membership" or "Subscriptions":
     the login page footer contains "Membership Terms", which matches instantly.
   - If `wait_for` times out, check `location.href` anyway before giving up.
     Login can redirect to `members.onepeloton.com/en-GB/home` instead of back
     to the account site. If so, navigate to the URL in item 1 again.
6. Never enter credentials on behalf of the user.

### 3. Resolve the subscription ID

Run via `evaluate_script` on the `account.onepeloton.com` page. It reads the
token, lists subscriptions, and stores the token on `window` for step 4.

```javascript
async () => {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('@@auth0spajs@@') && k.includes('::https://api.onepeloton.com/::'));
  if (keys.length === 0) return { error: 'no_token_key' };
  let entry;
  try { entry = JSON.parse(localStorage.getItem(keys[0])); } catch (e) { return { error: 'token_parse_failed' }; }
  const token = entry?.body?.access_token;
  if (typeof token !== 'string' || token.length < 20) return { error: 'no_access_token' };
  if (Number.isFinite(entry?.expiresAt) && entry.expiresAt * 1000 < Date.now()) return { error: 'token_expired' };
  window.__pelotonToken = token;
  const r = await fetch('https://graph.prod.k8s.onepeloton.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'apollographql-client-name': 'account' },
    body: JSON.stringify({
      operationName: 'Subs',
      query: 'query Subs($input: SubPelotonMemberInput!) { subPelotonMember(input: $input) { subscriptions { id isActive status billingStrategy billingPlan { id subscriptionType } } } }',
      variables: { input: { billingStrategyFilters: [], subscriptionTypeFilters: [], country: 'GB' } },
    }),
  });
  if (r.status !== 200) return { error: 'subs_failed', status: r.status, snippet: (await r.text()).slice(0, 200) };
  const body = await r.json();
  if (body?.errors?.length) return { error: 'subs_graphql_error', messages: body.errors.map(e => e.message).slice(0, 3) };
  const subs = body?.data?.subPelotonMember?.subscriptions;
  if (!Array.isArray(subs)) return { error: 'subs_shape_changed', dataKeys: Object.keys(body?.data || {}) };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return {
    subscriptions: subs.filter(s => typeof s?.id === 'string' && uuid.test(s.id)).map(s => ({
      id: s.id, isActive: s.isActive, status: s.status, billingStrategy: s.billingStrategy, plan: s.billingPlan?.id,
    })),
  };
}
```

Pick the subscription to use:

- Normally exactly one has `isActive: true` and `billingStrategy: "AutoDebit"`. Use it.
- Old discontinued entries (for example `PRE_DELIVERY`, `NotBilled`) have no invoices. Ignore them.
- A **cancelled** membership still has past invoices. If the user wants an old
  invoice and there is no active subscription, ask which subscription to use.
- If more than one candidate remains, list them and ask the user.
- `billingStrategy` of `Apple`, `Google`, `Amazon`, or `Roku` means the
  membership is billed through an app store. Peloton has no invoices for it.
  Tell the user to get the receipt from that store instead, and stop.

`country: 'GB'` matches the UK account the skill was built against. For other
regions, change it to the account's country code.

### 4. List invoices

**`evaluate_script` cannot take arbitrary arguments.** Its `args` parameter
accepts element uids from a snapshot only, and `sourcePath` is sandboxed to the
workspace roots (`/tmp` is rejected), so pass the snippet inline via
`function`. Inline values as literals too:
replace the whole quoted placeholder, quotes included, with the output of
`JSON.stringify(value)`. The guards below reject a missed or malformed
substitution before any request is made.

```javascript
async () => {
  const subscriptionId = "REPLACE_WITH_SUBSCRIPTION_ID";
  if (/REPLACE_WITH_/.test(subscriptionId)) return { error: 'placeholder_not_replaced', field: 'subscriptionId' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(subscriptionId)) return { error: 'invalid_identifier', field: 'subscriptionId' };
  const token = window.__pelotonToken;
  if (!token) return { error: 'no_token_rerun_step_3' };
  const r = await fetch('https://graph.prod.k8s.onepeloton.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'apollographql-client-name': 'account' },
    body: JSON.stringify({
      operationName: 'PaymentHistory',
      query: 'query PaymentHistory($input: SubPelotonSubscriptionInput!) { subPelotonSubscription(input: $input) { id pastInvoices { id createdAt '
        + 'invoicePayments { paymentDate totalAmount { currencyCode centAmount } } '
        + 'billingSummary { totalAmount { currencyCode centAmount } tax { centAmount } } } } }',
      variables: { input: { subscriptionId } },
    }),
  });
  if (r.status !== 200) return { error: 'history_failed', status: r.status, snippet: (await r.text()).slice(0, 200) };
  const body = await r.json();
  if (body?.errors?.length) return { error: 'history_graphql_error', messages: body.errors.map(e => e.message).slice(0, 3) };
  const raw = body?.data?.subPelotonSubscription?.pastInvoices;
  if (!Array.isArray(raw)) return { error: 'history_shape_changed', dataKeys: Object.keys(body?.data?.subPelotonSubscription || {}) };
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const invoices = [];
  for (let i = 0; i < raw.length; i++) {
    const inv = raw[i];
    // The id goes into a URL path in step 5, so it must be exactly 32 hex chars.
    if (typeof inv?.id !== 'string' || !/^[0-9a-f]{32}$/.test(inv.id)) {
      return { error: 'invoice_shape_changed', index: i, field: 'id', value: String(inv?.id).slice(0, 40) };
    }
    const dateStr = inv?.invoicePayments?.[0]?.paymentDate ?? inv?.createdAt;
    const ms = Date.parse(dateStr);
    if (!Number.isFinite(ms)) return { error: 'invoice_shape_changed', index: i, field: 'paymentDate', value: String(dateStr).slice(0, 40) };
    // Payments land in the evening UTC, so the UTC date is the UK date.
    const d = new Date(ms);
    const cents = inv?.billingSummary?.totalAmount?.centAmount ?? inv?.invoicePayments?.[0]?.totalAmount?.centAmount;
    const currency = inv?.billingSummary?.totalAmount?.currencyCode ?? inv?.invoicePayments?.[0]?.totalAmount?.currencyCode ?? null;
    const amount = Number.isInteger(cents) && cents >= 0 ? (cents / 100).toFixed(2) : null;
    const taxCents = inv?.billingSummary?.tax?.centAmount;
    invoices.push({
      id: inv.id,
      month: months[d.getUTCMonth()],
      year: d.getUTCFullYear(),
      // dd/mm/yyyy, as printed on the receipt page and PDF.
      displayDate: `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`,
      paymentDate: dateStr,
      amount,
      currency,
      tax: Number.isInteger(taxCents) ? (taxCents / 100).toFixed(2) : null,
    });
  }
  invoices.sort((a, b) => Date.parse(b.paymentDate) - Date.parse(a.paymentDate));
  return { count: invoices.length, invoices };
}
```

Map the request to invoice(s):

- "Latest": take `invoices[0]`.
- A named month/year: find the entry with matching `month` and `year`. If a
  month has more than one invoice (a plan change or a retried payment), list
  them and ask the user which they want, or offer all of them.
- No match: list the available `{month, year, amount}` entries and ask the user to pick. Do not proceed.

`amount` is a 2-decimal string or `null`. If `currency` is not `GBP`, use that
code in place of `GBP` in the filename in step 7.

### 5. Open the receipt page

For each invoice, one at a time, in the same browser page:

1. Navigate to:

   ```text
   https://account.onepeloton.com/en-GB/mymembership/v2/subscriptions/<SUBSCRIPTION_ID>/invoices/<INVOICE_ID>
   ```

   Build it from values that passed the step 3 and step 4 guards (UUID with
   dashes, and 32 hex characters, respectively). The "View" link on the
   membership page opens the same URL in a new tab. Navigating directly avoids
   the extra tab.

2. The receipt renders client-side. `wait_for` text `["Total amount paid"]` with a 20000ms timeout.
3. Cross-check the page against step 4 before capturing:

   ```javascript
   () => {
     const t = document.body.innerText;
     return {
       hasEntity: /Peloton Interactive/.test(t),
       hasVat: /VAT ID Number/.test(t),
       hasDate: t.includes("REPLACE_WITH_DISPLAY_DATE"),
       hasAmount: t.includes("REPLACE_WITH_AMOUNT"),
     };
   }
   ```

   Substitute `displayDate` and `amount` (e.g. `"07/10/2026"`, `"45.00"`) with
   `JSON.stringify`, as in step 4. If `amount` is `null`, drop that check. If
   any check is `false`, take a screenshot, show the user what the page says,
   and ask before continuing.

### 6. Capture the receipt and print it to PDF

The DevTools MCP has no print-to-PDF tool, and its Chrome only exposes a
debugging pipe, not a port. So capture the rendered HTML from the page and
print it with a separate headless Chrome.

1. Create a private working directory. Record the first line as `<WORK>` and
   the second as `<PROJECT_DIR>` (see "Temporary files and cleanup"):

   ```bash
   mktemp -d /tmp/peloton_invoice.XXXXXX && pwd
   ```

2. Call `evaluate_script` with `filePath: "<WORK>/receipt.json"` and this function.
   The MCP usually rejects paths outside the workspace roots (as it does for
   `/tmp`). If it does, call it again with
   `filePath: "<PROJECT_DIR>/.peloton_receipt_<RAND>.json"`. That is `<CAPTURE>`,
   and step 3 moves it out of the project straight away.
   It copies all CSS inline and strips scripts, iframes, trackers, and the
   cookie banner, so the offline copy renders without any JavaScript.

   ```javascript
   () => {
     const css = [];
     for (const s of document.styleSheets) {
       try { css.push([...s.cssRules].map(r => r.cssText).join('\n')); }
       catch (e) { if (s.href) css.push(`@import url("${s.href}");`); }
     }
     const doc = document.documentElement.cloneNode(true);
     // Remove by tag or id only. NEVER select on class substrings like
     // [class*="fides"]: the consent tool adds a fides-* class to <body>,
     // which deletes the whole receipt and prints a blank page.
     doc.querySelectorAll('script, noscript, iframe, link, style, #fides-overlay, #ada-entry, #fb-root, #post-order-banner, .Toastify, next-route-announcer, #podscribe-request, [id^="batBeacon"]').forEach(n => n.remove());
     const style = document.createElement('style');
     style.textContent = css.join('\n') + '\n@page { size: A4; margin: 12mm; }';
     doc.querySelector('head').append(style);
     return '<!DOCTYPE html>\n' + doc.outerHTML;
   }
   ```

   `filePath` output is a **JSON-encoded string**, and the tool may normalise
   the extension to `.json`. Use the path the tool reports as `<SAVED_PATH>`.

3. In **one** Bash call, move the capture into `<WORK>` (a no-op if it is
   already there), decode it to HTML, and print. Keeping the `mv` in the same
   call means a receipt written into the project is gone before anything else
   can fail:

   ```bash
   [ "<SAVED_PATH>" = "<WORK>/receipt.json" ] || mv -f "<SAVED_PATH>" "<WORK>/receipt.json" || echo "CAPTURE_MOVE_FAILED"
   python3 -I -c 'import json,sys; open(sys.argv[2],"w").write(json.load(open(sys.argv[1])))' "<WORK>/receipt.json" "<WORK>/receipt.html"
   grep -q '<body' "<WORK>/receipt.html" || echo "BODY_MISSING"

   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"   # macOS
   # Linux: CHROME=$(command -v google-chrome || command -v chromium || command -v chromium-browser)
   PROFILE=$(mktemp -d /tmp/peloton_chrome.XXXXXX)
   "$CHROME" --headless --disable-gpu --no-first-run --user-data-dir="$PROFILE" \
     --no-pdf-header-footer --print-to-pdf="<WORK>/receipt.pdf" \
     "file://<WORK>/receipt.html" 2>&1 | grep 'bytes written'
   rm -rf "$PROFILE"
   ```

   Notes, all learned the hard way:
   - Use a throwaway `--user-data-dir`. Without it Chrome may attach to a running instance and print nothing.
   - Do **not** add `--blink-settings=scriptEnabled=false`. With that flag Chrome
     exits without writing a PDF. Scripts are already stripped, so it is not needed.
   - Expect `bytes written` in the output. A PDF under ~20 KB (the blank-page
     result was 872 bytes) means the receipt did not render. Check for
     `BODY_MISSING` and see step 8.
   - On `CAPTURE_MOVE_FAILED`, stop and run the cleanup command. It deletes the
     project-directory copy.
   - Chrome logs harmless `CVDisplayLinkCreateWithCGDisplay failed` errors on macOS. Ignore them.

### 7. Rename and move the file

1. Pick the filename:
   - With an amount: `Peloton_Invoice_October_2026_GBP45.00.pdf`
   - If `amount` is `null`: `Peloton_Invoice_October_2026.pdf`
   - If a month has more than one invoice, append the first 8 characters of
     the invoice ID: `Peloton_Invoice_October_2026_GBP45.00_a1b2c3d4.pdf`

   Every part comes from values that passed the step 4 guards (month name,
   4-digit year, `\d+\.\d{2}` amount, hex ID), so the name is shell-safe.

2. Run the check, move, and verify as **one** Bash call. Shell variables do not
   persist between separate tool calls, so splitting this up leaves `$dest`
   empty in the later commands. `<SAVE_DIR>` is the absolute path from step 1,
   in single quotes; never substitute a `~` path here.

   ```bash
   SAVE_DIR='<SAVE_DIR>'
   filename='Peloton_Invoice_<Month>_<Year>_GBP<Amount>.pdf'
   dest="$SAVE_DIR/$filename"
   if [ "${SAVE_DIR#/}" = "$SAVE_DIR" ]; then
     echo "SAVE_DIR_NOT_ABSOLUTE: $SAVE_DIR"
   elif [ -e "$dest" ]; then
     echo "EXISTS: $dest"
   elif mkdir -p "$SAVE_DIR" && mv -n "<WORK>/receipt.pdf" "$dest" \
        && test ! -e "<WORK>/receipt.pdf" && test -s "$dest"; then
     echo "SAVED: $dest"
   else
     echo "MOVE_FAILED: $dest"
   fi
   ```

   - `SAVED: <path>`: carry on to step 9 with that path.
   - `EXISTS: <path>`: ask the user whether to overwrite, save with a suffix
     (e.g. `_2`), or skip. Re-run the block with the new `filename` (or with
     `mv -f` to overwrite). Never report the existing file as the new download.
     If they skip, run the cleanup command.
   - `SAVE_DIR_NOT_ABSOLUTE`: go back to step 1 and resolve the path.
   - `MOVE_FAILED`: report it, then run the cleanup command.

### 8. Diagnostic capture on failure

If a snippet returned an `error` shape, or the PDF came out blank:

1. Take a screenshot **without** `filePath`, so it is returned inline and no
   image of the receipt (name, address) is left on disk.
2. Use `list_network_requests` (filter `resourceTypes: ["fetch","xhr"]`) and
   report the GraphQL and API URLs with their status codes. Do not fetch request
   details: `get_network_request` echoes the bearer token and cookies.
3. Report the error code (e.g. `history_shape_changed`, `token_expired`) and what the screenshot shows.
4. Point the user at `references/peloton-api-endpoints.md`. The snapshot may need regenerating against the live site.
5. Run the cleanup command before stopping.

### 9. Verify the PDF and clean up

1. Use the Read tool to view the PDF. If it cannot render it, fall back to `pdftotext -layout <file> -`.
2. Check:
   - **Date match**: the payment date on the PDF equals `displayDate` for the requested month.
   - **Amount match**: the total cost and "Total amount paid" equal `amount`.
     If `amount` was `null`, read the total off the PDF and report it.
   - **Valid receipt**: "Peloton Interactive UK Limited" (or the regional
     entity), a "VAT ID Number", and the subtotal / tax split are present.
3. Run the cleanup command (see "Temporary files and cleanup") whether
   verification passed or failed. It must print `CLEANUP_OK`.
4. Report:
   - File saved to: `<full path>`
   - Payment date: `<dd/mm/yyyy>` (`<Month Year>`)
   - Amount: `<amount>` (VAT `<tax>`)
   - Verification: passed or failed (with details)
   - Cleanup: `CLEANUP_OK`, or which file is left over

If verification fails, warn the user with specifics but keep the saved PDF.
Only the temporary files are deleted.

For multiple months, repeat steps 5 to 9 for each invoice, with a fresh
`<WORK>` each time (cleaned up at the end of each invoice). Reuse the
subscription ID, `<SAVE_DIR>`, and the step 4 list; do not reuse page-check
results from the previous invoice.

## Error handling

| Scenario | Action |
| -------- | ------ |
| MCP Chrome won't start (stale lock) | Clean up `~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock` per Prerequisites |
| Not logged in | Ask user to log in, `wait_for` "Memberships on file" with 120s timeout |
| Login `wait_for` matched instantly on the login page | Waited for a generic word ("Membership" is in the login footer). Use the exact texts in step 2 |
| Login lands on `members.onepeloton.com/en-GB/home` | Navigate back to `https://account.onepeloton.co.uk/mymembership` |
| `members.onepeloton.com/.../preferences/subscriptions` shows "Page not found" | Wrong site. Invoices live on `account.onepeloton.com` only |
| `no_token_key` / `no_access_token` / `token_expired` | Reload `/mymembership` so the SPA refreshes its token, then re-run step 3. If it persists, ask the user to log in again |
| `subs_failed` / `history_failed` 401 | Token rejected. Reload the page and re-run from step 3 once, then ask the user to re-login |
| `*_graphql_error` / `*_shape_changed` | The GraphQL schema moved. Run step 8 and compare against `references/peloton-api-endpoints.md` |
| App-store billing (`Apple`, `Google`, `Amazon`, `Roku`) | No Peloton invoice exists. Tell the user to get the receipt from that store |
| `placeholder_not_replaced` / `invalid_identifier` | Operator error in substitution. Fix the literal and re-run |
| Requested month not in list | List available months with amounts, ask user to pick |
| Receipt page never shows "Total amount paid" | Take a screenshot. Check the invoice ID and subscription ID belong together |
| PDF is ~1 KB / blank | `<body>` was stripped or Chrome got `scriptEnabled=false`. Re-check step 6 |
| Headless Chrome prints nothing | Make sure a fresh `--user-data-dir` was passed and the HTML path is absolute |
| Destination file exists | Ask: overwrite, suffix, or skip |
| A literal `~` directory appeared in the working directory | A quoted `~` path was substituted. Resolve `<SAVE_DIR>` with step 1, move the PDF out, and remove the stray directory after confirming it only holds this skill's output |
| `CAPTURE_MOVE_FAILED` / `CLEANUP_INCOMPLETE` | A receipt copy may remain in `<PROJECT_DIR>`. Tell the user the exact path; it contains their name and address |
| Any failure after step 6 started | Run the cleanup command before stopping |
| PDF verification mismatch | Warn user with specifics, keep the file |
