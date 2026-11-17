"""The post-login settle: wait for the SPA's own /account with its state written."""

from __future__ import annotations

from three_bill import login
from three_bill.my3 import Site


class FakePage:
    """Each read of ``url`` is one poll: it moves to the next (url, ready) step."""

    def __init__(self, steps):
        self.steps = list(steps)
        self.index = -1

    @property
    def url(self):
        self.index = min(self.index + 1, len(self.steps) - 1)
        return self.steps[self.index][0]

    async def evaluate(self, _js):
        return self.steps[self.index][1]


class FakeMy3:
    def __init__(self, page):
        self.page = page
        self.site = Site()


BASE = Site().base_url


async def test_waits_until_account_and_state(monkeypatch):
    monkeypatch.setattr(login.asyncio, "sleep", _no_sleep)
    page = FakePage(
        [
            (f"{BASE}/customer-logged", False),
            (f"{BASE}/account", False),
            (f"{BASE}/account", True),
        ]
    )
    assert await login.wait_for_spa_state(FakeMy3(page), timeout=5) is True


async def test_state_on_the_wrong_page_does_not_count(monkeypatch):
    monkeypatch.setattr(login.asyncio, "sleep", _no_sleep)
    page = FakePage([(f"{BASE}/customer-logged", True)])
    assert await login.wait_for_spa_state(FakeMy3(page), timeout=0.05) is False


async def _no_sleep(_seconds):
    return None
