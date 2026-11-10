/**
 * Text to Speech stream sessions.
 *
 * One socket carries many syntheses, one at a time. The socket is reopened
 * lazily when something needs sending, and rotated while idle before the
 * server's session limit.
 *
 * ```ts
 * await using tts = await connectTts(options, { voiceId });
 * const synth = tts.synthesize('Hi there');
 * for await (const pcm of synth) { speaker.write(pcm); if (bargeIn) break; } // break cancels it
 * console.log((await synth.result).outcome);
 * ```
 */

import { APIConnectionError, EchoNovaError, SessionEndedError, StreamClosedError, UsageError } from '../errors.js';
import { Audio, concatBytes } from './audio.js';
import { Signal, anySignal, handled } from './async-utils.js';
import { AttemptLimiter, decodeEvent } from './link-rules.js';
import { Link, LinkClosed, openLink } from './link.js';
import { TTS_PATH, resolveStreamOptions, type ResolvedStreamOptions, type StreamOptions } from './options.js';
import type { CloseInfo } from './stream-errors.js';
import { SentenceSplitter, outboundText, type Outbound, type SynthesisCore, TtsProtocol } from './tts-protocol.js';
import type {
  ChargeState,
  SynthesisMetrics,
  SynthesisOptions,
  SynthesisResult,
  SynthesisState,
  UnknownStreamEvent,
} from './types.js';

/** @internal How a `Synthesis` talks to its session. */
interface SynthesisHost {
  changed(): Promise<void>;
  cancelCore(core: SynthesisCore): void;
}

/**
 * One synthesis. Iterate it with `for await` to get PCM16LE mono audio at
 * `sampleRate`; leaving the loop early (`break`, `return` or an exception)
 * cancels it. Each audio chunk is delivered once: iterate from one place only.
 */
export class Synthesis implements AsyncIterable<Uint8Array> {
  readonly #host: SynthesisHost;
  readonly #core: SynthesisCore;
  #result: Promise<SynthesisResult> | null = null;

  /** @internal */
  constructor(host: SynthesisHost, core: SynthesisCore) {
    this.#host = host;
    this.#core = core;
  }

  get requestId(): string {
    return this.#core.requestId;
  }

  get state(): SynthesisState {
    return this.#core.state;
  }

  /** Sample rate of the audio, from the server's `start` (`null` before it arrives). Never assumed. */
  get sampleRate(): number | null {
    return this.#core.sampleRate;
  }

  get metrics(): SynthesisMetrics {
    return this.#core.metrics();
  }

  /** Whether this synthesis was charged: `yes`, `no` or `unknown` (sent, but nothing came back before the loss). */
  get chargeState(): ChargeState {
    return this.#core.chargeState;
  }

  /** `true` when the server reported a cost, `false` when it reported none, `null` when unknown. */
  get charged(): boolean | null {
    return this.#core.charged;
  }

  /** The final cost, when the server reported it (also for a synthesis that failed after its audio started). */
  get creditsConsumed(): number | null {
    return this.#core.creditsConsumed;
  }

  /** The error it ended with, if it failed or was lost. */
  get error(): EchoNovaError | null {
    return this.#core.error;
  }

  get done(): boolean {
    return this.#core.terminal;
  }

  /**
   * How it ended: outcome, credits and whether it was charged. Rejects with its
   * error if it failed or was lost. A cancellation is an outcome, not an error.
   */
  get result(): Promise<SynthesisResult> {
    this.#result ??= handled(this.#waitResult());
    return this.#result;
  }

  async #waitResult(): Promise<SynthesisResult> {
    const core = this.#core;
    while (!core.terminal) await this.#host.changed();
    if (core.error !== null) throw core.error;
    if (core.outcome === null) throw new StreamClosedError(`the synthesis ended as ${core.state}`);
    return core.result();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this.#audio();
  }

  async *#audio(): AsyncGenerator<Uint8Array, void, undefined> {
    const core = this.#core;
    let finished = false;
    try {
      for (;;) {
        const chunk = core.chunks.shift();
        if (chunk !== undefined) {
          yield chunk;
          continue;
        }
        if (core.terminal) {
          finished = true;
          if (core.error !== null) throw core.error;
          return;
        }
        await this.#host.changed();
      }
    } finally {
      if (!finished && !core.terminal) this.#host.cancelCore(core);
    }
  }

  /** All remaining audio, once the synthesis has finished. Rejects if it failed. */
  async collect(): Promise<Audio> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of this) chunks.push(chunk);
    return new Audio(concatBytes(chunks), this.#core.sampleRate ?? 0);
  }

  /** Stop this synthesis. If its audio had started, it costs the share of audio sent (at least 1 credit). */
  cancel(): void {
    this.#host.cancelCore(this.#core);
  }

  /** `await using synth = tts.synthesize(...)`: cancels it if it is still running. */
  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.#core.terminal) this.cancel();
  }

  toString(): string {
    return `Synthesis(requestId='${this.requestId}', state='${this.state}')`;
  }
}

export interface TtsSessionInit {
  voiceId: string;
  /** Options merged into every synthesis on this session. */
  defaults?: Omit<SynthesisOptions, 'voiceId'> | undefined;
  /** Keep retrying "Too many concurrent streams" for up to this many ms. */
  waitForSlot?: number | null | undefined;
}

export type TextSource = string | Iterable<string> | AsyncIterable<string>;

export interface SpeakStreamOptions extends Omit<SynthesisOptions, 'extraBody'> {
  /**
   * Whether items are fragments of one text (for example LLM deltas). Defaults to
   * `true` for async iterables and `false` for arrays and other iterables.
   */
  deltas?: boolean | undefined;
}

/** A Text to Speech stream. Create it with `connectTts()`. */
export class TtsSession {
  readonly #options: ResolvedStreamOptions;
  readonly #protocol: TtsProtocol;
  readonly #limiter: AttemptLimiter;
  readonly #waitForSlot: number | null;
  readonly #changed = new Signal();
  readonly #abort = new AbortController();
  #link: Link | null = null;
  #connecting: Promise<Link> | null = null;
  #pumping = false;
  #pumpAgain = false;
  #timer: unknown = null;
  #closed = false;
  readonly #host: SynthesisHost = {
    changed: () => this.#changed.wait(),
    cancelCore: (core) => this.#cancelCore(core),
  };
  /** The `X-Request-Id` of the latest handshake. Quote it when contacting support. */
  handshakeRequestId: string | null = null;

  /** @internal Use `connectTts()`. */
  constructor(options: StreamOptions | ResolvedStreamOptions, init: TtsSessionInit) {
    this.#options = resolveStreamOptions(options);
    if (typeof init.voiceId !== 'string' || init.voiceId === '') throw new UsageError('voiceId is required');
    this.#waitForSlot = init.waitForSlot ?? null;
    this.#protocol = new TtsProtocol({
      voiceId: init.voiceId,
      defaults: init.defaults,
      startTimeout: this.#options.synthesisStartTimeout,
      cancelAckTimeout: this.#options.cancelAckTimeout,
    });
    this.#limiter = new AttemptLimiter(this.#options.maxConnectAttempts, this.#options.connectWindow);
  }

  /** @internal Open the first socket. */
  async _start(signal?: AbortSignal): Promise<this> {
    try {
      await this.#reconnect(signal);
    } catch (error) {
      await this.close();
      throw error;
    }
    return this;
  }

  // --- Lifecycle --------------------------------------------------------------------------

  /** Close the socket. Requests not yet sent are dropped; one still running ends as cancelled. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const { clock } = this.#options;
    this.#protocol.close(clock.now());
    this.#abort.abort(new SessionEndedError('the Text to Speech session is closed'));
    if (this.#timer !== null) clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#notify();
    const link = this.#link;
    if (link !== null) await link.close();
    this.#notify();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  get closed(): boolean {
    return this.#closed;
  }

  get connected(): boolean {
    return this.#link !== null && !this.#link.closed;
  }

  /**
   * Sample rate of the most recent synthesis that started, from its `start` event (`null` before the first).
   * `speakStream()` yields only audio: read its rate here. It is set before the first chunk of each synthesis.
   */
  get sampleRate(): number | null {
    return this.#protocol.sampleRate;
  }

  /** Audio frames that matched no running synthesis and were discarded. */
  get droppedFrames(): number {
    return this.#protocol.orphanFrames;
  }

  /** The latest events of types this SDK version doesn't know (kept, never thrown). */
  get unknownEvents(): readonly UnknownStreamEvent[] {
    return [...this.#protocol.unknownEvents];
  }

  // --- Public API -------------------------------------------------------------------------

  /** Speak `text` now, replacing whatever is running and dropping anything queued. */
  synthesize(text: string, options: SynthesisOptions = {}): Synthesis {
    const core = this.#protocol.synthesize(text, options, this.#options.clock.now());
    this.#kick();
    return new Synthesis(this.#host, core);
  }

  /** Queue `text`. It is sent once everything before it has finished. */
  enqueue(text: string, options: SynthesisOptions = {}): Synthesis {
    const core = this.#protocol.enqueue(text, options, this.#options.clock.now());
    this.#kick();
    return new Synthesis(this.#host, core);
  }

  /** Cancel the running synthesis, if any. Queued ones still play afterwards. Sends nothing when nothing is running. */
  cancel(): void {
    this.#protocol.cancelActive(this.#options.clock.now());
    this.#kick();
  }

  /** Barge-in: cancel the running synthesis and drop everything queued. Ends `speakStream()`. */
  interrupt(): void {
    this.#protocol.interrupt(this.#options.clock.now());
    this.#kick();
  }

  /**
   * Speak text as one continuous PCM stream, sentence by sentence.
   *
   * `texts` is a string, an iterable of texts, or an async iterable of text
   * deltas (for example from an LLM). Text is split into sentences of at most
   * 500 characters, queued in order, and the audio is yielded in order, at
   * `sampleRate`. `interrupt()` ends the stream; leaving the loop early cancels
   * what is left.
   */
  async *speakStream(texts: TextSource, options: SpeakStreamOptions = {}): AsyncGenerator<Uint8Array, void, undefined> {
    const { deltas, ...synthesis } = options;
    const protocol = this.#protocol;
    const handles: Synthesis[] = [];
    const generation = protocol.interrupts;
    let feedDone = false;
    let feedError: { error: unknown } | null = null;
    let stopped = false;
    const add = (sentences: string[]): void => {
      for (const sentence of sentences) handles.push(this.enqueue(sentence, synthesis));
    };

    const feed = async (): Promise<void> => {
      const splitter = new SentenceSplitter();
      try {
        if (typeof texts === 'string') add([...splitter.push(texts), ...splitter.flush()]);
        else if (isAsyncIterable(texts)) {
          for await (const item of texts) {
            if (stopped || protocol.interrupts !== generation) break;
            add(deltas === false ? [...splitter.push(item), ...splitter.flush()] : splitter.push(item));
          }
          if (!stopped) add(splitter.flush());
        } else {
          for (const item of texts) {
            if (stopped) break;
            add(deltas ? splitter.push(item) : [...splitter.push(item), ...splitter.flush()]);
          }
          if (!stopped) add(splitter.flush());
        }
      } catch (error) {
        feedError = { error };
      } finally {
        feedDone = true;
        this.#notify();
      }
    };

    void feed(); // never rejects; it stops at the next item once the stream ends
    try {
      while (protocol.interrupts === generation) {
        const head = handles[0];
        if (head !== undefined) {
          for await (const chunk of head) yield chunk;
          handles.shift();
          continue;
        }
        if (feedError !== null) throw (feedError as { error: unknown }).error;
        if (feedDone) break;
        await this.#changed.wait();
      }
    } finally {
      stopped = true;
      for (const handle of handles) handle.cancel();
    }
  }

  // --- Internals --------------------------------------------------------------------------

  #notify(): void {
    this.#changed.notify();
  }

  #kick(): void {
    this.#notify();
    this.#kickPump();
    this.#armTimer();
  }

  #cancelCore(core: SynthesisCore): void {
    this.#protocol.cancel(core, this.#options.clock.now());
    this.#kick();
  }

  #reconnect(signal?: AbortSignal): Promise<Link> {
    const link = this.#link;
    if (link !== null && !link.closed) return Promise.resolve(link);
    this.#connecting ??= this.#open(signal).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #open(signal?: AbortSignal): Promise<Link> {
    if (this.#closed) throw new SessionEndedError('the Text to Speech session is closed');
    const link = await openLink(this.#options, TTS_PATH, {}, {
      limiter: this.#limiter,
      waitForSlot: this.#waitForSlot,
      afterAbnormal: this.#protocol.afterAbnormal,
      signal: signal ? anySignal([signal, this.#abort.signal]) : this.#abort.signal,
    });
    if (this.#closed) {
      await link.close();
      throw new SessionEndedError('the Text to Speech session is closed');
    }
    const gen = this.#protocol.connGen;
    this.#link = link;
    this.handshakeRequestId = link.handshakeRequestId;
    this.#protocol.connectionOpened(this.#options.clock.now());
    link.attach({
      onText: (text) => this.#onText(gen, text),
      onBinary: (data) => this.#onBinary(gen, data),
      onClosed: (info) => this.#onClosed(gen, info),
    });
    this.#kick();
    return link;
  }

  #onText(gen: number, text: string): void {
    if (gen !== this.#protocol.connGen) return;
    const event = decodeEvent(text);
    if (event['type'] === 'pong') {
      this.#link?.pong();
      return;
    }
    this.#protocol.receiveEvent(event, this.#options.clock.now());
    this.#kick();
  }

  #onBinary(gen: number, data: Uint8Array): void {
    if (gen !== this.#protocol.connGen) return;
    this.#protocol.receiveBinary(data, this.#options.clock.now());
    this.#notify();
  }

  #onClosed(gen: number, info: CloseInfo): void {
    if (gen !== this.#protocol.connGen) return;
    this.#protocol.connectionClosed(info, this.#options.clock.now());
    this.#link = null;
    if (!info.local) this.#options.logger.info(`Text to Speech socket closed (code ${info.code}); it reopens when needed`);
    this.#kick();
  }

  #rotationDue(link: Link): boolean {
    return link.age(this.#options.clock.now()) >= this.#options.rotateAfter;
  }

  #kickPump(): void {
    if (this.#pumping) {
      this.#pumpAgain = true;
      return;
    }
    this.#pumping = true;
    void this.#pumpLoop();
  }

  async #pumpLoop(): Promise<void> {
    try {
      do {
        this.#pumpAgain = false;
        await this.#drain();
      } while (this.#pumpAgain && !this.#closed);
    } catch (error) {
      this.#options.logger.error('Text to Speech sender failed', error); // never stop all sending silently
    } finally {
      this.#pumping = false;
    }
  }

  async #drain(): Promise<void> {
    const protocol = this.#protocol;
    const { clock } = this.#options;
    for (;;) {
      if (this.#closed) return;
      const item = protocol.nextOutbound(clock.now());
      if (item === null) return;
      let link = this.#link;
      if (item.kind === 'synthesize') {
        if (link !== null && !link.closed && this.#rotationDue(link) && protocol.inFlight().length === 0) {
          await link.close(); // rotate: close first, so two of the workspace's slots are never held
          link = null;
        }
        if (link === null || link.closed) {
          try {
            link = await this.#reconnect();
          } catch (error) {
            if (this.#closed) {
              protocol.requeue(item, clock.now()); // ends it as cancelled
              this.#notify();
              return;
            }
            // Nothing was sent. A failure outside the SDK (say, the headers provider) fails this request too.
            const failure =
              error instanceof EchoNovaError
                ? error
                : new APIConnectionError(`could not open the stream: ${error instanceof Error ? error.message : String(error)}`, {
                    mayHaveExecuted: false,
                    cause: error,
                  });
            protocol.sendFailed(item, failure, clock.now());
            this.#notify();
            continue;
          }
        }
      }
      if (link === null || link.closed) {
        protocol.requeue(item, clock.now());
        continue;
      }
      if (!(await this.#send(link, item))) {
        await link.done;
        continue;
      }
      this.#kick();
    }
  }

  async #send(link: Link, item: Outbound): Promise<boolean> {
    const { clock } = this.#options;
    try {
      await link.send(outboundText(item), () => this.#protocol.sent(item, clock.now()));
      return true;
    } catch (error) {
      if (error instanceof LinkClosed) {
        this.#protocol.requeue(item, clock.now());
        return false;
      }
      throw error;
    }
  }

  #armTimer(): void {
    const { clock, rotateAfter } = this.#options;
    if (this.#timer !== null) clock.clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#closed) return;
    const now = clock.now();
    this.#protocol.tick(now);
    this.#notify();
    if (this.#protocol.hasOutbound()) this.#kickPump();
    const link = this.#link;
    if (link !== null && !link.closed && this.#protocol.idle && this.#rotationDue(link)) {
      this.#options.logger.debug('rotating an idle Text to Speech socket');
      void link.close(); // its close re-arms this timer
      return;
    }
    const deadlines: number[] = [];
    const protocolDeadline = this.#protocol.nextDeadline();
    if (protocolDeadline !== null) deadlines.push(protocolDeadline);
    if (link !== null && !link.closed) {
      // Once due, rotation waits for the socket to go idle; activity re-arms this timer.
      const rotation = link.openedAt + rotateAfter;
      if (rotation > now) deadlines.push(rotation);
    }
    if (deadlines.length === 0) return;
    const delay = Math.max(0, Math.min(...deadlines) - now) + 1;
    this.#timer = clock.setTimeout(() => {
      this.#timer = null;
      this.#armTimer();
    }, delay);
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return typeof value === 'object' && value !== null && typeof (value as AsyncIterable<string>)[Symbol.asyncIterator] === 'function';
}
