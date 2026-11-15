# Examples

Short TypeScript scripts that use the SDK end to end. Each reads your API key from `ECHONOVA_API_KEY`. Most of them call paid endpoints, so they use a few credits.

| Example | What it shows |
|---|---|
| [`tts-generate.ts`](tts-generate.ts) | Pick a voice, synthesize a sentence and save the WAV |
| [`tts-async-job.ts`](tts-async-job.ts) | An async Text to Speech job: create, wait, download, delete, list |
| [`tts-stream.ts`](tts-stream.ts) | A Text to Speech stream: audio chunks, barge-in, and text deltas spoken sentence by sentence |
| [`stt-transcribe.ts`](stt-transcribe.ts) | Transcribe a file with your terminology and speaker labels |
| [`stt-job-export.ts`](stt-job-export.ts) | An async Speech to Text job, exported as SRT subtitles and as JSON |
| [`stt-stream.ts`](stt-stream.ts) | A Speech to Text stream fed with live PCM audio, or `transcribeStream()` with `--long` |
| [`sound-cleaning.ts`](sound-cleaning.ts) | Clean a recording, save it and delete the job |
| [`error-handling.ts`](error-handling.ts) | The error classes, and what to do when a request's response was lost |
| [`proxy-mode.ts`](proxy-mode.ts) | Calling EchoNova through your own backend, with no API key in the process |
| [`agent-session.ts`](agent-session.ts) | Start, check and end an agent session without exposing the room token |

## Running them

The examples are plain TypeScript that Node.js runs directly with type stripping (Node.js 22.6 or later; from 22.18 the flag isn't needed, and it does no harm). In this repository, build the package first, because the examples import `@echonova/ai` by name and that resolves to this package's `dist/`:

```bash
cd js
npm ci && npm run build
ECHONOVA_API_KEY=ek_... node --experimental-strip-types examples/tts-generate.ts
```

Each file's header shows its arguments. Run one without arguments to see its usage.

To use one in your own project, `npm install @echonova/ai` and copy the file into a folder whose `package.json` has `"type": "module"` (or rename it to `.mts`). The examples use top-level `await`, so they must run as ES modules.

## Checks

`npm run typecheck` type-checks the examples against the source (`tsconfig.examples.json` maps `@echonova/ai` and `@echonova/ai/streaming` to `src/`). The examples are not part of the published package.
