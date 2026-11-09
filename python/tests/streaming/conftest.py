from __future__ import annotations

from collections.abc import Iterator

import pytest
from mock_server import MockServer
from stream_adapters import Bridge
from stream_helpers import options_for

from echonova._streaming import StreamOptions


@pytest.fixture
def server() -> Iterator[MockServer]:
    mock = MockServer().start()
    yield mock
    mock.stop()


@pytest.fixture
def opts(server: MockServer) -> StreamOptions:
    return options_for(server)


@pytest.fixture(params=["async", "sync"])
def mode(request: pytest.FixtureRequest) -> str:
    return str(request.param)


@pytest.fixture
def bridge(mode: str) -> Iterator[Bridge | None]:
    if mode == "sync":
        yield None
        return
    loop_bridge = Bridge()
    yield loop_bridge
    loop_bridge.close()
