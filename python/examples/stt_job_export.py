"""Speech to Text as an async job, exported as subtitles and as JSON.

Run::

    ECHONOVA_API_KEY=ek_... python examples/stt_job_export.py meeting.wav
"""

from __future__ import annotations

import sys
from pathlib import Path

from echonova import EchoNova


def main() -> None:
    path = Path(sys.argv[1])
    with EchoNova() as client:
        job = client.speech_to_text.jobs.create(path, language="en", identify_speakers=True)
        done = client.speech_to_text.jobs.wait(job)  # polls every 5 s
        srt = client.speech_to_text.jobs.export(done, format="srt")  # str
        path.with_suffix(".srt").write_text(srt, encoding="utf-8")
        export = client.speech_to_text.jobs.export(done, format="json")  # TranscriptExport
        for speaker in export.speakers or ():
            print(f"{speaker.label}: {speaker.talk_time} s")
        client.speech_to_text.jobs.delete(done)


if __name__ == "__main__":
    main()
