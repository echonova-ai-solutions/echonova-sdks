/**
 * Streaming: the Text to Speech and Speech to Text WebSockets.
 *
 * The client wires these factories into `client.textToSpeech.connect()` /
 * `speak()` and `client.speechToText.connect()` / `transcribeStream()`, with a
 * `StreamOptions` built from its own configuration. Nothing here is imported by
 * the REST code, and the `ws` package is loaded only when a stream opens.
 */

import { abortReason } from '../runtime/ws-transport.js';
import type { Audio } from './audio.js';
import { resolveStreamOptions, type ResolvedStreamOptions, type StreamOptions } from './options.js';
import { SttSession, type SttSessionInit } from './stt-session.js';
import { TtsSession } from './tts-session.js';
import type { SynthesisOptions } from './types.js';

export interface ConnectTtsOptions extends Omit<SynthesisOptions, 'voiceId' | 'extraBody'> {
  /** The voice for every synthesis on this session (each `synthesize()` may override it). */
  voiceId: string;
  /** Keep retrying "Too many concurrent streams" for up to this many ms. Default off. */
  waitForSlot?: number | null | undefined;
  /** Abort the connection attempt. */
  signal?: AbortSignal | undefined;
}

/**
 * Open a Text to Speech stream. `speed`, `cfg`, `numSteps`, `tashkeel` and
 * `normalize` given here apply to every synthesis on it.
 */
export async function connectTts(
  options: StreamOptions | ResolvedStreamOptions,
  init: ConnectTtsOptions,
): Promise<TtsSession> {
  const { voiceId, waitForSlot, signal, ...defaults } = init;
  const session = new TtsSession(resolveStreamOptions(options), { voiceId, defaults, waitForSlot });
  return session._start(signal);
}

export interface SpeakOptions extends SynthesisOptions {
  voiceId: string;
  waitForSlot?: number | null | undefined;
  /** Abort: cancels the synthesis and closes the stream. */
  signal?: AbortSignal | undefined;
}

/**
 * Synthesize `text` over a stream of its own and return all the audio (PCM16LE
 * mono at the server's sample rate). For low latency, iterate a `Synthesis`
 * from `connectTts()` instead.
 */
export async function speak(options: StreamOptions | ResolvedStreamOptions, text: string, init: SpeakOptions): Promise<Audio> {
  const { voiceId, waitForSlot, signal, ...synthesis } = init;
  const tts = await connectTts(options, { voiceId, waitForSlot, signal });
  try {
    const synth = tts.synthesize(text, synthesis);
    const onAbort = (): void => synth.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const audio = await synth.collect();
      if (signal?.aborted) throw abortReason(signal);
      await synth.result;
      return audio;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    await tts.close();
  }
}

export interface ConnectSttOptions extends SttSessionInit {
  /** Abort the connection attempt. */
  signal?: AbortSignal | undefined;
}

/**
 * Open a Speech to Text stream. Resolves once the server has started the
 * session (and confirmed `terminology`, when given); `sessionId` and `jobId`
 * are then available.
 */
export async function connectStt(
  options: StreamOptions | ResolvedStreamOptions,
  init: ConnectSttOptions,
): Promise<SttSession> {
  const { signal, ...sessionInit } = init;
  const session = new SttSession(resolveStreamOptions(options), sessionInit);
  return session._start({ signal });
}

export { transcribeStream, reconnectReason, type TranscribeStreamOptions } from './transcribe.js';
export { TtsSession, Synthesis, type TtsSessionInit, type SpeakStreamOptions, type TextSource } from './tts-session.js';
export { SttSession, DEFAULT_STOP_TIMEOUT, type AudioSource, type SttSessionInit } from './stt-session.js';
export type { SttState } from './stt-protocol.js';
export { Audio, pcmToWav, wavHeader, parseWav, iterFrames, type WavHeaderOptions, type BytesLike } from './audio.js';
export { PcmFramer, MAX_FRAME_BYTES } from './pcm-framer.js';
export { chargeStateOf } from './stream-errors.js';
export {
  DEFAULT_WS_BASE_URL,
  STT_PATH,
  TTS_PATH,
  resolveStreamOptions,
  streamURL,
  systemClock,
  type Clock,
  type HeadersProvider,
  type QueryProvider,
  type ReconnectPolicy,
  type ResolvedStreamOptions,
  type StreamOptions,
} from './options.js';
export type { WsTransport, WsSocket, WsOpenRequest, WsHandlers } from '../runtime/ws-transport.js';
export type {
  AudioDropped,
  ChargeState,
  RawEvent,
  Reconnected,
  SegmentMark,
  SessionEnded,
  SessionSaved,
  SessionSavedStatus,
  SessionSummary,
  StreamErrorEvent,
  SttEvent,
  SynthesisMetrics,
  SynthesisOptions,
  SynthesisOutcome,
  SynthesisResult,
  SynthesisState,
  TerminologySet,
  StreamTerminology,
  TranscribeEvent,
  Transcript,
  UnknownStreamEvent,
} from './types.js';
