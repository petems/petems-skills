"""Typed errors, each with its own exit code.

The skill branches on the exit code, so the three cases it must tell apart
(no session, profile busy, API contract changed) never share one.
"""

from __future__ import annotations

from typing import Any

EXIT_OK = 0
EXIT_UNEXPECTED = 1
EXIT_USAGE = 2
EXIT_NOT_LOGGED_IN = 3
EXIT_PROFILE_BUSY = 4
EXIT_CONTRACT_CHANGED = 5
EXIT_BILL_NOT_FOUND = 6
EXIT_PDF_INVALID = 7
EXIT_SHUTDOWN_UNCONFIRMED = 8
EXIT_API_ERROR = 9


class ThreeBillError(Exception):
    """Base error. ``code`` is a stable machine-readable name."""

    exit_code = EXIT_UNEXPECTED
    code = "error"

    def __init__(self, message: str, *, code: str | None = None, **details: Any):
        super().__init__(message)
        if code is not None:
            self.code = code
        self.details = details

    def as_dict(self) -> dict[str, Any]:
        return {
            "error": self.code,
            "message": str(self),
            "exit_code": self.exit_code,
            **({"details": self.details} if self.details else {}),
        }


class NotLoggedInError(ThreeBillError):
    exit_code = EXIT_NOT_LOGGED_IN
    code = "not_logged_in"


class LoginTimeoutError(ThreeBillError):
    exit_code = EXIT_NOT_LOGGED_IN
    code = "login_timeout"


class ProfileBusyError(ThreeBillError):
    exit_code = EXIT_PROFILE_BUSY
    code = "profile_busy"


class ContractChangedError(ThreeBillError):
    """A response no longer has the shape references/three-api-endpoints.md documents."""

    exit_code = EXIT_CONTRACT_CHANGED
    code = "contract_changed"


class InvalidIdentifierError(ContractChangedError):
    code = "invalid_identifier"


class BillNotFoundError(ThreeBillError):
    exit_code = EXIT_BILL_NOT_FOUND
    code = "bill_not_found"


class PdfInvalidError(ThreeBillError):
    exit_code = EXIT_PDF_INVALID
    code = "pdf_invalid"


class ShutdownUnconfirmedError(ThreeBillError):
    exit_code = EXIT_SHUTDOWN_UNCONFIRMED
    code = "browser_shutdown_unconfirmed"


class ApiError(ThreeBillError):
    """Three answered with an unexpected status (404, 5xx) or not at all."""

    exit_code = EXIT_API_ERROR
    code = "api_error"
