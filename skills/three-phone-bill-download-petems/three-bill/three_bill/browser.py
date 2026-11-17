"""One Patchright Chromium on one dedicated profile, and the rules for closing it.

Ported from ramp-mcp-server's ``core/browser.py`` and ``drivers/browser.py``,
cut down for a one-shot CLI: no singleton, no idle timer, no relaunch. What is
kept is the part that protects the profile:

* the profile lease is taken before launch and released only once
  :meth:`BrowserManager.close` *confirms* Chromium exited;
* every teardown step is bounded, so a wedged Chromium cannot hang the CLI;
* launch and teardown are guarded with ``BaseException`` handlers, so Ctrl-C
  during startup still tears Chromium down, and a cancel during teardown is
  held back until the close result is known.

Session persistence is the persistent context's job: cookies, localStorage,
sessionStorage-backed state and IndexedDB live in ``user_data_dir``. There is
no "save the session" step.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Coroutine
from contextlib import asynccontextmanager
import logging
from pathlib import Path
from typing import Any

from three_bill.errors import (
    ApiError,
    NotLoggedInError,
    ProfileBusyError,
    ShutdownUnconfirmedError,
)
from three_bill.lease import ProfileLease, chromium_owner_pid, secure_mkdir

logger = logging.getLogger(__name__)

CLEANUP_TIMEOUT_SECONDS = 10.0
DEFAULT_VIEWPORT = {"width": 1280, "height": 900}


async def await_deferring_cancels(
    coro: Coroutine[Any, Any, bool],
) -> tuple[bool, bool]:
    """Run *coro* to completion. Returns ``(result, was_cancelled)``.

    A bare ``shield`` re-raises on the next cancel and throws the result away.
    Here the result decides whether the profile may be released, so it must
    survive; the caller re-raises the cancel once it has acted on it.
    """
    task = asyncio.ensure_future(coro)
    cancelled = False
    while True:
        try:
            return await asyncio.shield(task), cancelled
        except asyncio.CancelledError:
            if task.done():
                if task.cancelled():
                    return False, True
                return task.result(), True
            cancelled = True


class BrowserManager:
    """Async wrapper around a Patchright persistent context."""

    def __init__(
        self,
        user_data_dir: Path,
        *,
        headless: bool = False,
        executable_path: str | None = None,
        viewport: dict[str, int] | None = None,
    ) -> None:
        self.user_data_dir = Path(user_data_dir).expanduser()
        self.headless = headless
        self.executable_path = executable_path
        self.viewport = viewport or DEFAULT_VIEWPORT
        self._playwright: Any = None
        self._context: Any = None
        self._page: Any = None
        # Set once any close fails to prove Chromium exited. From then on
        # close() keeps answering False, so a caller can never be told the
        # profile is free on the strength of a later no-op close.
        self._stranded = False

    async def start(self) -> None:
        from patchright.async_api import async_playwright

        if self._context is not None:
            raise RuntimeError("Browser already started")
        try:
            self._playwright = await async_playwright().start()
            secure_mkdir(self.user_data_dir)
            options: dict[str, Any] = {
                "headless": self.headless,
                "viewport": self.viewport,
                "locale": "en-US",
            }
            if self.executable_path:
                options["executable_path"] = self.executable_path
            self._context = await self._playwright.chromium.launch_persistent_context(
                str(self.user_data_dir), **options
            )
            pages = self._context.pages
            self._page = pages[0] if pages else await self._context.new_page()
            logger.info("Browser launched (headless=%s)", self.headless)
        except BaseException as exc:
            # Chromium may already be running; a cancelled launch must not leave
            # it holding the profile.
            confirmed, _ = await await_deferring_cancels(self.close())
            if not confirmed:
                raise ShutdownUnconfirmedError(
                    "The browser failed to start and did not shut down cleanly."
                ) from exc
            if isinstance(exc, Exception) and not isinstance(exc, ApiError):
                raise ApiError(f"Failed to start the browser: {exc}") from exc
            raise

    async def close(self) -> bool:
        """Close everything; return True only if shutdown was confirmed."""
        context, playwright = self._context, self._playwright
        self._context = self._page = self._playwright = None
        if context is None and playwright is None:
            return not self._stranded

        confirmed = True
        for label, awaitable in (
            ("browser context", context.close() if context else None),
            ("playwright", playwright.stop() if playwright else None),
        ):
            if awaitable is None:
                continue
            try:
                await asyncio.wait_for(awaitable, timeout=CLEANUP_TIMEOUT_SECONDS)
            except TimeoutError:
                confirmed = False
                logger.error("Timed out closing %s", label)
            except Exception as exc:
                confirmed = False
                logger.error("Error closing %s: %s", label, type(exc).__name__)
        if not confirmed:
            self._stranded = True
        logger.info("Browser closed (confirmed=%s)", confirmed)
        return confirmed

    @property
    def context(self) -> Any:
        if self._context is None:
            raise RuntimeError("Browser not started")
        return self._context

    @property
    def page(self) -> Any:
        """The page, checked for liveness before every use."""
        if self._page is None:
            raise RuntimeError("Browser not started")
        if self._page.is_closed():
            raise ApiError(
                "The browser window was closed while three-bill was using it.",
                code="browser_closed",
            )
        return self._page


def profile_has_data(profile_dir: Path) -> bool:
    return profile_dir.is_dir() and any(profile_dir.iterdir())


BrowserFactory = Callable[..., BrowserManager]


@asynccontextmanager
async def open_profile(
    profile_dir: Path,
    *,
    headless: bool,
    executable_path: str | None = None,
    require_existing: bool = True,
    factory: BrowserFactory = BrowserManager,
) -> AsyncIterator[BrowserManager]:
    """Hold the profile lease for the browser's whole life.

    The lease is released only on a confirmed close. An unconfirmed close keeps
    it until this process exits, and raises :class:`ShutdownUnconfirmedError`
    unless another error is already on its way out.
    """
    profile_dir = Path(profile_dir).expanduser()
    if require_existing and not profile_has_data(profile_dir):
        raise NotLoggedInError(
            f"No Three session profile at {profile_dir}. Run `three-bill login`.",
            code="no_profile",
        )

    lease = ProfileLease.for_profile(profile_dir)
    if not lease.try_acquire():
        raise ProfileBusyError(
            f"Another three-bill process is using {profile_dir}. "
            "Wait for it to finish (or close its browser window) and retry.",
            lock=str(lease.path),
        )
    owner = chromium_owner_pid(profile_dir)
    if owner is not None:
        lease.release()
        raise ProfileBusyError(
            f"A Chromium (pid {owner}) is still running on {profile_dir}, probably "
            "left over from a run whose shutdown was not confirmed. Quit it and retry.",
            code="profile_busy_stray_chromium",
            pid=owner,
        )

    browser = factory(profile_dir, headless=headless, executable_path=executable_path)
    failure: BaseException | None = None
    try:
        await browser.start()
        yield browser
    except BaseException as exc:
        failure = exc
        raise
    finally:
        confirmed, cancelled = await await_deferring_cancels(browser.close())
        if confirmed:
            lease.release()
        else:
            # Deliberately stranded: Chromium may still be writing the profile.
            # The kernel drops the flock when this process exits.
            logger.warning(
                "Browser shutdown was not confirmed; keeping the profile lock "
                "until this process exits."
            )
        if cancelled and failure is None:
            raise asyncio.CancelledError
        if not confirmed and failure is None:
            raise ShutdownUnconfirmedError(
                "The browser did not shut down cleanly. Make sure no Chromium is "
                f"still running on {profile_dir} before the next run."
            )
