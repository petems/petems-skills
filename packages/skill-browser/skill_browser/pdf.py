"""Checking a PDF response, and printing captured HTML to PDF."""

from __future__ import annotations

import logging
from typing import Any

from skill_browser.errors import ApiError, PdfInvalidError

logger = logging.getLogger(__name__)

DEFAULT_MAX_BYTES = 20 * 1024 * 1024
RENDER_TIMEOUT_MS = 30_000


def validate_pdf(
    status: int,
    content_type: str,
    body: bytes | None,
    *,
    min_bytes: int,
    max_bytes: int = DEFAULT_MAX_BYTES,
    size: int | None = None,
    check_content_type: bool = True,
) -> None:
    """Raise :class:`PdfInvalidError` unless this is a plausible document."""
    if status != 200:
        raise PdfInvalidError(
            f"PDF request returned HTTP {status}", code=f"pdf_status:{status}"
        )
    media = (content_type or "").split(";")[0].strip().lower()
    if check_content_type and not media.startswith("application/pdf"):
        # text/html here is almost always an auth redirect.
        raise PdfInvalidError(
            f"PDF request returned {media or 'no content type'}",
            code=f"pdf_content_type:{media or 'none'}",
        )
    length = len(body) if body is not None else (size or 0)
    if length > max_bytes:
        raise PdfInvalidError(
            f"PDF is {length} bytes, over the cap", code="pdf_too_large", bytes=length
        )
    if body is None or not body.startswith(b"%PDF-"):
        raise PdfInvalidError("Response does not start with %PDF-", code="pdf_not_pdf")
    if length < min_bytes:
        raise PdfInvalidError(
            f"PDF is only {length} bytes, below the {min_bytes}-byte floor",
            code="pdf_too_small",
            bytes=length,
        )


async def html_to_pdf(
    browser: Any,
    html: str,
    *,
    margin: str = "12mm",
    paper: str = "A4",
    timeout_ms: int = RENDER_TIMEOUT_MS,
) -> bytes:
    """Print *html* to PDF in a throwaway headless Chromium.

    ``page.pdf()`` only works headless, and the profile's browser is usually
    headed, so this launches a second, profile-less browser from the same
    Patchright driver. It never sees the profile's cookies. Callers should
    strip scripts from *html* first and add a CSP that blocks script and
    ``connect-src``, so the offline copy cannot run code or phone home.

    Launch, load and print failures (a stylesheet that never finishes loading,
    say) raise :class:`ApiError` ``pdf_render_failed`` (exit 9) naming only the
    exception type, never the HTML or a URL.
    """
    options: dict[str, Any] = {"headless": True}
    if getattr(browser, "executable_path", None):
        options["executable_path"] = browser.executable_path
    try:
        scratch = await browser.playwright.chromium.launch(**options)
    except Exception as exc:
        raise ApiError(
            f"Could not start the PDF render browser ({type(exc).__name__})",
            code="pdf_render_failed",
            stage="launch",
        ) from exc
    try:
        page = await scratch.new_page()
        await page.set_content(html, wait_until="load", timeout=timeout_ms)
        return await page.pdf(
            format=paper,
            print_background=True,
            margin={"top": margin, "bottom": margin, "left": margin, "right": margin},
        )
    except Exception as exc:
        raise ApiError(
            f"Printing the captured page to PDF failed ({type(exc).__name__})",
            code="pdf_render_failed",
            stage="render",
        ) from exc
    finally:
        try:
            await scratch.close()
        except Exception:
            logger.debug("Closing the render browser failed", exc_info=True)
