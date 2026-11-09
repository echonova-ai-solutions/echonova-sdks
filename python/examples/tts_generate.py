"""Text to Speech: pick a voice, synthesize a sentence, save the WAV.

Run::

    ECHONOVA_API_KEY=ek_... python examples/tts_generate.py "أهلاً بك في إيكونوفا" speech.wav
"""

from __future__ import annotations

import sys

from echonova import EchoNova


def main() -> None:
    text = sys.argv[1] if len(sys.argv) > 1 else "أهلاً بك في إيكونوفا"
    output = sys.argv[2] if len(sys.argv) > 2 else "speech.wav"
    with EchoNova() as client:
        voices = client.text_to_speech.voices.list()  # changes rarely: cache it in a real app
        voice = next(v for v in voices if v.language == "ar")
        speech = client.text_to_speech.generate(text, voice_id=voice.id)
        print(f"{speech.duration_seconds} s of audio, {speech.credits_consumed} credits (request {speech.request_id})")
        client.download(speech.audio_url, to=output)  # the signed link expires; download it now
        print(f"saved {output}")


if __name__ == "__main__":
    main()
