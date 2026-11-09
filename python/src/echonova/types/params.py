"""Request parameter types. Plain dicts with these keys type-check."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Literal

from typing_extensions import NotRequired, TypedDict

from .._config import Timeout

__all__ = ["CleanOptions", "Keyword", "RequestOptions", "Terminology", "WidgetUser"]


class Keyword(TypedDict):
    """One terminology entry with options. A plain string is a keyword with no options."""

    term: str
    variants: NotRequired[Sequence[str]]
    blocked: NotRequired[Sequence[str]]
    context_words: NotRequired[Sequence[str]]
    needs_context: NotRequired[bool]
    output_script: NotRequired[Literal["latin", "arabic", "as_typed"] | str]


class Terminology(TypedDict):
    """Terms the transcript should spell your way. Send the full list with every request."""

    keywords: Sequence[str | Keyword]


class CleanOptions(TypedDict, total=False):
    """Sound Cleaning settings, as keyword arguments of ``sound_cleaning.clean()``."""

    cutoff_freq: float
    q_factor: float
    target_lufs: float
    true_peak_dbfs: float
    comp_thresh_db: float
    comp_ratio: float
    comp_attack_ms: float
    comp_release_ms: float
    sample_rate: int
    bit_depth: int


class WidgetUser(TypedDict, total=False):
    """The visitor a widget ticket is for."""

    id: str
    name: str


class RequestOptions(TypedDict, total=False):
    """Per-call overrides accepted by every API method."""

    timeout: float | Timeout
    max_retries: int
    deadline: float
    extra_headers: Mapping[str, str]
