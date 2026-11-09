"""Page[T]: one page at a time, or every page with duplicates from offset drift removed."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from _support import Recorder, make_async_client, make_client, ok
from echonova import AsyncPage, Page, UsageError


def job(index: int) -> dict[str, str]:
    return {"id": f"{index:024x}", "status": "completed", "text": f"t{index}", "voiceId": "v"}


def drifting_list(request: httpx.Request) -> httpx.Response:
    """Five jobs, 2 per page. A new job arrives after the first page, so later pages shift by one."""
    offset = int(request.url.params.get("offset", 0))
    limit = int(request.url.params.get("limit", 20))
    jobs = [job(i) for i in range(5, 0, -1)]
    if offset > 0:
        jobs = [job(6), *jobs]
    return ok({"items": jobs[offset : offset + limit], "total": len(jobs)})


def test_page_fields_and_next_page() -> None:
    client = make_client(drifting_list)
    page = client.text_to_speech.jobs.list(limit=2)
    assert isinstance(page, Page)
    assert [j.text for j in page.items] == ["t5", "t4"]
    assert page.total == 5
    assert page.offset == 0
    assert len(page) == 2
    assert page.has_next_page()
    second = page.next_page()
    assert second.offset == 2
    assert [j.text for j in second.items] == ["t4", "t3"]  # t4 again: a job arrived in between


def test_iterating_walks_every_page_and_skips_duplicates() -> None:
    recorder = Recorder(drifting_list)
    client = make_client(recorder)
    texts = [j.text for j in client.text_to_speech.jobs.list(limit=2)]
    assert texts == ["t5", "t4", "t3", "t2", "t1"]
    assert [r.url.params.get("offset") for r in recorder.requests] == [None, "2", "4"]


def test_last_page_and_empty_list() -> None:
    client = make_client(lambda r: ok({"items": [], "total": 0}))
    page = client.speech_to_text.jobs.list()
    assert not page.has_next_page()
    assert list(page) == []
    with pytest.raises(UsageError):
        page.next_page()


def test_without_total_a_full_page_means_more() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        offset = int(request.url.params.get("offset", 0))
        return ok({"items": [job(i) for i in range(offset, min(offset + 2, 3))]})

    assert [j.text for j in make_client(handler).text_to_speech.jobs.list(limit=2)] == ["t0", "t1", "t2"]


def test_iter_pages() -> None:
    pages = list(make_client(drifting_list).text_to_speech.jobs.list(limit=2).iter_pages())
    assert [p.offset for p in pages] == [0, 2, 4]


def test_async_pages() -> None:
    recorder = Recorder(drifting_list)
    client = make_async_client(recorder)

    async def run() -> None:
        texts = [j.text async for j in client.text_to_speech.jobs.list(limit=2)]
        assert texts == ["t5", "t4", "t3", "t2", "t1"]
        page = await client.text_to_speech.jobs.list(limit=2)
        assert isinstance(page, AsyncPage)
        second = await page.next_page()
        assert second.offset == 2
        all_from_page = [j.text async for j in page]
        assert all_from_page == texts

    asyncio.run(run())
