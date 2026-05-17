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
  - mcp__chrome-devtools__get_network_request
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

### 3. Resolve the customer ID

The customer ID (`cuid`) is needed for every API call. The cleanest way to get it is from the `_tms_persistUser` cookie that Three sets after login.

Run via `evaluate_script`:

```javascript
() => {
  const raw = document.cookie.split('; ').find(c => c.startsWith('_tms_persistUser='));
  if (!raw) return { error: 'cookie_missing' };
  try {
    const decoded = decodeURIComponent(raw.split('=').slice(1).join('='));
    const parsed = JSON.parse(decoded);
    if (!parsed.cuid) return { error: 'no_cuid_in_cookie', keys: Object.keys(parsed) };
    return { cuid: String(parsed.cuid) };
  } catch (e) {
    return { error: 'cookie_parse_failed', message: String(e) };
  }
}
```

**Fallback** (cookie missing or unparseable): use `list_network_requests` to find the first `/care/v1/B2C/customer/<id>?` request the SPA has already made, and extract `<id>` from the URL path.

### 4. Call the API (seed + list bills)

Run a single `evaluate_script` that calls the seed endpoint, then the list-bills endpoint. The seed endpoint returns a `uxfauthorization` token in its response header that must be passed as the `Authorization` header on subsequent calls. The token rotates on every call, so re-read it from each response.

```javascript
async (cuid) => {
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
  const billId = seedBody?.financialAccount?.id || seedBody?.billingArrangement?.id || cuid;

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

  // Normalise the bills list. `month` is 0-indexed in the API.
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const bills = listBody.bills.map(b => ({
    month: months[b.month],
    monthIndex: b.month,
    year: b.year,
    billNumber: b?.data?.billNumber,
    billAmount: b?.data?.billAmount,
    billCloseDate: b?.data?.billCloseDate,
  }));
  return { billId, bills };
}
```

Map the user's requested month and year to a `billNumber`:

- If the user asked for "latest", pick the most recent entry (highest year, then highest `monthIndex`).
- If the user asked for a named month/year, find the matching entry.
- If no match, list the available `{month, year}` entries from the result and ask the user to pick one. Do not proceed.

Capture `billAmount` for the filename in step 6.

### 5. Download the PDF

The PDF endpoint requires the rotating `authorization` header. Re-read
it from `window.__threeAuth` (it was just updated by the list call).
Fetch the PDF, base64-encode the response body, and write the encoded
string straight to a file using `evaluate_script`'s `filePath` parameter.
Then have Bash decode it.

Call `evaluate_script` with `filePath: "/tmp/three_bill_b64.txt"` and this function (pass `cuid`, `billId`, `billNumber` as `args`):

```javascript
async (cuid, billId, billNumber) => {
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

If the returned content starts with `ERROR:`, go to step 7 (Diagnostic capture). Otherwise decode:

```bash
base64 -d /tmp/three_bill_b64.txt > /tmp/three_bill_temp.pdf
rm /tmp/three_bill_b64.txt
test -s /tmp/three_bill_temp.pdf
# Sanity-check size: a Three bill is typically 0.5–2 MB. Fewer than 100 KB is suspicious.
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
3. Use `list_network_requests` (filter `resourceTypes: ["fetch","xhr"]`) and dump the result to `/tmp/three-skill-diag-${TS}.json` via `evaluate_script`'s `filePath` (return the filtered list as JSON-stringified text).
4. Report both paths to the user along with the specific error code (e.g. `seed_failed`, `list_shape_changed`, `pdf_content_type:text/html`).
5. Point the user at `references/three-api-endpoints.md` — that snapshot may be out of date and need to be regenerated against the live SPA.

### 8. Verify the PDF

1. Use the Read tool to view the downloaded PDF (pages "1-3"). If the Read tool cannot render the PDF, fall back to `pdftotext <file> -` via Bash.
2. Check:
   - **Month match**: The billing period text matches the requested month.
   - **Amount visible**: A total or payment amount is present (positive GBP value).
   - **Valid bill indicators**: Three UK branding, an account number, VAT.
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
| `_tms_persistUser` cookie missing | Fall back to network-log inspection for `/care/v1/B2C/customer/<id>` |
| Seed endpoint 401/403 | Session expired mid-run; ask user to re-login, retry once |
| Seed endpoint 404 or 5xx | "Three API may have moved" — run step 7 (diagnostic capture), point at `references/three-api-endpoints.md` |
| `uxfauthorization` header missing | Same as above |
| List response shape changed (`bills` not an array) | Surface `bodyKeys` from the assertion, run diagnostic capture |
| Requested month not in list | List available months from the API result, ask user to pick one |
| PDF content-type not `application/pdf` | Surface the actual content-type (often `text/html` for auth redirects); run diagnostic capture |
| Downloaded file empty or under 100 KB | Warn user, suggest retrying; keep the artefact for inspection |
| PDF verification mismatch (month/amount) | Warn user with specifics, keep the file |
| Multiple accounts on the session | The cookie/network fallback may return more than one customer ID; ask the user which to use |
