"""Driver-side guard shared by the async and sync WebSocket drivers.

It lives outside ``_link`` because that module is sans-IO and does not import ``websockets``.
"""

from __future__ import annotations

from websockets.exceptions import InvalidHandshake
from websockets.http11 import Response


class HandshakeRedirect(InvalidHandshake):
    """Internal: the handshake was answered with a 3xx.

    ``websockets`` follows a redirect and sends the handshake's headers, including the
    API key or the ``auth`` hook's headers, to the new location. The drivers' connection
    classes raise this instead, so the redirect surfaces as the handshake's error.
    """

    def __init__(self, response: Response) -> None:
        super().__init__(f"the stream handshake was redirected (HTTP {response.status_code})")
        self.response = response
