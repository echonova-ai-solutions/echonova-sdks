"""Offset pagination for job lists.

Iterating a page walks every following page too. Lists are newest first, so a
job created while you iterate shifts later pages by one; the iterator skips IDs
it has already returned.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Generator, Iterator
from typing import Any, Generic, TypeVar

from .errors import UsageError

T = TypeVar("T")


def _item_id(item: Any) -> Any:
    return getattr(item, "id", None)


class _PageBase(Generic[T]):
    def __init__(
        self,
        *,
        items: list[T],
        total: int | None,
        offset: int,
        limit: int | None,
        request_id: str | None = None,
        raw: dict[str, Any] | None = None,
    ) -> None:
        self.items = items
        self.total = total
        self.offset = offset
        self.limit = limit
        self.request_id = request_id
        self.raw = raw or {}

    def has_next_page(self) -> bool:
        if not self.items:
            return False
        if self.total is not None:
            return self.offset + len(self.items) < self.total
        return self.limit is not None and len(self.items) >= self.limit

    @property
    def next_offset(self) -> int:
        return self.offset + len(self.items)

    def __len__(self) -> int:
        return len(self.items)

    def __repr__(self) -> str:
        return f"<{type(self).__name__} offset={self.offset} items={len(self.items)} total={self.total}>"


class Page(_PageBase[T]):
    """One page of results. ``for item in page`` continues through the following pages."""

    def __init__(self, *, fetch: Callable[[int], Page[T]], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._fetch = fetch

    def next_page(self) -> Page[T]:
        if not self.has_next_page():
            raise UsageError("there is no next page; check has_next_page() first")
        return self._fetch(self.next_offset)

    def iter_pages(self) -> Iterator[Page[T]]:
        page: Page[T] = self
        while True:
            yield page
            if not page.has_next_page():
                return
            page = page.next_page()

    def __iter__(self) -> Iterator[T]:
        seen: set[Any] = set()
        for page in self.iter_pages():
            for item in page.items:
                key = _item_id(item)
                if key is not None:
                    if key in seen:
                        continue
                    seen.add(key)
                yield item


class AsyncPage(_PageBase[T]):
    """One page of results. ``async for item in page`` continues through the following pages."""

    def __init__(self, *, fetch: Callable[[int], Awaitable[AsyncPage[T]]], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._fetch = fetch

    async def next_page(self) -> AsyncPage[T]:
        if not self.has_next_page():
            raise UsageError("there is no next page; check has_next_page() first")
        return await self._fetch(self.next_offset)

    async def iter_pages(self) -> AsyncIterator[AsyncPage[T]]:
        page: AsyncPage[T] = self
        while True:
            yield page
            if not page.has_next_page():
                return
            page = await page.next_page()

    async def __aiter__(self) -> AsyncIterator[T]:
        seen: set[Any] = set()
        async for page in self.iter_pages():
            for item in page.items:
                key = _item_id(item)
                if key is not None:
                    if key in seen:
                        continue
                    seen.add(key)
                yield item


class AsyncPageRequest(Generic[T]):
    """``await`` it for the first page, or ``async for`` over it to walk every page."""

    def __init__(self, fetch: Callable[[], Awaitable[AsyncPage[T]]]) -> None:
        self._fetch = fetch

    def __await__(self) -> Generator[Any, None, AsyncPage[T]]:
        return self._fetch().__await__()

    async def __aiter__(self) -> AsyncIterator[T]:
        page = await self._fetch()
        async for item in page:
            yield item
