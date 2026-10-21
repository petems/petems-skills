---
name: hyperoptic-bill-download-petems
description: >-
  Download and verify Hyperoptic broadband bill PDFs via Chrome DevTools
  browser automation. Use this skill whenever the user mentions Hyperoptic
  bills, broadband invoices, internet bill downloads, or wants to
  grab/fetch/save a bill from their Hyperoptic account. Also trigger when
  the user asks to download bills for expense tracking, filing, or
  record-keeping from Hyperoptic.
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
  - mcp__chrome-devtools__hover
  - mcp__chrome-devtools__new_page
  - mcp__chrome-devtools__list_pages
  - mcp__chrome-devtools__select_page
  - Bash
  - Read
---

# Download a Hyperoptic bill PDF

This skill automates downloading bill PDFs from the Hyperoptic customer portal using Chrome DevTools MCP for browser automation. It navigates the site, locates the target bill, downloads the PDF, renames it descriptively, and verifies the contents.

## Prerequisites

- **Chrome DevTools MCP server** configured and running (`npx @anthropic-ai/chrome-devtools-mcp@latest`)
- The MCP server registered in Claude Code settings under `mcpServers`
- If MCP tools are unavailable, stop and ask the user to set up Chrome DevTools MCP first
- **Stale browser lock**: If a tool call fails with "The browser is already running",
  check for a stale lock file and orphaned Chrome process using these commands:

  ```bash
  # Check for stale lock
  ls -la ~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock

  # Find the PID from the symlink target (e.g. HOSTNAME-PID)
  readlink ~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock

  # If the process is an old MCP Chrome (not regular Chrome), kill it
  kill <PID>
  ```

## Steps

### 1. Parse user request

Determine:

- **Target month(s)**: Which bill(s) to download. Default to the latest if not specified. Multiple months are supported (process them one at a time).
- **Save location**: Where to save the PDF(s). Default to `~/Desktop/` if not specified.

**Billing cycle note**: Hyperoptic generates bills around the 9th of each month. If the user asks for the current month's bill and it is early in the month (before the 10th), warn them it may not be available yet and offer to download the previous month's bill instead.

Confirm parameters with the user before proceeding.

### 2. Navigate to Hyperoptic and handle login

1. Navigate to `https://account.hyperoptic.com/`. This redirects to the dashboard if logged in, or shows the Keycloak login form if not.
2. Take a snapshot to assess the page state.
3. **Cookie consent**: Look for an "Accept" button in the snapshot. If found, click it. For other popups, press Escape.
4. **Check login state**: If the snapshot shows "Dashboard", an account name, or the URL contains `/account`, the user is logged in. Proceed to Step 3.
5. **If not logged in**:
   - Tell the user: "Please log in to your Hyperoptic account in the Chrome browser window. I will wait for you to complete login."
   - Use `wait_for` with timeout 120000ms, looking for text: `["Dashboard", "Account", "My bills", "Welcome", "Bills"]`.
   - Once login is detected, take a fresh snapshot and continue.
   - If `wait_for` times out, take a snapshot anyway before giving up. The redirect back to the dashboard can be missed by `wait_for`, so the user may already be logged in.
6. Never enter credentials on behalf of the user.

### 3. Navigate to bills page

Navigate directly to `https://account.hyperoptic.com/bills-and-payments` (sidebar nav links may be blocked by overlays, so always use direct URL navigation).

Take a snapshot. The page shows:

- An **account summary** section with the current invoice amount and dates
- A **year selector** dropdown (defaults to current year)
- A list of **month names** (January through December) as clickable text

The month names are the way into each bill's own page. The amount for the filename is read from that page in Step 4, so it is correct for older bills too.

### 4. Open the target bill

**Page structure**: The bills page lists all 12 months. Clicking a month name navigates to a separate View Bill page at `https://account.hyperoptic.com/bills-and-payments/view-bill?invoiceId=<INVOICE_ID>`. Months without a bill may not respond.

1. If the user wants a bill from a **different year**, change the year selector first.
2. **Identify the target month** in the snapshot and click its text element.
3. The page navigates to View Bill. Its content loads after the navigation, so use `wait_for` with text `["Download PDF bill", "Amount due"]` before reading it.
4. From the View Bill page, note:
   - The **invoice ID** from the URL (`invoiceId=84623147`)
   - The **bill heading** (e.g. "October 2026 bill"), which gives the month and year
   - The **amount** next to "Amount due" (e.g. "£53.00")
   - The **bill date** next to "Bill date" (e.g. "9 October, 2026")
5. The page also has "View previous bill" and "View next bill" buttons, which are handy for moving between months without going back to the bills list.

### 5. Download the PDF

1. Before clicking, create a timestamp marker so the new file can be found reliably:

   ```bash
   touch /tmp/hyperoptic_marker
   ```

2. Click the **"Download PDF bill"** button. Chrome saves the file straight to `~/Downloads/` as `Invoice-<INVOICE_ID>.pdf`.
3. Poll for up to 30 seconds until the file appears and is not a partial download:

   ```bash
   for i in $(seq 1 15); do
     f=$(find ~/Downloads -maxdepth 1 -newer /tmp/hyperoptic_marker -type f ! -name '*.crdownload' | head -1)
     [ -n "$f" ] && { ls -la "$f"; exit 0; }
     sleep 2
   done
   echo "no new file"
   ```

**Fallback**: If no file appears or it is 0 bytes:

1. Use `list_network_requests` with `resourceTypes: ["fetch", "xhr", "document", "other"]` to find the billing API request
   (URL pattern: `/billing/<INVOICE_ID>`).
2. Use `get_network_request` with an **absolute** `responseFilePath`.
3. Verify the file is non-zero before proceeding.

### 6. Rename and move the file

1. Construct the filename: `Hyperoptic_Bill_<Month>_<Year>_GBP<Amount>.pdf`
   - Example: `Hyperoptic_Bill_March_2026_GBP53.00.pdf`
   - If the amount is unknown, omit it: `Hyperoptic_Bill_March_2026.pdf`
2. Move from `~/Downloads/` to the save location. Use `mv -n` so an existing bill with the same name is never overwritten:

   ```bash
   mkdir -p "<SAVE_LOCATION>"
   mv -n ~/Downloads/Invoice-<INVOICE_ID>.pdf "<SAVE_LOCATION>/Hyperoptic_Bill_<Month>_<Year>_GBP<Amount>.pdf"
   ```

3. Verify: `test -s "<SAVE_LOCATION>/Hyperoptic_Bill_<Month>_<Year>_GBP<Amount>.pdf"`

### 7. Verify the PDF

1. Use the Read tool to view the PDF (pages "1-2").
2. Verify:
   - **Month match**: The bill date on the PDF matches the requested month
   - **Amount visible**: A total amount is present (positive GBP value)
   - **Valid bill**: Hyperoptic branding, account number, and VAT/charge breakdown are present
3. Report to the user:
   - File saved to: `<full path>`
   - Billing period: `<month/year>`
   - Amount: `<amount>`
   - Verification: passed or failed (with details)

If verification fails, warn the user but keep the file.

### 8. Clean up and continue

1. If the user requested multiple months, either click "View previous bill" / "View next bill" to reach the next month, or navigate back to `/bills-and-payments` and repeat from Step 4.
2. Create a fresh `/tmp/hyperoptic_marker` before each download so the poll only picks up the new file.

## Error handling

| Scenario | Action |
| -------- | ------ |
| MCP Chrome won't start (stale lock) | Check `~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock`, kill orphaned process |
| Not logged in | Ask user to log in, wait with 120s timeout |
| Login `wait_for` times out | Take a snapshot; the user may already be on the dashboard |
| Cookie banner blocking | Click accept/dismiss button |
| Sidebar nav not clickable | Navigate directly to `/bills-and-payments` URL |
| Target month not found | List available months, ask user to pick one |
| Year not available | Check year selector options, inform user of available range |
| View Bill page shows only the header | Content still loading; `wait_for` "Download PDF bill" |
| No file in `~/Downloads` or file is 0 bytes | Fall back to network request interception |
| PDF verification mismatch | Warn user with details, keep the file |
| Multiple accounts | List accounts, ask user which to use |
| Page layout unexpected | Take a screenshot, describe what is visible, ask for guidance |
