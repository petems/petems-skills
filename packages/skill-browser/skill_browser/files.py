"""Writing downloaded documents safely."""

from __future__ import annotations

import os
from pathlib import Path
import re

from skill_browser.errors import OutputExistsError

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")


def safe_component(value: str) -> str:
    """Make *value* safe as one filename component (no separators, no shell syntax)."""
    cleaned = _UNSAFE.sub("_", value).strip("._")
    return cleaned or "_"


def write_private_atomic(path: Path, data: bytes, *, overwrite: bool = False) -> None:
    """Write *data* to *path* with mode 0600, all or nothing.

    Writes a temp file beside the target, fsyncs it, then either replaces the
    target (``overwrite``) or hard-links it into place, which fails atomically
    if the target already exists. A half-written file is never visible.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if not overwrite and path.exists():
        raise OutputExistsError(
            f"{path} already exists. Re-run with --overwrite to replace it.",
            path=str(path),
        )
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if overwrite:
            tmp.replace(path)
        else:
            try:
                os.link(tmp, path)
            except FileExistsError:
                raise OutputExistsError(
                    f"{path} already exists. Re-run with --overwrite to replace it.",
                    path=str(path),
                ) from None
    finally:
        tmp.unlink(missing_ok=True)
