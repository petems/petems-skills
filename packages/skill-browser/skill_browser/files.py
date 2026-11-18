"""Writing downloaded documents safely."""

from __future__ import annotations

import os
from pathlib import Path
import re
import tempfile

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

    The temp file comes from :func:`tempfile.mkstemp`: a random name, created
    with ``O_EXCL`` and mode 0600, so a symlink planted in a shared output
    directory cannot redirect the write.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if not overwrite and path.exists():
        raise OutputExistsError(
            f"{path} already exists. Re-run with --overwrite to replace it.",
            path=str(path),
        )
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    tmp = Path(tmp_name)
    try:
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
