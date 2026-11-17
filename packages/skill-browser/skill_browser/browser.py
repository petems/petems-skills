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
import json
import logging
from pathlib import Path
from typing import Any

from skill_browser.errors import (
    ApiError,
    NotLoggedInError,
    ProfileBusyError,
    ShutdownUnconfirmedError,
)
from skill_browser.files import write_private_atomic
from skill_browser.lease import ProfileLease, chromium_owner_pid, secure_mkdir

logger = logging.getLogger(__name__)

CLEANUP_TIMEOUT_SECONDS = 10.0
COOKIE_SAVE_TIMEOUT_SECONDS = 20.0
QUIESCE_IDLE_TIMEOUT_MS = 8_000
QUIESCE_BLANK_TIMEOUT_MS = 5_000
SESSION_COOKIE_FILE = "session-cookies.json"
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
        locale: str = "en-GB",
        keep_session_cookies: bool = False,
    ) -> None:
        self.user_data_dir = Path(user_data_dir).expanduser()
        # Chromium drops cookies with no expiry when it exits, persistent
        # profile or not. Sites whose login lives in such cookies (Keycloak's
        # identity cookie, for one) would need a fresh login every run, so a
        # tool can opt in to carrying them across runs in a 0600 file.
        self.keep_session_cookies = keep_session_cookies
        self.headless = headless
        self.executable_path = executable_path
        self.viewport = viewport or DEFAULT_VIEWPORT
        self.locale = locale
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
                "locale": self.locale,
                "accept_downloads": True,
            }
            if self.executable_path:
                options["executable_path"] = self.executable_path
            self._context = await self._playwright.chromium.launch_persistent_context(
                str(self.user_data_dir), **options
            )
            if self.keep_session_cookies:
                await self._restore_session_cookies()
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

    @property
    def session_cookie_path(self) -> Path:
        return self.user_data_dir.parent / SESSION_COOKIE_FILE

    async def _restore_session_cookies(self) -> None:
        path = self.session_cookie_path
        try:
            cookies = json.loads(path.read_text())
        except FileNotFoundError:
            return
        except (OSError, ValueError):
            logger.warning("Ignoring unreadable %s", path.name)
            return
        if not isinstance(cookies, list):
            return
        valid = [
            c
            for c in cookies
            if isinstance(c, dict)
            and all(
                isinstance(c.get(k), str) for k in ("name", "value", "domain", "path")
            )
        ]
        if valid:
            await self._context.add_cookies(valid)
            logger.info("Restored %d session cookies", len(valid))

    async def _quiesce(self, context: Any) -> None:
        """Let in-flight requests land, then stop pages from starting new ones.

        Sites that rotate a session token on every API call (Three's
        WIRELESS_SECURITY_TOKEN) would otherwise have a background call rotate
        it after the snapshot, leaving a dead token saved (seen live,
        2026-11-17). Best effort: each step is bounded and may fail.
        """
        for page in list(context.pages):
            try:
                await page.wait_for_load_state(
                    "networkidle", timeout=QUIESCE_IDLE_TIMEOUT_MS
                )
            except Exception:
                pass
            try:
                await page.goto("about:blank", timeout=QUIESCE_BLANK_TIMEOUT_MS)
            except Exception:
                pass

    async def _save_session_cookies(self, context: Any) -> None:
        """Write the context's no-expiry cookies (names and values) to a 0600 file."""
        await self._quiesce(context)
        cookies = await context.cookies()
        session = [c for c in cookies if c.get("expires", -1) in (-1, None)]
        write_private_atomic(
            self.session_cookie_path,
            json.dumps(session).encode(),
            overwrite=True,
        )

    async def close(self) -> bool:
        """Close everything; return True only if shutdown was confirmed."""
        context, playwright = self._context, self._playwright
        self._context = self._page = self._playwright = None
        if context is None and playwright is None:
            return not self._stranded

        if context is not None and self.keep_session_cookies:
            try:
                await asyncio.wait_for(
                    self._save_session_cookies(context),
                    timeout=COOKIE_SAVE_TIMEOUT_SECONDS,
                )
            except Exception as exc:  # never blocks shutdown
                logger.warning("Could not save session cookies: %s", type(exc).__name__)

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
    def playwright(self) -> Any:
        """The running Patchright driver, e.g. to launch a throwaway headless browser."""
        if self._playwright is None:
            raise RuntimeError("Browser not started")
        return self._playwright

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
                "The browser window was closed mid-run.",
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
    tool: str,
    headless: bool,
    executable_path: str | None = None,
    require_existing: bool = True,
    factory: BrowserFactory = BrowserManager,
    **browser_options: Any,
) -> AsyncIterator[BrowserManager]:
    """Hold the profile lease for the browser's whole life.

    The lease is released only on a confirmed close. An unconfirmed close keeps
    it until this process exits, and raises :class:`ShutdownUnconfirmedError`
    unless another error is already on its way out.
    """
    profile_dir = Path(profile_dir).expanduser()
    if require_existing and not profile_has_data(profile_dir):
        raise NotLoggedInError(
            f"No session profile at {profile_dir}. Run `{tool} login`.",
            code="no_profile",
        )

    lease = ProfileLease.for_profile(profile_dir)
    if not lease.try_acquire():
        raise ProfileBusyError(
            f"Another {tool} process is using {profile_dir}. "
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

    browser = factory(
        profile_dir,
        headless=headless,
        executable_path=executable_path,
        **browser_options,
    )
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
