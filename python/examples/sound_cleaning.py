"""Sound Cleaning: clean a recording, save the result, delete the job.

Run::

    ECHONOVA_API_KEY=ek_... python examples/sound_cleaning.py noisy.wav clean.wav
"""

from __future__ import annotations

import sys

from echonova import EchoNova


def main() -> None:
    source, output = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "clean.wav"
    with EchoNova() as client:
        job = client.sound_cleaning.clean(source, target_lufs=-16, sample_rate=48000, bit_depth=24)
        if job.metrics:
            print(f"loudness {job.metrics.integrated_lufs} LUFS, peak {job.metrics.true_peak_dbfs} dBFS")
        client.download(job.output_url, to=output)
        client.sound_cleaning.jobs.delete(job)
        print(f"saved {output} ({job.credits_consumed} credits)")


if __name__ == "__main__":
    main()
