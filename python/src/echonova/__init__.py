"""Official Python SDK for the EchoNova speech API.

Quick start::

    from echonova import EchoNova

    client = EchoNova()  # reads ECHONOVA_API_KEY
    speech = client.text_to_speech.generate("Hello", voice_id=voice_id)
    client.download(speech.audio_url, to="hello.wav")
"""

from . import audio, types, webhooks
from ._client import AsyncEchoNova, EchoNova
from ._config import DEFAULT_BASE_URL, DEFAULT_MAX_RETRIES, Timeout
from ._core._ratelimit import RateLimitInfo
from ._pagination import AsyncPage, AsyncPageRequest, Page
from ._response import RawResponse
from ._version import __version__
from .audio import Audio
from .errors import *  # noqa: F403
from .errors import __all__ as _errors_all

__all__ = [
    "DEFAULT_BASE_URL",
    "Audio",
    "DEFAULT_MAX_RETRIES",
    "AsyncEchoNova",
    "AsyncPage",
    "AsyncPageRequest",
    "EchoNova",
    "Page",
    "RateLimitInfo",
    "RawResponse",
    "Timeout",
    "__version__",
    "audio",
    "types",
    "webhooks",
    *_errors_all,
]
