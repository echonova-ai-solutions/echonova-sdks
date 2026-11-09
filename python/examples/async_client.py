"""The asyncio client: start several jobs and wait for them together.

Every wait() on one client shares a polling budget, so many waiters can't use
up the key's rate limit.

    ECHONOVA_API_KEY=ek_... python examples/async_client.py VOICE_ID
"""

from __future__ import annotations

import asyncio
import sys

from echonova import AsyncEchoNova


async def main() -> None:
    voice_id = sys.argv[1]
    sentences = ["الجملة الأولى.", "الجملة الثانية.", "الجملة الثالثة."]
    async with AsyncEchoNova() as client:
        jobs = [await client.text_to_speech.jobs.create(s, voice_id=voice_id) for s in sentences]
        done = await asyncio.gather(*(client.text_to_speech.jobs.wait(job) for job in jobs))
        for index, job in enumerate(done):
            await client.text_to_speech.jobs.download(job, to=f"sentence-{index + 1}.wav")
        async for job in client.text_to_speech.jobs.list(limit=10):
            print(job.id, job.status)


if __name__ == "__main__":
    asyncio.run(main())
