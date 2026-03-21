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

If any of the `mcp__chrome-devtools__*` tools are unavailable when this skill runs, stop and tell the user to set up the Chrome DevTools MCP server first.

## Steps

### 1. Parse user request

Determine two things from the user's message:

- **Target month**: Which bill to download. Default to the latest (most recent) bill if not specified.
- **Save location**: Where to save the PDF. Default to `~/Desktop/` if not specified.

Confirm both parameters with the user before proceeding.

### 2. Navigate to Three.co.uk account area

1. Navigate to `https://www.three.co.uk/my-account`.
2. Take a snapshot to assess the page state.

### 3. Handle cookie banners and popups

1. Check the snapshot for cookie consent overlays (look for "Accept all", "Accept cookies", or similar buttons).
2. If found, click the accept/dismiss button.
3. For any other popups or overlays, try pressing Escape to dismiss them.

### 4. Handle login

1. Take a snapshot and check for login indicators (account name visible, billing section, navigation showing "My Account" as active).
2. If already logged in, proceed to Step 5.
3. If not logged in (login form visible, or page redirected to a sign-in URL):
   - Navigate to the Three.co.uk login page if not already there.
   - Tell the user: "Please log in to your Three account in the Chrome browser window. I will wait for you to complete login."
   - Use `wait_for` with a generous timeout (120000ms) to detect login completion. Look for account-area text such as "My account", "Bills", "Your balance", or the appearance of account-specific content.
   - Once login is detected, take a fresh snapshot and continue.
4. Do NOT enter credentials on behalf of the user. Never pass credentials through the skill.

### 5. Navigate to bills section

1. From the account page snapshot, look for a link containing "Bills", "Billing", "View bills", or "My bills".
2. Click through to the bills listing page.
3. Wait for the bills list to load (use `wait_for` looking for bill-related text like a month name or "bill").
4. Take a snapshot to see available bills.

### 6. Select the target bill

1. From the snapshot, identify the list of available bills (typically shown by month and year).
2. If the user requested a specific month, find that month in the list.
   - If the target month is not found, list the available months and ask the user to pick one.
3. If the user requested "latest" (the default), select the first or most recent bill.
4. Extract the bill date (month and year) and amount from the page text. These will be used for the filename.
5. Click on the bill to open its detail page (or the "View bill" / "Download" link).

### 7. Download the PDF

1. Take a snapshot of the bill detail page to find the "Download PDF", "Download bill", or similar button/link.
2. Click the download link/button.
3. Use `list_network_requests` with `resourceTypes: ["fetch", "xhr", "document", "other"]` to find the PDF request. Look for a request URL containing `.pdf`, `bill`, `invoice`, or with a content-type of `application/pdf`.
4. Use `get_network_request` with `responseFilePath: "/tmp/three_bill_temp.pdf"` to save the PDF to disk.
5. If no PDF network request is detected:
   - Wait 3 seconds and re-check `list_network_requests`. Retry up to 3 times.
   - **Fallback**: Use `evaluate_script` to search the page DOM for `<a>` tags with `href` containing `.pdf` or a `download` attribute. Extract the full URL and use Bash with `curl` to download it.

### 8. Rename and move the file

1. Construct a descriptive filename using the bill date and amount from Step 6:
   - Format: `Three_UK_Bill_<Month>_<Year>_GBP<Amount>.pdf`
   - Example: `Three_UK_Bill_March_2026_GBP45.99.pdf`
   - If the amount could not be determined, omit it: `Three_UK_Bill_March_2026.pdf`
2. Use Bash to move the file from the temp path to the final destination:

   ```bash
   mv /tmp/three_bill_temp.pdf ~/Desktop/Three_UK_Bill_March_2026_GBP45.99.pdf
   ```

3. Confirm the file exists and has a non-zero size using `ls -la`.

### 9. Verify the PDF

1. Use the Read tool to view the downloaded PDF (pages "1-3").
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
| PDF request not captured | Wait and retry up to 3 times, then fall back to evaluate_script and curl |
| Downloaded file empty or corrupt | Warn user, suggest trying the download again manually |
| PDF verification mismatch | Warn user with details but keep the file |
| Multiple accounts shown | List accounts, ask user which one to use |
| Page layout unexpected | Take a screenshot, report what is visible, ask user for guidance |
