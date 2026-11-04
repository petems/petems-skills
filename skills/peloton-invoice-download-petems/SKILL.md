---
name: peloton-invoice-download-petems
description: >-
  Download and verify Peloton membership invoices (All-Access and App
  memberships billed by Peloton to a card) as PDFs via Chrome DevTools, using
  the Peloton account GraphQL API to find invoices and headless Chrome to print
  them. Use this skill whenever the user wants to download, grab, fetch, or
  save a Peloton invoice, receipt, or membership bill, including for expense or
  fitness reimbursement claims. Memberships billed through an app store or a
  mobile carrier have no Peloton invoice; the skill says so and points to the
  right biller.
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
  - mcp__chrome-devtools__close_page
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
3. opens the receipt page in its own tab, captures its rendered HTML with all
   scripts removed and a script-blocking Content-Security-Policy added,
4. prints that HTML to PDF with a separate headless Chrome, and
5. verifies the PDF **before** saving it.

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
- Every request goes to Peloton's own first-party endpoints. Do not add any other destination.

## Safe paths

Paths get pasted into Bash commands, so a path containing shell syntax could
run commands. Two rules, applied everywhere:

1. **Every substituted path goes inside single quotes** (`'<WORK>'`, never
   `"<WORK>"`). Inside single quotes `$`, backticks, `"` and `\` are literal.
2. **A path may not contain a single quote or a newline**, the only two
   characters that can break out of single quotes. Check this on the
   **resolved** path, not just the user's text: a symlink can resolve to a
   target containing a quote.

The step 1 and step 6 commands enforce rule 2 and print `UNSAFE_PATH` instead
of a path when it fails. If that happens, stop and ask the user for a
different location (or to run from a different directory). `<WORK>` comes
from `mktemp` and only contains safe characters.

## Temporary files and cleanup

The captured receipt holds the user's name and billing address. For each
invoice, every temporary file lives in exactly one of these places:

| Placeholder | What | Where |
| --- | --- | --- |
| `<WORK>` | Decoded HTML, the unsaved PDF, and the headless Chrome profile | `mktemp -d /tmp/peloton_invoice.XXXXXX` (step 6) |
| `<CAPTURE>` | Raw `evaluate_script` output, only if `<WORK>` is rejected | `<PROJECT_DIR>/.peloton_receipt_<RAND>.json`, moved into `<WORK>` immediately |

`<PROJECT_DIR>` is the current working directory, and `<RAND>` is the random
suffix of `<WORK>` (the part after `peloton_invoice.`). Because the capture
name includes `<RAND>`, cleanup only ever touches this run's file. It never
deletes other `.peloton_receipt_*` files.

**Run the cleanup command on every exit path**: after a successful save, after
a verification failure, after any error or diagnostic capture, when the user
aborts, and before ending your turn for any other reason.

```bash
rm -rf '<WORK>'
rm -f '<PROJECT_DIR>/.peloton_receipt_<RAND>.json'
if [ -e '<WORK>' ] || [ -e '<PROJECT_DIR>/.peloton_receipt_<RAND>.json' ]; then
  echo CLEANUP_INCOMPLETE
else
  echo CLEANUP_OK
fi
```

If the tool reported a different `<SAVED_PATH>` in step 6 (for example with a
normalised extension), add `rm -f '<SAVED_PATH>'` and include it in the check.
If `<WORK>` was never created, there is nothing to clean. If the output is
`CLEANUP_INCOMPLETE`, tell the user the exact leftover path.

Also close the receipt tab opened in step 5 (`close_page` with `<RECEIPT_PAGE>`) if it is still open.

## Steps

### 1. Parse user request

Determine:

- **Target month(s)**: Which invoice(s) to download. Default to the latest if not specified. Multiple months are supported (process them one at a time).
- **Save location**: Where to save the PDF(s). Default to `~/Desktop/` if not specified.

Resolve the save location to an absolute path now, and record the output as
`<SAVE_DIR>`. Never put `~` inside quotes in a later command: the shell does
not expand a quoted tilde, so `mkdir -p "~/Desktop"` creates a literal `~`
directory under the current directory.

```bash
python3 -I -c '
import os, sys
p = os.path.realpath(os.path.expanduser(sys.argv[1]))
if "\x27" in p or "\n" in p:
    print("UNSAFE_PATH"); sys.exit(1)
print(p)' '<RAW_SAVE_LOCATION>'
```

- Put the user's text inside the single quotes as-is. If the text itself
  contains a single quote or a newline, do not run the command: ask the user
  for a different path.
- The printed path is `<SAVE_DIR>` (for the default, e.g. `/Users/<name>/Desktop`).
  On `UNSAFE_PATH` (for example, a symlink to a directory whose name has a
  quote), ask the user for a different path.

**Billing cycle note**: Peloton charges monthly on the membership renewal
date, which is fixed per account (shown as "Renews DD/MM/YYYY" on the
membership page). On the reference account that is around the 7th. If the
user asks for the current month's invoice and the renewal date has not passed
yet, tell them it does not exist yet and offer the previous month's instead.
Step 4 lists the real dates, so confirm there rather than guessing.

Confirm parameters with the user before proceeding.

### 2. Navigate to the membership page and handle login

1. Navigate to `https://account.onepeloton.co.uk/mymembership`. It redirects to
   `https://account.onepeloton.com/<locale>/mymembership` (e.g. `en-GB`) when
   logged in, or to the Auth0 login form on `auth.onepeloton.com` when not.
   For a non-UK account, use the regional site's account URL instead.
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

### 3. Resolve the subscription(s)

Run via `evaluate_script` on the `account.onepeloton.com` page. It picks a
valid token from any matching Auth0 cache entry, reads the locale and country
from the URL, lists subscriptions, and stores the token on `window` for step 4.
Requests have a 20-second timeout, and network failures come back as named
errors instead of throwing.

```javascript
async () => {
  const locale = location.pathname.split('/')[1] || '';
  if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale)) return { error: 'locale_not_found', path: location.pathname.slice(0, 60) };
  const country = locale.slice(3);
  const keys = Object.keys(localStorage).filter(k => k.startsWith('@@auth0spajs@@') && k.includes('::https://api.onepeloton.com/::'));
  if (keys.length === 0) return { error: 'no_token_key' };
  // Try every matching cache entry; the first may be stale while a later one is valid.
  let token = null, sawExpired = false;
  for (const k of keys) {
    let entry;
    try { entry = JSON.parse(localStorage.getItem(k)); } catch (e) { continue; }
    const t = entry?.body?.access_token;
    if (typeof t !== 'string' || t.length < 20) continue;
    if (Number.isFinite(entry?.expiresAt) && entry.expiresAt * 1000 < Date.now()) { sawExpired = true; continue; }
    token = t; break;
  }
  if (!token) return { error: sawExpired ? 'token_expired' : 'no_access_token', keyCount: keys.length };
  window.__pelotonToken = token;
  window.__pelotonGql = async (operationName, query, variables) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch('https://graph.prod.k8s.onepeloton.com/graphql', {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${window.__pelotonToken}`, 'apollographql-client-name': 'account' },
        body: JSON.stringify({ operationName, query, variables }),
      });
      const text = await r.text();
      if (r.status !== 200) return { status: r.status, snippet: text.slice(0, 200) };
      try { return { status: 200, body: JSON.parse(text) }; } catch (e) { return { status: 200, parseError: true, snippet: text.slice(0, 200) }; }
    } catch (e) {
      return { networkError: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e).slice(0, 120) };
    } finally { clearTimeout(timer); }
  };
  const res = await window.__pelotonGql('Subs',
    'query Subs($input: SubPelotonMemberInput!) { subPelotonMember(input: $input) { subscriptions { id isActive status billingStrategy billingPlan { id subscriptionType } } } }',
    { input: { billingStrategyFilters: [], subscriptionTypeFilters: [], country } });
  if (res.networkError) return { error: 'network_error', detail: res.networkError };
  if (res.status !== 200) return { error: 'subs_failed', status: res.status, snippet: res.snippet };
  if (res.parseError) return { error: 'subs_unparseable', snippet: res.snippet };
  const body = res.body;
  if (body?.errors?.length) return { error: 'subs_graphql_error', messages: body.errors.map(e => e.message).slice(0, 3) };
  const subs = body?.data?.subPelotonMember?.subscriptions;
  if (!Array.isArray(subs)) return { error: 'subs_shape_changed', dataKeys: Object.keys(body?.data || {}) };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return {
    locale, country,
    subscriptions: subs.filter(s => typeof s?.id === 'string' && uuid.test(s.id)).map(s => ({
      id: s.id, isActive: s.isActive, status: s.status, billingStrategy: s.billingStrategy, plan: s.billingPlan?.id,
    })),
  };
}
```

Record `locale` as `<LOCALE>`. Only `en-GB` / `GB` has been verified against
the live site; for any other locale, tell the user the skill is untested there
and continue carefully.

Sort the subscriptions into:

- **Invoice candidates**: `billingStrategy: "AutoDebit"`, active or not. A
  cancelled membership still has past invoices. Order them active first.
  The **primary** is the active one. If none is active, the primary is the
  only candidate; if several, ask the user which to use.
- **No Peloton invoices**: tell the user where the receipt lives instead.
  - `Apple`, `Google`, `Amazon`, `Roku`: the respective app store's purchase history.
  - `Bango`: billed through a mobile carrier or partner via Bango. The charge is on that provider's bill.
  - `NotBilled` (for example `PRE_DELIVERY`): never charged, so there is no receipt.

If there are no invoice candidates at all, explain which biller applies and
stop (run the cleanup command if anything was created, which at this point it
was not).

### 4. List invoices

**`evaluate_script` cannot take arbitrary arguments.** Its `args` parameter
accepts element uids from a snapshot only, and `sourcePath` is sandboxed to the
workspace roots (`/tmp` is rejected), so pass the snippet inline via
`function`. Inline values as literals too: replace the whole quoted
placeholder, quotes included, with the output of `JSON.stringify(value)`. The
guards below reject a missed or malformed substitution before any request is made.

Run this for the primary subscription first.

```javascript
async () => {
  const subscriptionId = "REPLACE_WITH_SUBSCRIPTION_ID";
  if (/REPLACE_WITH_/.test(subscriptionId)) return { error: 'placeholder_not_replaced', field: 'subscriptionId' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(subscriptionId)) return { error: 'invalid_identifier', field: 'subscriptionId' };
  if (!window.__pelotonToken || typeof window.__pelotonGql !== 'function') return { error: 'no_token_rerun_step_3' };
  const res = await window.__pelotonGql('PaymentHistory',
    'query PaymentHistory($input: SubPelotonSubscriptionInput!) { subPelotonSubscription(input: $input) { id pastInvoices { id createdAt '
      + 'invoicePayments { paymentDate totalAmount { currencyCode centAmount } } '
      + 'billingSummary { totalAmount { currencyCode centAmount } tax { centAmount } } } } }',
    { input: { subscriptionId } });
  if (res.networkError) return { error: 'network_error', detail: res.networkError };
  if (res.status !== 200) return { error: 'history_failed', status: res.status, snippet: res.snippet };
  if (res.parseError) return { error: 'history_unparseable', snippet: res.snippet };
  const body = res.body;
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
    const rawCurrency = inv?.billingSummary?.totalAmount?.currencyCode ?? inv?.invoicePayments?.[0]?.totalAmount?.currencyCode;
    const currency = typeof rawCurrency === 'string' && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : null;
    const amount = Number.isInteger(cents) && cents >= 0 ? (cents / 100).toFixed(2) : null;
    const taxCents = inv?.billingSummary?.tax?.centAmount;
    invoices.push({
      id: inv.id,
      subscriptionId,
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

- **Empty list** (`count: 0`): if other invoice candidates exist, run this step
  for each of them. If none has invoices, tell the user there are no Peloton
  invoices on the account yet, and stop.
- **"Latest"**: take `invoices[0]` of the primary.
- **A named month/year**: find the entry with matching `month` and `year`. If a
  month has more than one invoice (a plan change or a retried payment), list
  them and ask the user which they want, or offer all of them.
- **No match on the primary**: before reporting a miss, run this step for each
  other invoice candidate (cancelled `AutoDebit` subscriptions) and search
  those lists too. Each invoice carries its own `subscriptionId`; use that one
  in step 5.
- **Still no match**: list the available `{month, year, amount}` entries
  across all candidates and ask the user to pick. Do not proceed.

`amount` is a 2-decimal string or `null`, and `currency` is a 3-letter code or `null`.

### 5. Open the receipt in its own tab

For each invoice, one at a time:

1. Open a **new** tab with `new_page` and this URL, and record the returned
   page ID as `<RECEIPT_PAGE>`. Use it as `pageId` for every call in steps 5
   and 6, so another run or tab cannot swap the receipt under you:

   ```text
   https://account.onepeloton.com/<LOCALE>/mymembership/v2/subscriptions/<SUBSCRIPTION_ID>/invoices/<INVOICE_ID>
   ```

   Build it from values that passed the guards: `<LOCALE>` matched
   `^[a-z]{2}-[A-Z]{2}$` in step 3, the invoice's `subscriptionId` is a dashed
   UUID, and its `id` is 32 hex characters.

2. The receipt renders client-side. `wait_for` text `["Total amount paid"]` with a 20000ms timeout.
   On timeout, the error is `receipt_not_rendered`: go to step 9.
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

1. Create a private working directory and check the project path. Record
   the first line as `<WORK>` and the second as `<PROJECT_DIR>`:

   ```bash
   mktemp -d /tmp/peloton_invoice.XXXXXX && python3 -I -c '
   import os, sys
   p = os.getcwd()
   if "\x27" in p or "\n" in p:
       print("UNSAFE_PATH"); sys.exit(1)
   print(p)'
   ```

   If the second line is `UNSAFE_PATH`, do not capture into the project
   directory: try only `<WORK>` in the next item, and if that is rejected,
   stop, run the cleanup command, and ask the user to run from a directory
   whose path has no single quote.

2. Call `evaluate_script` on `<RECEIPT_PAGE>` with `filePath: "<WORK>/receipt.json"`
   and the function below, with the invoice ID substituted via `JSON.stringify`.
   The MCP usually rejects paths outside the workspace roots (as it does for
   `/tmp`). If it does, call it again with
   `filePath: "<PROJECT_DIR>/.peloton_receipt_<RAND>.json"`. That is `<CAPTURE>`,
   and item 3 moves it out of the project straight away.

   The function refuses to capture unless the page is this invoice's receipt.
   It copies all CSS inline, removes scripts, frames, forms, trackers, the
   cookie banner, inline `on*` handlers, and `javascript:` URLs, then adds a
   Content-Security-Policy that blocks all script execution and network
   requests other than styles, fonts, and images. The offline copy therefore
   cannot run code or send the receipt anywhere when headless Chrome opens it.

   ```javascript
   () => {
     const invoiceId = "REPLACE_WITH_INVOICE_ID";
     if (!/^[0-9a-f]{32}$/.test(invoiceId)) return 'ERROR:invalid_identifier';
     if (!location.pathname.endsWith('/invoices/' + invoiceId)) return 'ERROR:wrong_page';
     if (!document.body.innerText.includes('Total amount paid')) return 'ERROR:receipt_not_rendered';
     const css = [];
     for (const s of document.styleSheets) {
       try { css.push([...s.cssRules].map(r => r.cssText).join('\n')); }
       catch (e) { if (s.href) css.push(`@import url("${s.href}");`); }
     }
     const doc = document.documentElement.cloneNode(true);
     // Remove by tag or id only. NEVER select on class substrings like
     // [class*="fides"]: the consent tool adds a fides-* class to <body>,
     // which deletes the whole receipt and prints a blank page.
     doc.querySelectorAll('script, noscript, iframe, frame, object, embed, link, style, meta, base, form, #fides-overlay, #ada-entry, #fb-root, #post-order-banner, .Toastify, next-route-announcer, #podscribe-request, [id^="batBeacon"]').forEach(n => n.remove());
     for (const el of doc.querySelectorAll('*')) {
       for (const a of [...el.attributes]) {
         if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction|srcset)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) {
           el.removeAttribute(a.name);
         }
       }
     }
     const head = doc.querySelector('head');
     const csp = document.createElement('meta');
     csp.setAttribute('http-equiv', 'Content-Security-Policy');
     csp.setAttribute('content', "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline' https:; img-src https: data:; font-src https: data:");
     head.prepend(csp);
     const charset = document.createElement('meta');
     charset.setAttribute('charset', 'utf-8');
     head.prepend(charset);
     const style = document.createElement('style');
     style.textContent = css.join('\n') + '\n@page { size: A4; margin: 12mm; }';
     head.append(style);
     return '<!DOCTYPE html>\n' + doc.outerHTML;
   }
   ```

   `filePath` output is a **JSON-encoded string**, and the tool may normalise
   the extension to `.json`. Use the path the tool reports as `<SAVED_PATH>`.

3. In **one** Bash call, move the capture into `<WORK>`, decode it, and print.
   Each stage runs only if the previous one succeeded, and the move comes
   first so a receipt written into the project is gone before anything else
   can fail. Set `CHROME` for the platform.

   ```bash
   WORK='<WORK>'
   SAVED_PATH='<SAVED_PATH>'
   CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'   # macOS
   # Linux: CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"
   if ! { [ "$SAVED_PATH" = "$WORK/receipt.json" ] || mv -f "$SAVED_PATH" "$WORK/receipt.json"; }; then
     echo "CAPTURE_MOVE_FAILED"
   elif ! python3 -I -c '
   import json, sys
   s = json.load(open(sys.argv[1]))
   if not isinstance(s, str) or s.startswith("ERROR:"):
       print(s if isinstance(s, str) else "ERROR:not_a_string"); sys.exit(1)
   open(sys.argv[2], "w").write(s)' "$WORK/receipt.json" "$WORK/receipt.html"; then
     echo "CAPTURE_ERROR"
   elif ! grep -q '<body' "$WORK/receipt.html"; then
     echo "BODY_MISSING"
   else
     "$CHROME" --headless --disable-gpu --no-first-run --user-data-dir="$WORK/chrome-profile" \
       --no-pdf-header-footer --print-to-pdf="$WORK/receipt.pdf" \
       "file://$WORK/receipt.html" 2>&1 | grep 'bytes written'
     rm -rf "$WORK/chrome-profile"
     size=$(wc -c < "$WORK/receipt.pdf" 2>/dev/null || echo 0)
     if [ "$size" -ge 20000 ]; then echo "PRINTED: $size bytes"; else echo "PDF_BLANK: $size bytes"; fi
   fi
   ```

   | Output | Meaning and action |
   | --- | --- |
   | `PRINTED: <n> bytes` | Continue to step 7 |
   | `CAPTURE_MOVE_FAILED` | Step 9, then cleanup (it deletes the project-directory copy) |
   | `ERROR:<code>` then `CAPTURE_ERROR` | The capture function refused (`wrong_page`, `receipt_not_rendered`, `invalid_identifier`). Step 9 |
   | `BODY_MISSING` | The receipt body was stripped. Step 9; do not print or save |
   | `PDF_BLANK: <n> bytes` | Rendered blank (a blank render was 872 bytes). Step 9; do not save |

   Notes, all learned the hard way:
   - The Chrome profile lives inside `<WORK>`, so the cleanup command removes it even if the run is interrupted.
   - Always pass a fresh `--user-data-dir`. Without it Chrome may attach to a running instance and print nothing.
   - Do **not** add `--blink-settings=scriptEnabled=false`. With that flag Chrome
     exits without writing a PDF. The capture's CSP already blocks scripts.
   - Chrome logs harmless `CVDisplayLinkCreateWithCGDisplay failed` errors on macOS. Ignore them.

### 7. Verify the PDF before saving

Check the unsaved PDF, so a wrong or blank receipt never reaches the save
location (or overwrites a good file there).

1. Run, substituting `displayDate` and `amount` (both format-checked in step 4,
   so they are safe in single quotes). If `amount` is `null`, remove it from the list:

   ```bash
   txt=$(pdftotext -layout '<WORK>/receipt.pdf' - 2>/dev/null)
   ok=1
   for needle in '<DISPLAY_DATE>' '<AMOUNT>' 'VAT ID Number' 'Total amount paid'; do
     printf '%s' "$txt" | grep -qF -- "$needle" || { echo "MISSING: $needle"; ok=0; }
   done
   [ "$ok" = 1 ] && echo VERIFY_OK
   ```

2. Also view it with the Read tool (pages "1"), and confirm visually that it is
   the expected receipt: "Peloton Interactive UK Limited" (or the regional
   entity), the payment date, the subtotal / tax / total, and the amount paid.
3. On `VERIFY_OK`, continue to step 8. On any `MISSING:` line, do not save.
   Show the user what is missing and what the PDF says, then ask whether to
   save it anyway. If not, go to step 10 (cleanup).

### 8. Save the PDF

1. Pick the filename:
   - Amount and currency known: `Peloton_Invoice_October_2026_GBP45.00.pdf`
   - Amount or currency `null`: `Peloton_Invoice_October_2026.pdf` (never label an unknown currency as GBP)
   - If a month has more than one invoice, append the first 8 characters of
     the invoice ID: `Peloton_Invoice_October_2026_GBP45.00_a1b2c3d4.pdf`

   Every part comes from values that passed the step 4 guards (month name,
   4-digit year, 3-letter currency, `\d+\.\d{2}` amount, hex ID), so the name
   is safe in single quotes.

2. Run the save as **one** Bash call. Shell variables do not persist between
   separate tool calls. Leave `OVERWRITE=0` unless the user has explicitly
   chosen to overwrite after seeing `EXISTS` (and the PDF passed step 7).

   ```bash
   SAVE_DIR='<SAVE_DIR>'
   filename='<FILENAME>'
   OVERWRITE=0
   dest="$SAVE_DIR/$filename"
   if [ "$OVERWRITE" = 1 ]; then mvflag=-f; else mvflag=-n; fi
   if [ "${SAVE_DIR#/}" = "$SAVE_DIR" ]; then
     echo "SAVE_DIR_NOT_ABSOLUTE: $SAVE_DIR"
   elif [ -e "$dest" ] && [ "$OVERWRITE" != 1 ]; then
     echo "EXISTS: $dest"
   elif mkdir -p "$SAVE_DIR" && mv "$mvflag" '<WORK>/receipt.pdf' "$dest" \
        && test ! -e '<WORK>/receipt.pdf' && test -s "$dest"; then
     echo "SAVED: $dest"
   else
     echo "MOVE_FAILED: $dest"
   fi
   ```

   - `SAVED: <path>`: continue to step 10.
   - `EXISTS: <path>`: ask the user whether to overwrite, save with a suffix
     (e.g. `_2`), or skip. To overwrite, re-run the block with `OVERWRITE=1`.
     For a suffix, re-run with the new `filename`. Never report the existing
     file as the new download. If they skip, go to step 10.
   - `SAVE_DIR_NOT_ABSOLUTE`: go back to step 1 and resolve the path.
   - `MOVE_FAILED`: report it, then go to step 10.

### 9. Diagnostic capture on failure

If a snippet returned an `error` shape, the receipt never rendered, or the capture or print failed:

1. Take a screenshot **without** `filePath`, so it is returned inline and no
   image of the receipt (name, address) is left on disk.
2. Use `list_network_requests` (filter `resourceTypes: ["fetch","xhr"]`) and
   report the GraphQL and API URLs with their status codes. Do not fetch request
   details: `get_network_request` echoes the bearer token and cookies.
3. Report the error code (e.g. `history_shape_changed`, `token_expired`,
   `network_error`, `receipt_not_rendered`, `PDF_BLANK`) and what the screenshot shows.
4. Point the user at `references/peloton-api-endpoints.md`. The snapshot may need regenerating against the live site.
5. Go to step 10.

### 10. Clean up and report

1. Run the cleanup command (see "Temporary files and cleanup") and close
   `<RECEIPT_PAGE>`. It must print `CLEANUP_OK`.
2. Report:
   - File saved to: `<full path>` (or why nothing was saved)
   - Payment date: `<dd/mm/yyyy>` (`<Month Year>`)
   - Amount: `<amount>` (VAT `<tax>`)
   - Verification: `VERIFY_OK`, or what was missing
   - Cleanup: `CLEANUP_OK`, or which file is left over

For multiple months, repeat steps 5 to 10 for each invoice, with a fresh
`<WORK>` and a fresh receipt tab each time. Reuse `<LOCALE>`, `<SAVE_DIR>`, and
the step 4 lists; do not reuse page-check or verification results from the
previous invoice.

## Error handling

| Scenario | Action |
| -------- | ------ |
| MCP Chrome won't start (stale lock) | Clean up `~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock` per Prerequisites |
| Not logged in | Ask user to log in, `wait_for` "Memberships on file" with 120s timeout |
| Login `wait_for` matched instantly on the login page | Waited for a generic word ("Membership" is in the login footer). Use the exact texts in step 2 |
| Login lands on `members.onepeloton.com/en-GB/home` | Navigate back to `https://account.onepeloton.co.uk/mymembership` |
| `members.onepeloton.com/.../preferences/subscriptions` shows "Page not found" | Wrong site. Invoices live on `account.onepeloton.com` only |
| `locale_not_found` | Not on the account site's `/<locale>/mymembership` page. Navigate there and retry |
| `no_token_key` / `no_access_token` / `token_expired` | Reload `/mymembership` so the SPA refreshes its token, then re-run step 3. If it persists, ask the user to log in again |
| `network_error` | Gateway unreachable or timed out (20s). Retry once; if it persists, step 9 |
| `subs_failed` / `history_failed` 401 | Token rejected. Reload the page and re-run from step 3 once, then ask the user to re-login |
| `*_graphql_error` / `*_shape_changed` / `*_unparseable` | The GraphQL schema moved. Step 9, and compare against `references/peloton-api-endpoints.md` |
| `Apple` / `Google` / `Amazon` / `Roku` / `Bango` / `NotBilled` | No Peloton invoice exists. Point the user at the right biller (step 3) |
| No invoices on any candidate subscription | Tell the user there are no Peloton invoices yet |
| `placeholder_not_replaced` / `invalid_identifier` | Operator error in substitution. Fix the literal and re-run |
| Requested month not in any candidate's list | List available months with amounts, ask user to pick |
| `receipt_not_rendered` | Receipt never showed "Total amount paid". Step 9; check the invoice ID and subscription ID belong together |
| `wrong_page` | The tab is not on this invoice's receipt. Re-open it with `new_page` and use that page ID |
| `BODY_MISSING` / `PDF_BLANK` | `<body>` was stripped or Chrome got `scriptEnabled=false`. Re-check step 6; nothing is saved |
| Headless Chrome prints nothing | Make sure `--user-data-dir` points at a fresh directory and the HTML path is absolute |
| `MISSING:` lines in step 7 | Not the expected receipt. Do not save unless the user explicitly asks |
| `EXISTS` | Ask: overwrite (`OVERWRITE=1`), suffix, or skip |
| `UNSAFE_PATH` | The save path or project path contains a single quote or newline (possibly via a symlink). Ask for a different path |
| A literal `~` directory appeared in the working directory | A quoted `~` path was substituted. Resolve `<SAVE_DIR>` with step 1, move the PDF out, and remove the stray directory after confirming it only holds this skill's output |
| `CAPTURE_MOVE_FAILED` / `CLEANUP_INCOMPLETE` | A receipt copy may remain. Tell the user the exact path; it contains their name and address |
| Any failure after step 6 started | Run the cleanup command before stopping |
