"""Cross-process exclusion on the browser profile.

Chromium does not refuse two processes on one ``user_data_dir``: both run, and
the last to close overwrites the other's cookies. A live My3 session is lost
with no error. This is the replacement for hand-cleaning chrome-devtools-mcp's
``SingletonLock``: a second ``three-bill`` gets a clear "busy" error instead.

The lock file is never unlinked. Unlinking splits contenders across inodes, and
the process locking the old inode and the one locking the new path would both
believe they are exclusive.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
import socket

if os.name == "nt":  # pragma: no cover - platform split
    import msvcrt
else:
    import fcntl

logger = logging.getLogger(__name__)


def secure_mkdir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        path.chmod(0o700)


class ProfileLease:
    """An exclusive advisory lock on ``profile.lock`` beside the profile."""

    def __init__(self, lock_path: Path) -> None:
        self.path = lock_path
        self._fd: int | None = None

    @classmethod
    def for_profile(cls, profile_dir: Path) -> ProfileLease:
        return cls(profile_dir.parent / "profile.lock")

    @property
    def held(self) -> bool:
        return self._fd is not None

    def try_acquire(self) -> bool:
        if self._fd is not None:
            return True
        secure_mkdir(self.path.parent)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            if os.name == "nt":  # pragma: no cover - platform split
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return False
        self._fd = fd
        return True

    def release(self) -> None:
        """Unlock. Call only once Chromium is *confirmed* gone."""
        fd, self._fd = self._fd, None
        if fd is None:
            return
        try:
            if os.name == "nt":  # pragma: no cover - platform split
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            logger.debug("Failed to unlock %s", self.path, exc_info=True)
        finally:
            os.close(fd)


def chromium_owner_pid(profile_dir: Path) -> int | None:
    """The live pid holding Chromium's own ``SingletonLock``, if any.

    Belt and braces for a Chromium that outlived a previous run whose close was
    never confirmed: the kernel freed our flock when that process exited, but
    the browser may still be writing to the profile. Read only; the lock is
    never deleted here, because a live owner is exactly the case to refuse.
    """
    try:
        target = os.readlink(profile_dir / "SingletonLock")
    except OSError:
        return None
    host, _, pid_text = target.rpartition("-")
    if not pid_text.isdigit() or host != socket.gethostname():
        return None
    pid = int(pid_text)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        return pid
    return pid
