"""Agent sessions: start a live voice or chat session with an agent from your server, check it, end it."""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from typing_extensions import Unpack

from .. import _operations as ops
from .._base_client import RequestSpec
from .._response import async_to_raw_response_wrapper, to_raw_response_wrapper
from ..errors import UsageError
from ..types.models import AgentSession, StartedAgentSession
from ..types.params import RequestOptions
from ._base import AsyncResource, SyncResource, compact, model_parser

if TYPE_CHECKING:
    from .._client import AsyncEchoNova, EchoNova

__all__ = ["AgentSessions", "Agents", "AsyncAgentSessions", "AsyncAgents"]

Channel = Literal["voice", "chat"] | str


def _id(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise UsageError(f"{name} must be a non-empty string")
    return value.strip()


def _start_spec(agent_id: str, channel: str | None, options: RequestOptions) -> RequestSpec:
    return RequestSpec(
        ops.AGENT_SESSIONS_START,
        path_params={"agentId": _id(agent_id, "agent_id")},
        json=compact(channel=channel),
        options=options,
    )


def _session_spec(op: ops.Operation, agent_id: str, session_id: str, options: RequestOptions) -> RequestSpec:
    path_params = {"agentId": _id(agent_id, "agent_id"), "sessionId": _id(session_id, "session_id")}
    return RequestSpec(op, path_params=path_params, options=options)


# --- Sync ---------------------------------------------------------------------------------------


class AgentSessions(SyncResource):
    def start(
        self, agent_id: str, *, channel: Channel | None = None, **options: Unpack[RequestOptions]
    ) -> StartedAgentSession:
        """Start a live session with an agent. Call it from your server, with a key that has the agents:talk scope.

        ``channel`` is ``voice`` (the API's default) or ``chat``. The result carries a
        one-time room ``token`` and the room's ``ws_url``: hand the token only to the
        client that joins the room, and never log or store it. It is not returned again.
        End the session with ``end()``.

        A start that may have reached the server is never sent again, because a retried
        start opens a second session. If the response is lost, the error has
        ``may_have_executed=True``.
        """
        return self._client._request(_start_spec(agent_id, channel, options), model_parser(StartedAgentSession))

    def get(self, agent_id: str, session_id: str, **options: Unpack[RequestOptions]) -> AgentSession:
        """The session's status. The token is never returned again."""
        spec = _session_spec(ops.AGENT_SESSIONS_GET, agent_id, session_id, options)
        return self._client._request(spec, model_parser(AgentSession))

    def end(self, agent_id: str, session_id: str, **options: Unpack[RequestOptions]) -> AgentSession:
        """End the session and close its room. Ending one that already ended returns its final status."""
        spec = _session_spec(ops.AGENT_SESSIONS_END, agent_id, session_id, options)
        return self._client._request(spec, model_parser(AgentSession))


class Agents(SyncResource):
    def __init__(self, client: EchoNova) -> None:
        super().__init__(client)
        self.sessions = AgentSessions(client)


# --- Async --------------------------------------------------------------------------------------


class AsyncAgentSessions(AsyncResource):
    async def start(
        self, agent_id: str, *, channel: Channel | None = None, **options: Unpack[RequestOptions]
    ) -> StartedAgentSession:
        """Start a live session with an agent. Call it from your server, with a key that has the agents:talk scope.

        ``channel`` is ``voice`` (the API's default) or ``chat``. The result carries a
        one-time room ``token`` and the room's ``ws_url``: hand the token only to the
        client that joins the room, and never log or store it. It is not returned again.
        End the session with ``end()``.

        A start that may have reached the server is never sent again, because a retried
        start opens a second session. If the response is lost, the error has
        ``may_have_executed=True``.
        """
        return await self._client._request(_start_spec(agent_id, channel, options), model_parser(StartedAgentSession))

    async def get(self, agent_id: str, session_id: str, **options: Unpack[RequestOptions]) -> AgentSession:
        """The session's status. The token is never returned again."""
        spec = _session_spec(ops.AGENT_SESSIONS_GET, agent_id, session_id, options)
        return await self._client._request(spec, model_parser(AgentSession))

    async def end(self, agent_id: str, session_id: str, **options: Unpack[RequestOptions]) -> AgentSession:
        """End the session and close its room. Ending one that already ended returns its final status."""
        spec = _session_spec(ops.AGENT_SESSIONS_END, agent_id, session_id, options)
        return await self._client._request(spec, model_parser(AgentSession))


class AsyncAgents(AsyncResource):
    def __init__(self, client: AsyncEchoNova) -> None:
        super().__init__(client)
        self.sessions = AsyncAgentSessions(client)


# --- Raw responses ------------------------------------------------------------------------------


class AgentSessionsWithRawResponse:
    def __init__(self, sessions: AgentSessions) -> None:
        self.start = to_raw_response_wrapper(sessions.start)
        self.get = to_raw_response_wrapper(sessions.get)
        self.end = to_raw_response_wrapper(sessions.end)


class AgentsWithRawResponse:
    def __init__(self, agents: Agents) -> None:
        self.sessions = AgentSessionsWithRawResponse(agents.sessions)


class AsyncAgentSessionsWithRawResponse:
    def __init__(self, sessions: AsyncAgentSessions) -> None:
        self.start = async_to_raw_response_wrapper(sessions.start)
        self.get = async_to_raw_response_wrapper(sessions.get)
        self.end = async_to_raw_response_wrapper(sessions.end)


class AsyncAgentsWithRawResponse:
    def __init__(self, agents: AsyncAgents) -> None:
        self.sessions = AsyncAgentSessionsWithRawResponse(agents.sessions)
