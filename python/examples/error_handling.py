"""Handle errors, including a request whose response was lost.

A POST that was fully sent may have run and been charged even if no response
arrived. The SDK never sends it again on its own; this shows how to check.

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
    except echonova.APIConnectionError as exc:
        if exc.may_have_executed and exc.sent_at is not None:
            candidates = client.text_to_speech.jobs.find_candidates(exc.sent_at, text=text)
            print(f"no response, but {len(candidates)} matching job(s) exist; check them before retrying")
        else:
            print("the request did not run; it is safe to send it again")
    except echonova.APIStatusError as exc:
        print(f"{exc.status_code} {exc.error_message} (request {exc.request_id})")
    finally:
        client.close()


if __name__ == "__main__":
    main()
