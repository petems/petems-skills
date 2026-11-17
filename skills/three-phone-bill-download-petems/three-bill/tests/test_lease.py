"""The profile lease and the confirmed-close rule, with a fake browser."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
import socket
import subprocess
import sys
from typing import ClassVar

import pytest

from three_bill import browser as browser_mod
from three_bill.browser import BrowserManager, open_profile
from three_bill.errors import (
    NotLoggedInError,
    ProfileBusyError,
    ShutdownUnconfirmedError,
)
from three_bill.lease import ProfileLease, chromium_owner_pid

_PROBE = """
import sys
from typing import ClassVar
from pathlib import Path
from three_bill.lease import ProfileLease
lease = ProfileLease(Path(sys.argv[1]))
print("acquired" if lease.try_acquire() else "busy")
"""


def other_process_can_lock(lock_path: Path) -> bool:
    out = subprocess.run(
        [sys.executable, "-c", _PROBE, str(lock_path)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    return out == "acquired"


@pytest.fixture
def profile(tmp_path: Path) -> Path:
    path = tmp_path / "home" / "profile"
    path.mkdir(parents=True)
    (path / "Default").mkdir()
    return path


class FakeBrowser:
    """Stands in for BrowserManager; close() answers what the test says."""

    instances: ClassVar[list[FakeBrowser]] = []

    def __init__(
        self, user_data_dir, *, headless, executable_path, confirm=True, fail_start=None
    ):
        self.confirm = confirm
        self.fail_start = fail_start
        self.started = False
        self.closed = 0
        FakeBrowser.instances.append(self)

    async def start(self):
        self.started = True
        if self.fail_start:
            raise self.fail_start

    async def close(self) -> bool:
        self.closed += 1
        return self.confirm


def factory(**kwargs):
    return lambda *a, **kw: FakeBrowser(*a, **kw, **kwargs)


def test_second_process_is_busy(profile):
    lease = ProfileLease.for_profile(profile)
    assert lease.try_acquire()
    try:
        assert not other_process_can_lock(lease.path)
    finally:
        lease.release()
    assert other_process_can_lock(lease.path)
    # Never unlinked: unlinking would split contenders across inodes.
    assert lease.path.exists()


async def test_open_profile_reports_busy(profile):
    holder = ProfileLease.for_profile(profile)
    assert holder.try_acquire()
    try:
        with pytest.raises(ProfileBusyError):
            async with open_profile(profile, headless=True, factory=factory()):
                pass
    finally:
        holder.release()


async def test_confirmed_close_releases(profile):
    async with open_profile(profile, headless=True, factory=factory(confirm=True)) as b:
        assert b.started
        assert not other_process_can_lock(ProfileLease.for_profile(profile).path)
    assert other_process_can_lock(ProfileLease.for_profile(profile).path)


async def test_unconfirmed_close_keeps_the_lock(profile):
    with pytest.raises(ShutdownUnconfirmedError):
        async with open_profile(profile, headless=True, factory=factory(confirm=False)):
            pass
    # Still ours until this process exits.
    assert not other_process_can_lock(ProfileLease.for_profile(profile).path)


async def test_unconfirmed_close_does_not_mask_the_real_error(profile):
    with pytest.raises(NotLoggedInError):
        async with open_profile(profile, headless=True, factory=factory(confirm=False)):
            raise NotLoggedInError("dead session")
    assert not other_process_can_lock(ProfileLease.for_profile(profile).path)


async def test_error_inside_still_closes_and_releases(profile):
    with pytest.raises(NotLoggedInError):
        async with open_profile(profile, headless=True, factory=factory(confirm=True)):
            raise NotLoggedInError("dead session")
    assert FakeBrowser.instances[-1].closed == 1
    assert other_process_can_lock(ProfileLease.for_profile(profile).path)


async def test_cancelled_run_still_settles(profile):
    entered = asyncio.Event()

    async def run():
        async with open_profile(profile, headless=True, factory=factory(confirm=True)):
            entered.set()
            await asyncio.sleep(60)

    task = asyncio.create_task(run())
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert FakeBrowser.instances[-1].closed == 1
    assert other_process_can_lock(ProfileLease.for_profile(profile).path)


async def test_missing_profile_means_login(tmp_path):
    with pytest.raises(NotLoggedInError) as info:
        async with open_profile(tmp_path / "nope", headless=True, factory=factory()):
            pass
    assert "three-bill login" in str(info.value)


async def test_stray_chromium_is_busy(profile):
    os.symlink(f"{socket.gethostname()}-{os.getpid()}", profile / "SingletonLock")
    assert chromium_owner_pid(profile) == os.getpid()
    with pytest.raises(ProfileBusyError) as info:
        async with open_profile(profile, headless=True, factory=factory()):
            pass
    assert info.value.code == "profile_busy_stray_chromium"
    # Refused without taking the profile, and without deleting Chromium's lock.
    assert other_process_can_lock(ProfileLease.for_profile(profile).path)
    assert os.path.islink(profile / "SingletonLock")


def test_stale_or_foreign_singleton_lock_is_ignored(profile):
    os.symlink("some-other-host-1", profile / "SingletonLock")
    assert chromium_owner_pid(profile) is None


async def test_manager_close_is_bounded_and_sticky(monkeypatch):
    """A wedged teardown reports unconfirmed, and stays unconfirmed."""
    monkeypatch.setattr(browser_mod, "CLEANUP_TIMEOUT_SECONDS", 0.05)

    class Hangs:
        async def close(self):
            await asyncio.sleep(10)

    class Stops:
        async def stop(self):
            return None

    manager = BrowserManager(Path("/nonexistent"))
    manager._context, manager._playwright = Hangs(), Stops()
    assert await manager.close() is False
    assert await manager.close() is False  # no later no-op close may claim success


async def test_manager_close_confirmed():
    class Ok:
        async def close(self):
            return None

        async def stop(self):
            return None

    manager = BrowserManager(Path("/nonexistent"))
    manager._context, manager._playwright = Ok(), Ok()
    assert await manager.close() is True
    assert await manager.close() is True
