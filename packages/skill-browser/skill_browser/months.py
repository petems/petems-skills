"""English month names, which every bill and invoice CLI needs."""

from __future__ import annotations

MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


def parse_month(value: str) -> str:
    """``March``, ``mar`` or ``3`` → ``March``. Raises ``ValueError`` otherwise."""
    text = value.strip()
    if text.isdigit():
        number = int(text)
        if 1 <= number <= 12:
            return MONTHS[number - 1]
    else:
        lowered = text.lower()
        for name in MONTHS:
            if len(lowered) >= 3 and name.lower().startswith(lowered):
                return name
    raise ValueError(f"not a month: {value!r}")


def month_number(name: str) -> int:
    return MONTHS.index(name) + 1
