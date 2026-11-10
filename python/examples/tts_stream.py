"""Text to Speech streaming: audio arrives while it is being made, and text can arrive in pieces.

One socket carries many syntheses. ``synthesize()`` yields PCM16 mono chunks as
soon as they are made; ``speak_stream()`` takes text as it is generated (for
example an LLM's reply), cuts it into sentences and speaks them in order. Each
synthesis is charged per character when it starts.

    ECHONOVA_API_KEY=ek_... python examples/tts_stream.py VOICE_ID reply.wav
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import AsyncIterator

from echonova import AsyncEchoNova, Audio


async def reply_deltas() -> AsyncIterator[str]:
    """Stands in for an LLM streaming its reply."""
    for delta in ["Your order ", "shipped this morning. ", "It should arrive ", "tomorrow before noon."]:
        await asyncio.sleep(0.2)
        yield delta


async def main() -> None:
    voice_id = sys.argv[1]
    output = sys.argv[2] if len(sys.argv) > 2 else "reply.wav"
    pcm = bytearray()
    async with AsyncEchoNova() as client, client.text_to_speech.connect(voice_id=voice_id) as tts:
        greeting = tts.synthesize("Thanks for calling. Let me check that for you.")
        async for chunk in greeting:
            pcm += chunk  # play each chunk as it arrives
        result = await greeting.result()  # how it ended, and what it cost
        print(f"greeting: {result.outcome}, {result.credits_consumed} credits")

        async for chunk in tts.speak_stream(reply_deltas()):  # one sentence at a time, in order
            pcm += chunk

    sample_rate = greeting.sample_rate  # from the server's start message; the same for the whole session
    if sample_rate:
        Audio(bytes(pcm), sample_rate).to_wav(output)
        print(f"saved {output}")


if __name__ == "__main__":
    asyncio.run(main())
