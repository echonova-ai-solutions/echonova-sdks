"""Agent sessions: start a live session with an agent from your server, check it, then end it.

The room token in the result is a secret: hand it only to the client that joins
the room (your web or mobile app), and never log or store it. This script prints
the session without it.

Run::

    ECHONOVA_API_KEY=ek_... python examples/agent_session.py AGENT_ID [voice|chat]
"""

from __future__ import annotations

import sys
import time

from echonova import ConcurrencyLimitError, EchoNova


def hand_to_client(ws_url: str | None, token: str) -> dict[str, str | None]:
    """Stand-in for your API's response to the app that joins the room."""
    return {"wsUrl": ws_url, "token": token}


def main() -> None:
    agent_id = sys.argv[1]
    channel = sys.argv[2] if len(sys.argv) > 2 else "voice"
    with EchoNova() as client:
        try:
            session = client.agents.sessions.start(agent_id, channel=channel)
        except ConcurrencyLimitError as e:
            print("the agent is at its call or chat limit:", e.error_message)
            return
        print(session)  # the repr leaves the token out
        if session.greeting:
            print("agent:", session.greeting)
        hand_to_client(session.ws_url, session.token)
        try:
            time.sleep(10)  # your app joins the room and talks to the agent meanwhile
            print("status:", client.agents.sessions.get(agent_id, session.id).status)
        finally:
            ended = client.agents.sessions.end(agent_id, session.id)
            print("ended:", ended.status, ended.ended_at)


if __name__ == "__main__":
    main()
