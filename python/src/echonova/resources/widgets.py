"""Agents widget tickets, minted on your server for one visitor at a time."""

from __future__ import annotations

from typing import Literal

from typing_extensions import Unpack

from .. import _operations as ops
from .._base_client import RequestSpec
from .._response import async_to_raw_response_wrapper, to_raw_response_wrapper
from ..errors import UsageError
from ..types.models import WidgetTicket
from ..types.params import RequestOptions, WidgetUser
from ._base import AsyncResource, SyncResource, compact, model_parser

__all__ = ["AsyncWidgets", "Widgets"]

Channel = Literal["voice", "chat"] | str


def _spec(
    public_id: str, user: WidgetUser | None, channel: str | None, ttl_seconds: int | None, options: RequestOptions
) -> RequestSpec:
    if not isinstance(public_id, str) or not public_id.strip():
        raise UsageError("public_id is the widget ID from the widget settings (it starts with wdg_)")
    body = compact(user=dict(user) if user is not None else None, channel=channel, ttlSeconds=ttl_seconds)
    return RequestSpec(
        ops.WIDGETS_CREATE_TICKET, path_params={"publicId": public_id.strip()}, json=body, options=options
    )


class Widgets(SyncResource):
    def create_ticket(
        self,
        public_id: str,
        *,
        user: WidgetUser | None = None,
        channel: Channel | None = None,
        ttl_seconds: int | None = None,
        **options: Unpack[RequestOptions],
    ) -> WidgetTicket:
        """Mint a ticket that lets one visitor open a private widget. Call it from your server."""
        return self._client._request(_spec(public_id, user, channel, ttl_seconds, options), model_parser(WidgetTicket))


class AsyncWidgets(AsyncResource):
    async def create_ticket(
        self,
        public_id: str,
        *,
        user: WidgetUser | None = None,
        channel: Channel | None = None,
        ttl_seconds: int | None = None,
        **options: Unpack[RequestOptions],
    ) -> WidgetTicket:
        """Mint a ticket that lets one visitor open a private widget. Call it from your server."""
        return await self._client._request(
            _spec(public_id, user, channel, ttl_seconds, options), model_parser(WidgetTicket)
        )


class WidgetsWithRawResponse:
    def __init__(self, widgets: Widgets) -> None:
        self.create_ticket = to_raw_response_wrapper(widgets.create_ticket)


class AsyncWidgetsWithRawResponse:
    def __init__(self, widgets: AsyncWidgets) -> None:
        self.create_ticket = async_to_raw_response_wrapper(widgets.create_ticket)
