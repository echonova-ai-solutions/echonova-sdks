"""Text to Speech as an async job: create it, wait for it, download it, delete it.

Run::

    ECHONOVA_API_KEY=ek_... python examples/tts_async_job.py VOICE_ID
"""

from __future__ import annotations

import sys

from echonova import EchoNova, JobFailedError


def main() -> None:
    voice_id = sys.argv[1]
    with EchoNova() as client:
        job = client.text_to_speech.jobs.create("مرحبا، هذه رسالة تجريبية.", voice_id=voice_id)
        print(f"job {job.job_id} is {job.status}")
        try:
            done = client.text_to_speech.jobs.wait(job)  # polls every 3 s, up to 20 minutes
        except JobFailedError as exc:
            print(f"the job failed: {exc.job.error}")
            return
        client.text_to_speech.jobs.download(done, to="job.wav")  # gets a fresh link first
        client.text_to_speech.jobs.delete(done)
        print("saved job.wav and deleted the job")

        for recent in client.text_to_speech.jobs.list(limit=20):  # iterating walks every page
            if recent.status == "failed":
                print("failed earlier:", recent.id, recent.error)


if __name__ == "__main__":
    main()
