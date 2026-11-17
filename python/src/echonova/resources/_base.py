"""Shared pieces of the resource classes."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from typing import TYPE_CHECKING, Any, Protocol, TypeVar

from .._core._envelope import MalformedEnvelopeError
from .._response import ApiResponse
from ..types._base import Model, to_int
from ..types.models import DeleteResult

if TYPE_CHECKING:
    from .._client import AsyncEchoNova, EchoNova

M = TypeVar("M", bound=Model)


class HasId(Protocol):
    @property
    def id(self) -> str: ...


JobRef = str | HasId
"""A job ID, or any job object: ``JobInitiated``, ``TtsJob``, ``SttResult``, ..."""


class SyncResource:
    def __init__(self, client: EchoNova) -> None:
        self._client = client


class AsyncResource:
    def __init__(self, client: AsyncEchoNova) -> None:
        self._client = client


def model_parser(model: type[M]) -> Callable[[ApiResponse], M]:
    def parse(response: ApiResponse) -> M:
        return model._from_json(response.data, request_id=response.request_id)

    return parse


def result_from_job(model: type[M]) -> Callable[[ApiResponse], M]:
    """A synchronous call's result, built from its completed job after a ``202 Processing`` (ADR 0014).

    It is the type a ``200`` returns: ``.raw`` is the job's JSON plus ``jobId`` (the job's ``id``),
    and ``request_id`` is the last poll's.
    """

    def parse(response: ApiResponse) -> M:
        data = response.data
        fields = {"jobId": data.get("id"), **data} if isinstance(data, dict) else data
        return model._from_json(fields, request_id=response.request_id)

    return parse


def parse_delete(response: ApiResponse) -> DeleteResult:
    result = DeleteResult._from_json(response.data, request_id=response.request_id)
    return replace(result, already_deleted=True) if response.already_deleted else result


def page_data(response: ApiResponse, model: type[M]) -> tuple[list[M], int | None, dict[str, Any]]:
    data = response.data
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise MalformedEnvelopeError("expected a list result with items and total")
    items = [model._from_json(item, request_id=response.request_id) for item in data["items"]]
    return items, to_int(data.get("total")), data


def compact(**values: Any) -> dict[str, Any]:
    """Only the values the caller set: the API treats a missing field as its default."""
    return {key: value for key, value in values.items() if value is not None}
