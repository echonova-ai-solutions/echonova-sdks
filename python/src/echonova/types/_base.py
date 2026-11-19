"""Base class and lenient converters for response models.

The API omits fields it has no value for, so a missing field reads as ``None``.
Unknown fields are kept in ``.raw``. Numbers are accepted as int, float or
numeric strings, and ISO 8601 timestamps become timezone-aware ``datetime``.
Only the fields the SDK itself relies on (IDs and status) are required.
"""

import re
from collections.abc import Callable
from dataclasses import Field, dataclass, field, fields
from datetime import UTC, datetime, timedelta, timezone
from typing import Any, TypeVar

from .._core._envelope import MalformedEnvelopeError
from .._logging import redact_url

M = TypeVar("M", bound="Model")
Converter = Callable[[Any], Any]


@dataclass(frozen=True, slots=True, kw_only=True)
class Model:
    """A response object. ``raw`` is the API's JSON as received; ``request_id`` comes from ``X-Request-Id``."""

    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)
    request_id: str | None = field(default=None, repr=False, compare=False)

    @classmethod
    def _from_json(cls: type[M], data: Any, *, request_id: str | None = None) -> M:
        if not isinstance(data, dict):
            raise MalformedEnvelopeError(f"expected a JSON object for {cls.__name__}, got {type(data).__name__}")
        values: dict[str, Any] = {}
        for name, api, convert, required in _api_fields(cls):
            value = data.get(api)
            value = None if value is None else convert(value)
            if value is None and required:
                raise MalformedEnvelopeError(f"{cls.__name__} is missing '{api}'")
            values[name] = value
        return cls(raw=data, request_id=request_id, **values)

    def __repr__(self) -> str:
        """The dataclass ``repr()``, with signed links (``link`` fields) shown without their query string."""
        shown = (f"{f.name}={_shown(f, getattr(self, f.name))!r}" for f in fields(self) if f.repr)
        return f"{type(self).__qualname__}({', '.join(shown)})"

    def to_dict(self) -> dict[str, Any]:
        """The parsed fields as plain Python values (nested models become dicts)."""
        return {name: _plain(getattr(self, name)) for name, *_ in _api_fields(type(self))}


_FIELDS: dict[type, tuple[tuple[str, str, Converter, bool], ...]] = {}


def _api_fields(cls: type[Model]) -> tuple[tuple[str, str, Converter, bool], ...]:
    found = _FIELDS.get(cls)
    if found is None:
        found = _FIELDS[cls] = tuple(
            (f.name, f.metadata["api"], f.metadata["convert"], f.metadata["required"])
            for f in fields(cls)
            if "api" in f.metadata
        )
    return found


def _plain(value: Any) -> Any:
    if isinstance(value, Model):
        return value.to_dict()
    if isinstance(value, tuple):
        return [_plain(item) for item in value]
    return value


def _shown(f: Field[Any], value: Any) -> Any:
    return redact_url(value) if f.metadata.get("link") and isinstance(value, str) else value


def api_field(
    api: str, convert: Converter = lambda v: v, *, required: bool = False, secret: bool = False, link: bool = False
) -> Any:
    """Declare a model field read from the API key ``api``. A ``secret`` field is left out of ``repr()``.

    A ``link`` field is a signed link: ``repr()`` shows it without the query string that carries the signature.
    """
    metadata = {"api": api, "convert": convert, "required": required, "link": link}
    if required:
        return field(metadata=metadata, repr=not secret)
    return field(default=None, metadata=metadata, repr=not secret)


def to_str(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return None


def to_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def to_int(value: Any) -> int | None:
    """An integer; a non-integral number is kept as a float rather than rounded."""
    number = to_float(value)
    if number is None:
        return None
    if isinstance(value, int):
        return value
    return int(number) if number.is_integer() else number  # type: ignore[return-value]


def to_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    if isinstance(value, str) and value.strip().lower() in ("true", "false"):
        return value.strip().lower() == "true"
    return None


_ISO = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$"
)


def to_datetime(value: Any) -> datetime | None:
    """Parse an ISO 8601 timestamp. A timestamp without an offset is read as UTC."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if not isinstance(value, str):
        return None
    match = _ISO.match(value.strip())
    if not match:
        return None
    year, month, day, hour, minute, second, fraction, offset = match.groups()
    tz = UTC
    if offset and offset not in ("Z", "z"):
        sign = -1 if offset[0] == "-" else 1
        digits = offset[1:].replace(":", "")
        hours, minutes = int(digits[:2]), int(digits[2:4] or 0)
        tz = timezone(sign * timedelta(hours=hours, minutes=minutes))
    try:
        return datetime(
            int(year),
            int(month),
            int(day),
            int(hour or 0),
            int(minute or 0),
            int(second or 0),
            int((fraction or "0")[:6].ljust(6, "0")),
            tzinfo=tz,
        )
    except ValueError:
        return None


def to_model(model: type[M]) -> Converter:
    def convert(value: Any) -> M | None:
        return model._from_json(value) if isinstance(value, dict) else None

    return convert


def to_models(model: type[M]) -> Converter:
    def convert(value: Any) -> tuple[M, ...] | None:
        if not isinstance(value, list):
            return None
        return tuple(model._from_json(item) for item in value if isinstance(item, dict))

    return convert
