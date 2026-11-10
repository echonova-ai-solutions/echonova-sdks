"""Speech to Text streaming: send PCM audio and print each transcript as soon as it is ready.

A WAV file (16-bit mono PCM) stands in for a microphone here. For long or
unreliable sources, ``client.speech_to_text.transcribe_stream()`` cuts segments,
rolls over before the session limit and reconnects for you.

    ECHONOVA_API_KEY=ek_... python examples/stt_stream.py call.wav ar
"""

from __future__ import annotations

import sys

from echonova import EchoNova
from echonova.audio import read_wav
from echonova.types.streaming import Transcript


def main() -> None:
    audio = read_wav(sys.argv[1])
    language = sys.argv[2] if len(sys.argv) > 2 else "ar"
    with EchoNova() as client:
        with client.speech_to_text.connect(sample_rate=audio.sample_rate, language=language) as stt:
            sending = stt.feed_from(audio.pcm)  # sends ~100 ms frames on a thread, then calls stop()
            for event in stt:
                if isinstance(event, Transcript):
                    print(f"[{event.duration_seconds:5.1f} s] {event.text.strip()}")
            summary = sending.result()
        print(f"{summary.total_seconds} s of audio, {summary.credits_consumed} credits")
        if summary.saved_status == "saved" and summary.job_id:
            job = client.speech_to_text.jobs.get(summary.job_id)  # the session, kept as a job
            print(f"kept as job {job.id}, with its recording")


if __name__ == "__main__":
    main()
