---
name: three-phone-bill-download-petems
description: Download and verify a Three UK bill PDF via Chrome DevTools
license: MIT
allowed-tools:
  - mcp__chrome-devtools__navigate_page
  - mcp__chrome-devtools__take_snapshot
  - mcp__chrome-devtools__take_screenshot
  - mcp__chrome-devtools__click
  - mcp__chrome-devtools__fill
  - mcp__chrome-devtools__type_text
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

# Download a Three UK bill PDF

When the user asks to download a bill from Three.co.uk, follow these steps. This skill uses Chrome DevTools MCP to navigate the Three website, locate the bill, download the PDF, rename it with a descriptive filename, and verify its contents.

## Prerequisites

This skill requires the **Chrome DevTools MCP server** to be configured and running. The MCP server provides browser automation tools (navigate, click, fill, network interception, etc.).

- Install: `npx @anthropic-ai/chrome-devtools-mcp@latest` (or see the package's README for setup)
- The MCP server must be registered in your Claude Code settings under `mcpServers`
- Chrome (or Chromium) must be running with remote debugging enabled
- **poppler** must be installed for PDF verification (`brew install poppler` on macOS, `apt-get install poppler-utils` on Linux). This provides `pdftotext` used to verify the downloaded bill.

If any of the `mcp__chrome-devtools__*` tools are unavailable when this skill runs, stop and tell the user to set up the Chrome DevTools MCP server first.

## Steps

### 1. Parse user request

Determine two things from the user's message:

- **Target month**: Which bill to download. Default to the latest (most recent) bill if not specified.
- **Save location**: Where to save the PDF. Default to `~/Desktop/` if not specified.

**Billing cycle note**: Three UK bills are generated on the 23rd/24th of each month.
The billing period runs from the 24th of one month to the 23rd of the next.
Check today's date before proceeding.
If today is before the 24th and the user asks for the current month's bill, alert them:
"The current month's bill is not available yet.
Three generates new bills after the 23rd.
I will look for last month's bill instead."
Then default to the previous month.

Confirm both parameters with the user before proceeding.

### 2. Navigate to Three.co.uk and handle login

1. Navigate to `https://www.three.co.uk/customer-login`. This will redirect to the account dashboard if already logged in, or show the login form if not.
2. Take a snapshot to assess the page state.
3. Check the snapshot for cookie consent overlays (look for "Accept all", "Accept cookies", or similar buttons). If found, click the accept/dismiss button. For any other popups or overlays, try pressing Escape to dismiss them.
4. Check for login indicators (account name visible, "Good morning" greeting, or URL is `/account`).
5. If already logged in, proceed to Step 3.
6. If not logged in (login form visible at `auth.three.co.uk`, or email/password fields present):
   - Tell the user: "Please log in to your Three account in the Chrome browser window. I will wait for you to complete login."
   - Use `wait_for` with a generous timeout (120000ms) to detect login completion. Look for text such as "Good morning", "Dashboard", or "Account Number".
   - Once login is detected, take a fresh snapshot and continue.
7. Do NOT enter credentials on behalf of the user. Never pass credentials through the skill.

### 3. Navigate to bills page

1. Navigate directly to `https://www.three.co.uk/account/view-bill`. This takes you straight to the bill view with the latest bill pre-selected.
2. Wait for the bill to load (use `wait_for` looking for "View bill" or "Download Bill").
3. Take a snapshot to see the bill details.

### 4. Select the target bill

1. The latest bill should already be displayed. Check the snapshot for the bill month shown in the month selector (a combobox).
2. If the user requested a specific month different from what is shown, click the month dropdown and select the target month.
   - If the target month is not found, list the available months and ask the user to pick one.
3. If the user requested "latest" (the default), the current view is correct.
4. Extract the bill date (month and year) and total amount (inc VAT) from the page text. These will be used for the filename.

### 5. Download the PDF

1. Find the "Download Bill" button in the snapshot and click it.
2. Use `list_network_requests` with `resourceTypes: ["fetch", "xhr", "document", "other"]` to find the PDF request. Look for a request URL containing `/pdf` or with a content-type of `application/pdf`.
3. Use `get_network_request` with `responseFilePath: "/tmp/three_bill_temp.pdf"` to save the PDF to disk.
4. If no PDF network request is detected:
   - Wait 3 seconds and re-check `list_network_requests`. Retry up to 3 times.
   - **Fallback 1**: Use `evaluate_script` to find `<a>` tags with `.pdf` hrefs or a `download` attribute.
     Extract the URL and use `get_network_request` with `responseFilePath: "/tmp/three_bill_temp.pdf"` to save
     the PDF via the browser (which carries session cookies).
   - **Fallback 2 (last resort)**: If browser-context retrieval also fails, use Bash with `curl` to download the URL. Note that `curl` does not share the browser's session cookies, so this will fail for session-protected endpoints.

### 6. Rename and move the file

1. Construct a descriptive filename using the bill date and amount from Step 4:
   - Format: `Three_UK_Bill_<Month>_<Year>_GBP<Amount>.pdf`
   - Example: `Three_UK_Bill_March_2026_GBP45.99.pdf`
   - If the amount could not be determined, omit it: `Three_UK_Bill_March_2026.pdf`
2. Use Bash to move the file from the temp path to the user-confirmed final destination:

   ```bash
   mv /tmp/three_bill_temp.pdf "<SAVE_LOCATION>/Three_UK_Bill_<Month>_<Year>_GBP<Amount>.pdf"
   ```

3. Confirm the file exists and has a non-zero size:

   ```bash
   test -s "<SAVE_LOCATION>/Three_UK_Bill_<Month>_<Year>_GBP<Amount>.pdf"
   ```

### 7. Verify the PDF

1. Use the Read tool to view the downloaded PDF (pages "1-3"). If the Read tool cannot render the PDF, fall back to extracting text with `pdftotext <file> -` via Bash.
2. Check the following:
   - **Month match**: The billing period text on the PDF matches the requested month.
   - **Amount visible**: A total or payment amount is present and appears reasonable (a positive GBP value).
   - **Valid bill indicators**: The PDF contains Three UK branding, an account number, and standard bill elements like VAT.
3. Report a summary to the user:
   - File saved to: `<full path>`
   - Billing period: `<month/year>`
   - Amount: `<amount>`
   - Verification: passed or failed (with details if failed)

If verification fails, warn the user with specific details about what did not match, but keep the downloaded file.

## Error handling

| Scenario | Action |
| -------- | ------ |
| Not logged in | Navigate to login page, ask user to log in, wait for completion |
| Cookie banner blocking | Click accept/dismiss, continue |
| Target month not found | List available months, ask user to pick one |
| No download button found | Take a screenshot for visual inspection, ask user for guidance |
| PDF request not captured | Wait and retry up to 3 times, then fall back to evaluate_script with browser retrieval, then curl as last resort |
| Downloaded file empty or corrupt | Warn user, suggest trying the download again manually |
| PDF verification mismatch | Warn user with details but keep the file |
| Multiple accounts shown | List accounts, ask user which one to use |
| Page layout unexpected | Take a screenshot, report what is visible, ask user for guidance |
