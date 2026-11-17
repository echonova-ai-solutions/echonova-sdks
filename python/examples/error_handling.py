"""Handle errors, including a request whose response was lost.

text_to_speech.generate sends an Idempotency-Key, so the SDK retries it safely
after a lost response or a server error. If it still fails, sending it again with
the same key returns the first result, without a second charge.

(Async job creation takes no key. A lost response there may mean it ran and was
charged, so the SDK never sends it again; see find_candidates() in the README.)

    ECHONOVA_API_KEY=ek_... python examples/error_handling.py VOICE_ID
"""

from __future__ import annotations

import sys

import echonova
from echonova import EchoNova


def main() -> None:
    voice_id, text = sys.argv[1], "مرحبا"
    client = EchoNova()
    try:
        speech = client.text_to_speech.generate(text, voice_id=voice_id)
        print("audio:", speech.audio_url is not None)
    except echonova.InvalidRequestError as exc:
        print(f"rejected: {exc.error_message} (request {exc.request_id})")
    except echonova.SpendingLimitError:
        print("the key reached its Credit Limit; raise it in the portal")
    except echonova.RateLimitError as exc:
        print(f"still rate limited after retries; try again in {exc.retry_after} s")
    except (echonova.APIConnectionError, echonova.RequestInProgressError) as exc:
        # Retried already. Sending it again with this key returns the first result, never a second charge.
        print(f"no result yet; send it again later with idempotency_key={exc.idempotency_key!r}")
    except echonova.APIStatusError as exc:
        print(f"{exc.status_code} {exc.error_message} (request {exc.request_id})")
    finally:
        client.close()


if __name__ == "__main__":
    main()
