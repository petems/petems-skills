---
name: three-phone-bill-download-petems
description: Download and verify a Three UK bill PDF via Chrome DevTools, using the My3 JSON API directly (resilient to SPA UI changes)
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

# Download a Three UK bill PDF

When the user asks to download a bill from Three.co.uk, follow these steps.
This skill uses Chrome DevTools MCP to log in to My3, then calls the
underlying `/rp-server-b2c/` JSON API directly to list and download bills.
The previous version of this skill scraped the `/account/view-bill` page;
that flow broke when Three redesigned the portal in early 2026. The API
flow is much less brittle: Three's React SPA changes often, the JSON
contract does not.

See `references/three-api-endpoints.md` for a frozen snapshot of the endpoints, headers, and response shapes this skill depends on.

## Prerequisites

- **Chrome DevTools MCP server** configured and running (`npx @anthropic-ai/chrome-devtools-mcp@latest`)
- The MCP server registered in Claude Code settings under `mcpServers`
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

Confirm parameters with the user before proceeding.

### 2. Navigate to Three.co.uk and handle login

1. Navigate to `https://www.three.co.uk/customer-login`. This redirects to the account dashboard if already logged in, or shows the login form (hosted on `auth.three.co.uk`) if not.
2. Take a snapshot.
3. **Cookie consent**: If "Accept all" / "Accept cookies" is visible, click it. For other overlays, press Escape.
4. **Check login state**: If the snapshot shows "Good morning", "Dashboard", or "Account Number", or the URL is `/account`, the user is logged in. Proceed to Step 3.
5. **If not logged in**:
   - Tell the user: "Please log in to your Three account in the Chrome browser window. I will wait for you to complete login."
   - Use `wait_for` with timeout 120000ms, looking for text such as `["Good morning", "Dashboard", "Account Number"]`.
   - Once login is detected, take a fresh snapshot.
6. Never enter credentials on behalf of the user.
7. **Normalise the page origin.** After login the active tab can be left on
   `auth.three.co.uk` rather than `www.three.co.uk`. Evaluate the current
   URL; if the origin is not `https://www.three.co.uk`, navigate to
   `https://www.three.co.uk/account` and take a fresh snapshot. Steps 3, 4,
   and 5 use origin-relative `/rp-server-b2c/...` URLs and rely on the
   `www.three.co.uk` session cookies.
8. **Load the dashboard, not just the landing page.** Auth0 drops you on
   `https://www.three.co.uk/customer-logged`, which is a marketing landing
   page. It does *not* populate customer state: on that page the customer ID
   reads back as the literal string `"undefined"` and the redux store holds
   `customerId: ""`. Navigate to `https://www.three.co.uk/account` and wait
   for `["Account Number", "Good morning", "Good afternoon", "Good evening"]`
   before attempting step 3.
9. **Confirm the session is not anonymous.** An Auth0 login can succeed while
   the Three backend session stays anonymous (this happens if the browser was
   killed mid-flow). Check it before spending calls:

   Fail closed: only a literal `isAnonymous === false` counts as authenticated.
   A 200 carrying a missing or non-boolean `isAnonymous` is treated as a
   failure, not as permission to continue.

   ```javascript
   async () => {
     const r = await fetch('/rp-server-b2c/authentication/v1/B2C/user?salesChannel=selfService', { credentials: 'include' });
     if (r.status !== 200) return { error: 'auth_check_failed', status: r.status };
     let b;
     try { b = await r.json(); } catch (e) { return { error: 'auth_check_unparseable', message: String(e) }; }
     if (b?.isAnonymous !== false) {
       return { error: 'session_not_authenticated', isAnonymous: b?.isAnonymous ?? null, bodyKeys: Object.keys(b || {}) };
     }
     return { authenticated: true, userId: b?.userId };
   }
   ```

   Proceed only on `authenticated: true`. On any error shape (including
   `session_not_authenticated`, a 500, or an unparseable body) the My3 session
   is broken even though the header shows "My3 account". Ask the user to log in
   again and do not proceed. Symptom if you push on regardless:
   `/account/view-bill` renders "Something went wrong. We can't load this page
   right now." with an error code.

### 3. Resolve the customer ID

The customer ID (`cuid`) is needed for every API call. It comes from the
SPA's redux store, persisted in `sessionStorage` under
`persist:customerProfilePersistor`.

Do **not** try the `_tms_persistUser` cookie. Earlier versions of this skill
did; its value is the literal string `false` (a remember-me flag), not a JSON
blob with a `cuid` field. `JSON.parse("false")` yields `false`, so the old
extraction always failed with `no_cuid_in_cookie` and empty `keys`.

`redux-persist` double-encodes: the outer value is JSON whose *values are
themselves JSON strings*, so `customerId` parses out of `"\"949613941\""`.
This only works once the dashboard has loaded (step 2.8).

Run via `evaluate_script`:

```javascript
() => {
  const raw = sessionStorage.getItem('persist:customerProfilePersistor');
  if (!raw) return { error: 'persistor_missing' };
  let outer;
  try { outer = JSON.parse(raw); } catch (e) { return { error: 'persistor_parse_failed', message: String(e) }; }
  // JSON.parse("null") returns null, and a bare string or array is equally
  // possible if the store shape changes. Check before dereferencing, or the
  // throw escapes as an opaque tool error instead of a contract error.
  if (outer === null || typeof outer !== 'object' || Array.isArray(outer)) {
    return { error: 'persistor_parse_failed', reason: 'not_an_object', type: outer === null ? 'null' : typeof outer };
  }
  let cuid = outer.customerId;
  try { cuid = JSON.parse(cuid); } catch (e) { /* already a bare string */ }
  cuid = String(cuid == null ? '' : cuid);
  if (!/^\d{6,}$/.test(cuid)) {
    return { error: 'no_cuid_in_store', value: cuid.slice(0, 40), outerKeys: Object.keys(outer).slice(0, 25) };
  }
  return { cuid };
}
```

**Fallbacks**, in order, if that returns an error:

1. Use `list_network_requests` (filter `resourceTypes: ["fetch","xhr"]`) to find
   a `/rp-server-b2c/care/v1/B2C/customer/<id>?` request the SPA has already
   made, and take `<id>` from the URL path.
2. Read the "Account Number" shown on the `/account` dashboard. For personal
   accounts this is the same value as the `cuid`. Cross-check it against the
   `Your account number` field on the downloaded PDF in step 8.

If the value is still `"undefined"` or empty, you are almost certainly on
`/customer-logged` rather than `/account`. Go back to step 2.8.

### 4. Call the API (seed + list bills)

Run a single `evaluate_script` that calls the seed endpoint, then the list-bills endpoint. The seed endpoint returns a `uxfauthorization` token in its response header that must be passed as the `Authorization` header on subsequent calls. The token rotates on every call, so re-read it from each response.

**`evaluate_script` cannot take arbitrary arguments.** Its `args` parameter
accepts *element uids from a page snapshot only*, so passing `cuid` through it
fails with "No snapshot found for page". Inline the value into the function
body as a literal instead (substitute the real `cuid` before sending the call).

Two shape notes, both learned the hard way:

- The seed body is nested under a top-level `customer` key, and
  `financialAccount` is an **array**, so the billing arrangement id lives at
  `customer.financialAccount[0].id`. The old path
  (`seedBody.financialAccount.id`) is always `undefined`.
- `bills[i].month` is **not** a calendar month. It is a billing-period counter
  and equals `bills[i].data.billPeriod`. Deriving the month from it mislabels
  bills (the bill closing 24 Jul 2026 has `month: 5`, which a 0-indexed
  reading calls "June"). Derive the calendar month and year from
  `data.billCloseDate` instead.

Substitute the real value for `REPLACE_WITH_CUID` before sending the call. The
snippet guards against a forgotten substitution: without that check an
unreplaced placeholder is sent to the API and comes back as a generic
`seed_failed`, which reads like a Three-side outage rather than an operator
error.

```javascript
async () => {
  const cuid = 'REPLACE_WITH_CUID';
  if (/REPLACE_WITH_/.test(cuid)) return { error: 'placeholder_not_replaced', field: 'cuid' };
  if (!/^\d{6,}$/.test(cuid)) return { error: 'invalid_identifier', field: 'cuid', value: String(cuid).slice(0, 40) };
  const base = '/rp-server-b2c';
  // 1. Seed: get auth token + billing arrangement id
  const seedUrl = `${base}/care/v1/B2C/customer/${cuid}?salesChannel=selfService&initId=Digital&levelOfData=owningIndividual,financialAccount`;
  const seedRes = await fetch(seedUrl, { credentials: 'include' });
  if (seedRes.status !== 200) {
    const snippet = (await seedRes.text()).slice(0, 200);
    return { error: 'seed_failed', status: seedRes.status, snippet };
  }
  let token = seedRes.headers.get('uxfauthorization');
  if (!token) return { error: 'no_auth_header' };
  const seedBody = await seedRes.json();
  const customer = seedBody?.customer ?? seedBody;
  // `customer.id` is the cuid, NOT the billing arrangement id. On personal
  // accounts the two happen to be equal, but falling back to it blindly would
  // silently misroute calls on any account where they differ. Use it only when
  // it matches the known cuid, and say so in the result.
  let rawBillId = customer?.financialAccount?.[0]?.id ?? customer?.billingArrangement?.id;
  let billIdFallback = null;
  if (rawBillId == null && customer?.id != null && String(customer.id) === cuid) {
    rawBillId = customer.id;
    billIdFallback = 'used_customer_id_matching_cuid';
  }
  if (rawBillId == null || (typeof rawBillId !== 'string' && typeof rawBillId !== 'number')) {
    return { error: 'seed_shape_changed', field: 'billId', bodyKeys: Object.keys(seedBody || {}), customerKeys: Object.keys(customer || {}) };
  }
  const billId = String(rawBillId);
  if (!/^\d{6,}$/.test(billId)) {
    return { error: 'invalid_identifier', field: 'billId', value: billId.slice(0, 40) };
  }

  // 2. List bills
  const listUrl = `${base}/ebill/v1/customer/${cuid}/billing-arrangement/${billId}/bill?salesChannel=selfService`;
  const listRes = await fetch(listUrl, {
    credentials: 'include',
    headers: { authorization: token },
  });
  if (listRes.status !== 200) {
    const snippet = (await listRes.text()).slice(0, 200);
    return { error: 'list_failed', status: listRes.status, snippet };
  }
  token = listRes.headers.get('uxfauthorization') || token;
  const listBody = await listRes.json();
  if (!Array.isArray(listBody?.bills)) {
    return { error: 'list_shape_changed', bodyKeys: Object.keys(listBody || {}) };
  }

  // Store rotating token on window so the next evaluate_script call can read it.
  window.__threeAuth = token;
  window.__threeBillId = billId;

  // Normalise the bills list. Ignore `month`/`year` on the entry: `month` is a
  // billing-period counter, not a calendar month. The calendar month a user
  // means by "my July bill" is the month the bill was issued, i.e.
  // `data.billCloseDate` (the period it covers ends the day before).
  // Validate every entry: a missing billNumber or close date would later
  // produce `/bill/undefined/pdf` and silently fail. Surface a contract error.
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const bills = [];
  for (let i = 0; i < listBody.bills.length; i++) {
    const b = listBody.bills[i];
    // Digits only. billNumber is interpolated into a URL path in step 5, so a
    // value containing a quote or `/` would break out of the path segment.
    if (typeof b?.data?.billNumber !== 'string' || !/^\d+$/.test(b.data.billNumber)) {
      return { error: 'bill_entry_shape_changed', index: i, field: 'billNumber', value: String(b?.data?.billNumber).slice(0, 40), dataKeys: Object.keys(b?.data || {}) };
    }
    const closeMs = Date.parse(b?.data?.billCloseDate);
    if (!Number.isFinite(closeMs)) {
      return { error: 'bill_entry_shape_changed', index: i, field: 'billCloseDate', value: String(b?.data?.billCloseDate).slice(0, 40) };
    }
    const close = new Date(closeMs);
    const year = close.getUTCFullYear();
    if (year < 2000 || year > 2100) {
      return { error: 'bill_entry_shape_changed', index: i, field: 'billCloseDate_year', value: year };
    }
    bills.push({
      month: months[close.getUTCMonth()],
      monthIndex: close.getUTCMonth(),
      year,
      billNumber: b.data.billNumber,
      billAmount: b.data.billAmount,
      billCloseDate: b.data.billCloseDate,
      billStartDate: b.data.billStartDate,
      billEndDate: b.data.billEndDate,
      billPeriod: b.data.billPeriod,
    });
  }
  bills.sort((x, y) => Date.parse(y.billCloseDate) - Date.parse(x.billCloseDate));
  return { billId, bills };
}
```

Map the user's requested month and year to a `billNumber`:

- If the user asked for "latest", take `bills[0]` (the list is sorted newest-first by close date).
- If the user asked for a named month/year, find the entry whose `month`/`year` match.
- If no match, list the available `{month, year}` entries from the result and ask the user to pick one. Do not proceed.

`billAmount` is a **number** (e.g. `33.08`), not a string. Format it to two
decimal places for the filename in step 6.

Sanity check before downloading: the chosen bill's `billEndDate` should be the
23rd of the requested month and `billCloseDate` the 24th. If the month you
matched has a period ending in a different month, re-read the mapping notes
above before proceeding.

### 5. Download the PDF

The PDF endpoint requires the rotating `authorization` header. Re-read
it from `window.__threeAuth` (it was just updated by the list call).
Fetch the PDF, base64-encode the response body, and write the encoded
string straight to a file using `evaluate_script`'s `filePath` parameter.
Then have Bash decode it.

Three constraints on `evaluate_script` here, all of which bite:

1. **No arbitrary `args`** (as in step 4). Inline `cuid`, `billId`, and
   `billNumber` as literals in the function body.
2. **`filePath` is sandboxed to the workspace roots.** A path under `/tmp`
   is rejected with "is not within any of the configured workspace roots".
   Write to a dot-file inside the current project directory and delete it
   after decoding.
3. **Substitute values safely.** Emit each identifier with `JSON.stringify`
   rather than pasting it between single quotes, so a stray quote can never
   terminate the literal early. Combined with the digit-only guards in the
   snippet below, that closes the injection path into the URL.
4. **The written file is JSON, and the extension is normalised to `.json`.**
   Asking for `.three_bill_b64.tmp` produces `.three_bill_b64.json`, and the
   contents are the *JSON-quoted* string (wrapped in `"`), not raw base64.
   Strip the quotes before decoding, and read back the `.json` path that the
   tool reports rather than the one you requested.

Call `evaluate_script` with `filePath: "<PROJECT_DIR>/.three_bill_b64.tmp"` and this function:

```javascript
async () => {
  const cuid = 'REPLACE_WITH_CUID';
  const billId = 'REPLACE_WITH_BILL_ID';
  const billNumber = 'REPLACE_WITH_BILL_NUMBER';
  // Guard the substitution and the format before building a URL. All three are
  // digit-only; anything else either means a missed replacement or a value that
  // could escape its path segment.
  for (const [field, value] of [['cuid', cuid], ['billId', billId], ['billNumber', billNumber]]) {
    if (/REPLACE_WITH_/.test(value)) return `ERROR:placeholder_not_replaced:${field}`;
    if (!/^\d+$/.test(value)) return `ERROR:invalid_identifier:${field}`;
  }
  const token = window.__threeAuth;
  if (!token) return 'ERROR:no_token';
  const url = `/rp-server-b2c/care/v1/customer/${cuid}/billing-arrangement/${billId}/bill/${billNumber}/pdf?salesChannel=selfService`;
  const res = await fetch(url, {
    credentials: 'include',
    headers: { authorization: token },
  });
  if (res.status !== 200) {
    return `ERROR:pdf_status:${res.status}`;
  }
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.startsWith('application/pdf')) {
    return `ERROR:pdf_content_type:${ctype}`;
  }
  window.__threeAuth = res.headers.get('uxfauthorization') || token;
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Base64 in chunks to avoid stack overflow on large strings.
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
```

If the returned content starts with `ERROR:`, go to step 7 (Diagnostic capture). Otherwise decode, stripping the JSON quoting:

```bash
# `tr -d '"'` removes the JSON string quotes; base64 has no `"` in its alphabet,
# so this is safe. `base64 -d` is GNU/coreutils; macOS BSD base64 historically
# used -D. Try both.
tr -d '"' < "<PROJECT_DIR>/.three_bill_b64.json" \
  | { base64 -d 2>/dev/null || base64 -D; } > /tmp/three_bill_temp.pdf
rm -f "<PROJECT_DIR>/.three_bill_b64.json"
test -s /tmp/three_bill_temp.pdf
# Sanity-check size: a Three bill is typically 0.5-2 MB. Fewer than 100 KB is suspicious.
[ "$(stat -f%z /tmp/three_bill_temp.pdf 2>/dev/null || stat -c%s /tmp/three_bill_temp.pdf)" -ge 100000 ]
```

### 6. Rename and move the file

1. Construct the filename from step 4's metadata: `Three_UK_Bill_<Month>_<Year>_GBP<Amount>.pdf`
   - Example: `Three_UK_Bill_March_2026_GBP45.99.pdf`
   - If the amount could not be determined, omit it: `Three_UK_Bill_March_2026.pdf`
2. Move the file:

   ```bash
   mkdir -p "<SAVE_LOCATION>"
   mv /tmp/three_bill_temp.pdf "<SAVE_LOCATION>/Three_UK_Bill_<Month>_<Year>_GBP<Amount>.pdf"
   ```

3. Verify the file exists and is non-zero:

   ```bash
   test -s "<SAVE_LOCATION>/Three_UK_Bill_<Month>_<Year>_GBP<Amount>.pdf"
   ```

### 7. Diagnostic capture on failure

If any contract assertion in step 4 or 5 returned an `error:` shape (or `ERROR:...` string), do this before bailing:

1. Stamp a timestamp: `TS=$(date +%s)`.
2. Take a screenshot to `/tmp/three-skill-diag-${TS}.png`.
3. Use `list_network_requests` (filter `resourceTypes: ["fetch","xhr"]`),
   redact sensitive fields, and dump the sanitised result to
   `<PROJECT_DIR>/.three-skill-diag-${TS}.json` via `evaluate_script`'s
   `filePath` (return the filtered list as JSON-stringified text). It must be
   a workspace-root path, not `/tmp`: `filePath` is sandboxed (see step 5).
   Redaction rules:
   - Replace any `authorization`, `uxfauthorization`, `cookie`, and
     `set-cookie` header values with the literal string `"<redacted>"`.
   - Replace the numeric customer ID segment in any `/customer/<id>` URL
     path with `<cuid>`.
   - Drop request/response bodies (URLs + status codes + sanitised
     headers are enough for triage, raw bodies often contain PII).
4. Report both paths to the user along with the specific error code (e.g. `seed_failed`, `list_shape_changed`, `pdf_content_type:text/html`).
5. Point the user at `references/three-api-endpoints.md`. That snapshot may be out of date and need to be regenerated against the live SPA.

### 8. Verify the PDF

1. Use the Read tool to view the downloaded PDF (pages "1-3"). If the Read tool cannot render the PDF, fall back to `pdftotext <file> -` via Bash.
2. Check:
   - **Month match**: The PDF shows `Bill date 24 <Mon> <YY>` and
     `Your bill period Up to 23 <Mon> <YY>` for the requested month. This is
     the authoritative check that the `month` field was mapped correctly
     (see step 4). Confirm it rather than trusting the API label.
   - **Amount visible**: `Total charges after VAT` matches the `billAmount`
     used in the filename.
   - **Account match**: `Your account number` equals the `cuid` from step 3.
   - **Valid bill indicators**: Hutchison 3G UK Ltd, a VAT reg. no., a due date.
3. Report a summary:
   - File saved to: `<full path>`
   - Billing period: `<month/year>`
   - Amount: `<amount>`
   - Verification: passed or failed (with details)

If verification fails, warn the user with specifics but keep the file.

## Error handling

| Scenario | Action |
| -------- | ------ |
| MCP Chrome won't start (stale lock) | Clean up `~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock` per Prerequisites |
| Not logged in | Navigate to login page, ask user to log in, wait with 120s timeout |
| Cookie banner blocking | Click accept/dismiss, continue |
| `persistor_missing` / `no_cuid_in_store` / cuid reads as `"undefined"` | You are on `/customer-logged`, not `/account`. Load the dashboard (step 2.8), then retry; else use the step 3 fallbacks |
| `session_not_authenticated` / `auth_check_failed` / `auth_check_unparseable` | Auth0 logged in but My3 did not, or the check response was malformed. Ask the user to log in again; do not proceed. Only `isAnonymous === false` counts as authenticated |
| `placeholder_not_replaced:<field>` | A `REPLACE_WITH_*` literal was left in the snippet. Substitute the real value and re-run; this is an operator error, not an API failure |
| `invalid_identifier:<field>` | An identifier is not digit-only. Do not build a URL from it. Re-resolve it from step 3 or 4 |
| Killing MCP Chrome mid-login | Drops the My3 session while leaving Auth0 cookies. Re-login before retrying |
| Seed endpoint 401/403 | Session expired mid-run; ask user to re-login, retry once |
| Seed endpoint 404 or 5xx | "Three API may have moved". Run step 7 (diagnostic capture), point at `references/three-api-endpoints.md` |
| `uxfauthorization` header missing | Same as above |
| List response shape changed (`bills` not an array) | Surface `bodyKeys` from the assertion, run diagnostic capture |
| Requested month not in list | List available months from the API result, ask user to pick one |
| PDF content-type not `application/pdf` | Surface the actual content-type (often `text/html` for auth redirects); run diagnostic capture |
| Downloaded file empty or under 100 KB | Warn user, suggest retrying; keep the artefact for inspection |
| PDF verification mismatch (month/amount) | Warn user with specifics, keep the file |
| Multiple accounts on the session | The cookie/network fallback may return more than one customer ID; ask the user which to use |
