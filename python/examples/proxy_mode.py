"""Proxy mode: call EchoNova through your own backend, with no EchoNova key in this process.

Your backend forwards /v1/... to https://api.echonova.ai and adds the API key.
This client only sends your app's own credentials.

    APP_TOKEN=... python examples/proxy_mode.py https://api.example.com/echonova
"""

from __future__ import annotations

import os
import sys

from echonova import EchoNova


def app_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {os.environ['APP_TOKEN']}"}  # called before every request


def main() -> None:
    with EchoNova(base_url=sys.argv[1], auth=app_headers) as client:
        for voice in client.text_to_speech.voices.list():
            print(voice.id, voice.display_name, voice.language)


if __name__ == "__main__":
    main()
