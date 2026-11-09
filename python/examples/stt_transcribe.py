"""Speech to Text: transcribe a file with your own terminology and speaker labels.

Run::

    ECHONOVA_API_KEY=ek_... python examples/stt_transcribe.py call.mp3
"""

from __future__ import annotations

import sys

from echonova import EchoNova
from echonova.types import Terminology


def main() -> None:
    path = sys.argv[1]
    terminology: Terminology = {
        "keywords": ["KYC", {"term": "Emirates NBD", "variants": ["امريتس ان بي دي"]}],
    }
    with EchoNova() as client:
        result = client.speech_to_text.transcribe(path, language="ar", identify_speakers=True, terminology=terminology)
    print(result.transcription)
    if result.terminology:
        print("with your terms:", result.terminology.corrected)
    for segment in result.segments or ():
        print(f"{segment.start:7.2f}  {segment.speaker or '-':>6}  {segment.text}")
    print(f"{result.credits_consumed} credits (request {result.request_id})")


if __name__ == "__main__":
    main()
