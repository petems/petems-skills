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
6. Never enter credentials on behalf of the user.

### 3. Navigate to bills page

Navigate directly to `https://account.hyperoptic.com/bills-and-payments` (sidebar nav links may be blocked by overlays, so always use direct URL navigation).

Take a snapshot. The page shows:

- An **account summary** section with the current invoice amount and dates
- A **year selector** dropdown (defaults to current year)
- A list of **month names** (January through December) as clickable text

Note the current invoice amount from the account summary (e.g. "£53.00" next to "Current invoice"). This will be used for the filename of the latest bill.

### 4. Select the target bill

**Page structure**: The bills page lists all 12 months. Clicking a month name opens a dialog with the PDF for that month's bill. Months without a bill may show an empty dialog or no response.

1. If the user wants a bill from a **different year**, change the year selector first.
2. **Identify the target month** in the snapshot and click its text element.
3. A dialog will open with the title "Your bill - (date)" and an embedded PDF viewer.
4. Take a snapshot to confirm the dialog opened. From the dialog, note:
   - The **bill date** from the dialog title (e.g. "Your bill - 9 Mar 2026")
   - The **blob URL** from the iframe's `url` attribute (e.g. `blob:https://account.hyperoptic.com/<uuid>`)
   - The **invoice number** from the dialog description (e.g. "Invoice-74654979")

### 5. Download the PDF

The PDF is rendered inside the dialog via a `blob:` URL. Use `evaluate_script` to trigger a browser download from this blob URL.

1. Use `evaluate_script` to create a temporary anchor element that downloads the blob:

   ```javascript
   async () => {
     const blobUrl = '<BLOB_URL_FROM_SNAPSHOT>';
     const a = document.createElement('a');
     a.href = blobUrl;
     a.download = '<FILENAME>.pdf';
     document.body.appendChild(a);
     a.click();
     document.body.removeChild(a);
     return { triggered: true };
   }
   ```

2. Poll for up to 30 seconds to verify the file exists in `~/Downloads/<FILENAME>.pdf` using Bash. A loop with a short sleep can be used to check for the file.

**Why this approach?** The `get_network_request` tool with `responseFilePath` often writes 0-byte files for PDF responses that have already been consumed by Chrome's PDF viewer. The blob URL download is reliable because the blob remains in memory.

**Fallback**: If the blob URL download fails:

1. Use `list_network_requests` with `resourceTypes: ["fetch", "xhr", "document", "other"]` to find the billing API request
   (URL pattern: `/billing/INVOICE_NUMBER`).
2. Use `get_network_request` with an **absolute** `responseFilePath`.
3. Verify the file is non-zero before proceeding.

### 6. Rename and move the file

1. Construct the filename: `Hyperoptic_Bill_<Month>_<Year>_GBP<Amount>.pdf`
   - Example: `Hyperoptic_Bill_March_2026_GBP53.00.pdf`
   - If the amount is unknown, omit it: `Hyperoptic_Bill_March_2026.pdf`
2. Move from `~/Downloads/` to the save location:

   ```bash
   mkdir -p "<SAVE_LOCATION>"
   mv ~/Downloads/<FILENAME>.pdf "<SAVE_LOCATION>/Hyperoptic_Bill_<Month>_<Year>_GBP<Amount>.pdf"
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

1. Close the bill dialog by clicking the "Close" button.
2. If the user requested multiple months, repeat from Step 4 for the next month.

## Error handling

| Scenario | Action |
| -------- | ------ |
| MCP Chrome won't start (stale lock) | Check `~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock`, kill orphaned process |
| Not logged in | Ask user to log in, wait with 120s timeout |
| Cookie banner blocking | Click accept/dismiss button |
| Sidebar nav not clickable | Navigate directly to `/bills-and-payments` URL |
| Target month not found | List available months, ask user to pick one |
| Year not available | Check year selector options, inform user of available range |
| Downloaded file 0 bytes | Switch to blob URL download method |
| Blob URL download fails | Fall back to network request interception |
| PDF verification mismatch | Warn user with details, keep the file |
| Multiple accounts | List accounts, ask user which to use |
| Page layout unexpected | Take a screenshot, describe what is visible, ask for guidance |
