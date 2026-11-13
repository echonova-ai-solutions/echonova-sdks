// Replays every recorded stream transcript in spec/fixtures/ws/ through the SDK's public session
// API (connectTts / connectStt), with a scripted transport playing the live server's side
// (ws-transport.ts). The SDK is driven to send the recorded client frames: synthesize, cancel,
// sendAudio, endSegment, setTerminology, stop, close, and pings through its keepalive. Each test
// then checks what the caller sees against spec/fixtures/expected.json.
import { describe, expect, it } from 'vitest';
import { ERROR_CLASSES, ProtocolError, SessionEndedError, UsageError, type ErrorClassName } from '../../src/errors.js';
import {
  connectStt,
  connectTts,
  MAX_FRAME_BYTES,
  PcmFramer,
  type SegmentMark,
  type SessionSummary,
  type StreamOptions,
  type StreamTerminology,
  type SttEvent,
  type SttSession,
  type Synthesis,
  type SynthesisOptions,
  type Transcript,
  type TtsSession,
} from '../../src/streaming/index.js';
import { caught } from '../rest-support.js';
import { FakeClock, FastRetry } from '../streaming/stream-helpers.js';
import { TEST_KEY } from '../helpers.js';
import { EXPECTED, fixtureNames, itCoversEveryFixture, readFixture, type WsExpectation } from './fixtures.js';
import { describeStep, planReplay, ReplayTransport, type ReplayPlan, type Step } from './ws-transport.js';

const KEEPALIVE = 30_000;
const PONG_TIMEOUT = 15_000;
const VOICE = '000000000000000000000001'; // a session voice when the recording synthesizes nothing
const SYNTHESIS_OPTIONS = new Set(['speed', 'cfg', 'numSteps', 'tashkeel', 'normalize']);
const HANDLED = new Set(['requests', 'session_error', 'handshake_error', 'pong', 'transcripts', 'ended', 'saved', 'events', 'note']);

function optionsFor(transport: ReplayTransport, clock: FakeClock, withKey: boolean): StreamOptions {
  return {
    wsBaseURL: 'wss://api.echonova.ai',
    headers: () => (withKey ? { Authorization: `Bearer ${TEST_KEY}` } : {}),
    userAgent: 'echonova-js/replay',
    retryPolicy: new FastRetry(),
    keepalive: KEEPALIVE,
    pongTimeout: PONG_TIMEOUT,
    clock,
    transport,
  };
}

/** One SDK call per recorded client frame; consecutive audio frames are one `sendAudio`. */
interface Action {
  step: Step;
  index: number;
  /** The call waits until the replay reaches here: the server events recorded before it were delivered. */
  after: number;
  audioBytes: number;
}

function actionsOf(plan: ReplayPlan): Action[] {
  const { steps } = plan;
  const actions: Action[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.dir !== 'out' || step.kind === 'connect' || (step.skip !== undefined && !step.perform)) continue;
    let after = i;
    while (after > 0 && steps[after - 1]!.dir !== 'in') after -= 1;
    let audioBytes = 0;
    if (step.kind === 'binary') {
      let j = i;
      for (; steps[j]?.dir === 'out' && steps[j]!.kind === 'binary' && steps[j]!.skip === undefined; j++) {
        audioBytes += steps[j]!.data.bytes as number;
      }
      i = j - 1;
    }
    actions.push({ step, index: steps.indexOf(step), after, audioBytes });
  }
  return actions;
}

/**
 * A ping goes out through the keepalive: nothing sent for 30 s. Once its pong is delivered, wait
 * past the pong timeout: a connection whose ping went unanswered is dropped by then.
 */
async function pingThroughKeepalive(transport: ReplayTransport, clock: FakeClock, index: number, alive: () => boolean): Promise<boolean> {
  await clock.advance(KEEPALIVE + 1);
  const pong = transport.steps.findIndex((s, i) => i > index && s.dir === 'in' && s.kind === 'json' && s.data.type === 'pong');
  await transport.reached(pong === -1 ? index + 1 : pong + 1);
  await clock.advance(PONG_TIMEOUT + 1);
  return alive();
}

const inbound = (plan: ReplayPlan, type: string): Array<Record<string, any>> =>
  plan.steps.filter((s) => s.dir === 'in' && s.kind === 'json' && s.data.type === type).map((s) => s.data);

function expectErrorClass(error: any, name: string): void {
  expect(ERROR_CLASSES[name as ErrorClassName], `unknown error class ${name}`).toBeDefined();
  expect(error).toBeInstanceOf(ERROR_CLASSES[name as ErrorClassName]);
  expect(error.name).toBe(name);
}

/** A refused handshake: the error connect raises carries the recorded status, message and request ID. */
async function checkHandshake(connecting: Promise<unknown>, plan: ReplayPlan, transport: ReplayTransport, name: string): Promise<void> {
  const error: any = await caught(connecting);
  const rejected = plan.steps.find((s) => s.kind === 'handshake_rejected');
  expect(rejected, 'a recorded handshake rejection').toBeDefined();
  const { status, headers, body } = rejected!.data;
  expectErrorClass(error, name);
  expect(error.statusCode).toBe(status);
  expect(error.errorMessage).toBe(body?.errorMessage ?? null);
  expect(error.requestId).toBe(headers['x-request-id']);
  expect(transport.opens).toHaveLength(1); // not retried
}

/** The error a policy close (1008) recorded: the server's error frame, then the close. */
function checkProtocolFailure(error: any, plan: ReplayPlan, name: string): void {
  const frame = inbound(plan, 'error').at(-1)!;
  const close = plan.steps.filter((s) => s.dir === 'in' && s.kind === 'close').at(-1)!.data;
  expectErrorClass(error, name);
  expect(error.closeCode).toBe(close.code);
  expect(error.errorCode).toBe(frame['code']);
  expect(error.errorMessage).toBe(frame['message']);
}

// --- Text to Speech ---------------------------------------------------------------------------

interface RecordedSynthesis {
  start: Record<string, any> | null;
  /** done, cancelled or error. */
  end: Record<string, any> | null;
  /** Audio bytes that arrived while it was the running request and the client still wanted it. */
  audio: number;
}

/** What each recorded request got, read off the recording. */
function recordedSyntheses(plan: ReplayPlan): Map<string, RecordedSynthesis> {
  const out = new Map<string, RecordedSynthesis>();
  const stopped = new Set<string>(); // the client cancelled or replaced it: later audio is dropped
  let active: string | null = null;
  for (const step of plan.steps) {
    const data = step.data ?? {};
    if (step.dir === 'out' && step.kind === 'json' && (data.type === 'synthesize' || data.type === 'cancel')) {
      for (const [rid, s] of out) if (s.end === null) stopped.add(rid);
      if (data.type === 'synthesize') out.set(data.requestId, { start: null, end: null, audio: 0 });
    } else if (step.dir === 'in' && step.kind === 'json' && out.has(data.requestId)) {
      const s = out.get(data.requestId)!;
      if (data.type === 'start') {
        s.start = data;
        active = data.requestId;
      } else if (['done', 'cancelled', 'error'].includes(data.type)) {
        s.end = data;
        if (active === data.requestId) active = null;
      }
    } else if (step.dir === 'in' && step.kind === 'binary' && active !== null && !stopped.has(active)) {
      out.get(active)!.audio += data.bytes;
    } else if (step.dir === 'in' && step.kind === 'close') {
      active = null;
    }
  }
  return out;
}

function synthesisOptions(frame: Record<string, unknown>, sessionVoice: string): SynthesisOptions {
  const { type: _type, requestId: _rid, text: _text, voiceId, ...rest } = frame;
  const options: Record<string, unknown> = {};
  const extraBody: Record<string, unknown> = {};
  if (voiceId !== sessionVoice) options['voiceId'] = voiceId;
  for (const [key, value] of Object.entries(rest)) {
    if (SYNTHESIS_OPTIONS.has(key)) options[key] = value;
    else extraBody[key] = value; // an unknown field goes through the escape hatch (tts/unknown_field)
  }
  if (Object.keys(extraBody).length > 0) options['extraBody'] = extraBody;
  return options as SynthesisOptions;
}

async function audioOf(synth: Synthesis): Promise<number> {
  let bytes = 0;
  try {
    for await (const chunk of synth) bytes += chunk.length;
  } catch {
    // a failed or lost synthesis yields what arrived, then throws its error (checked separately)
  }
  return bytes;
}

async function replayTts(plan: ReplayPlan, expected: WsExpectation, transport: ReplayTransport): Promise<void> {
  const clock = new FakeClock();
  const connect = plan.steps[0]!.data;
  const voiceId: string = plan.steps.find((s) => s.dir === 'out' && s.kind === 'json' && s.data.type === 'synthesize')?.data.voiceId ?? VOICE;
  const connecting = connectTts(optionsFor(transport, clock, connect.authorization === 'set'), { voiceId });
  if (expected.handshake_error !== undefined) {
    await checkHandshake(connecting, plan, transport, expected.handshake_error);
    return;
  }

  const tts = await connecting;
  try {
    await driveTts(plan, expected, transport, clock, tts, voiceId);
  } finally {
    await tts.close();
  }
}

async function driveTts(
  plan: ReplayPlan,
  expected: WsExpectation,
  transport: ReplayTransport,
  clock: FakeClock,
  tts: TtsSession,
  voiceId: string,
): Promise<void> {
  const syntheses = new Map<string, Synthesis>();
  const pending: Array<Promise<unknown>> = [];
  let pongAnswered: boolean | null = null;
  for (const action of actionsOf(plan)) {
    await transport.reached(action.after);
    const { step } = action;
    const kind = step.kind === 'json' ? step.data.type : step.kind;
    if (kind === 'synthesize') syntheses.set(step.data.requestId, tts.synthesize(step.data.text, synthesisOptions(step.data, voiceId)));
    else if (kind === 'cancel') tts.cancel();
    else if (kind === 'ping') pongAnswered = await pingThroughKeepalive(transport, clock, action.index, () => tts.connected);
    else if (kind === 'close') pending.push(tts.close());
    else throw new Error(`no Text to Speech call sends ${describeStep(step)}`);
  }
  await transport.finished();
  await Promise.all(pending);

  const recorded = recordedSyntheses(plan);
  expect(Object.keys(expected.requests ?? {}).sort(), 'expected.json names every recorded request').toEqual([...recorded.keys()].sort());
  expect([...transport.ids.keys()].sort()).toEqual([...recorded.keys()].sort());
  for (const [rid, outcome] of Object.entries(expected.requests ?? {})) {
    const synth = syntheses.get(rid)!;
    const record = recorded.get(rid)!;
    expect(synth.requestId, `${rid} is the SDK's own ID`).toBe(transport.ids.get(rid));
    const [want, errorClass] = outcome.split(':') as [string, string | undefined];
    if (errorClass === undefined) {
      const result = await synth.result;
      expect(result.outcome, rid).toBe(want);
      expect(result.requestId).toBe(synth.requestId);
      if (want === 'completed') {
        expect(result.durationSeconds).toBe(record.end!['durationSeconds']);
        expect(result.characters).toBe(record.end!['characters']);
        expect(record.audio, 'a completed synthesis recorded audio').toBeGreaterThan(0);
      }
    } else {
      const error = await caught(synth.result);
      expect(synth.state, rid).toBe(want);
      expectErrorClass(error, errorClass);
    }
    // Audio: everything recorded for it while the caller still wanted it, and nothing after.
    expect(await audioOf(synth), `${rid} audio bytes`).toBe(record.audio);
    const credits = typeof record.end?.['creditsConsumed'] === 'number' ? record.end['creditsConsumed'] : null;
    expect(synth.creditsConsumed, `${rid} credits`).toBe(credits);
    if (credits !== null) expect(synth.charged, `${rid} charged`).toBe(true);
    expect(synth.chargeState, `${rid} charge state`).toBe(
      record.start !== null || credits !== null ? 'yes' : record.end !== null ? 'no' : 'unknown',
    );
    if (record.start !== null) expect(synth.sampleRate).toBe(record.start['sampleRate']);
  }

  if (expected.session_error !== undefined) {
    // The server closed the session (1008). Every later call raises SessionEndedError, caused by that error.
    let thrown: any = null;
    try {
      tts.synthesize('after the close');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SessionEndedError);
    checkProtocolFailure(thrown.cause, plan, expected.session_error);
  }
  if (expected.pong !== undefined) expect(pongAnswered).toBe(expected.pong);
}

// --- Speech to Text ---------------------------------------------------------------------------

async function replayStt(plan: ReplayPlan, expected: WsExpectation, transport: ReplayTransport): Promise<void> {
  const clock = new FakeClock();
  const connect = plan.steps[0]!.data;
  const query = new URL(connect.path, 'wss://api.echonova.ai').searchParams;
  const sampleRate = Number(query.get('sample_rate') ?? 16_000);
  // The SDK requires a language; a recording without one (handshake_missing_language) replays the server's answer only.
  const language = query.get('language') ?? 'ar';
  const options = optionsFor(transport, clock, connect.authorization === 'set');
  const connecting = connectStt(options, { sampleRate, language });
  if (expected.handshake_error !== undefined) {
    await checkHandshake(connecting, plan, transport, expected.handshake_error);
    if (!query.has('language')) {
      await expect(connectStt(options, { sampleRate, language: '' })).rejects.toThrow(UsageError);
    }
    return;
  }

  const stt = await connecting;
  try {
    await driveStt(plan, expected, transport, clock, stt);
  } finally {
    await stt.close();
  }
}

async function driveStt(plan: ReplayPlan, expected: WsExpectation, transport: ReplayTransport, clock: FakeClock, stt: SttSession): Promise<void> {
  const marks: Array<Promise<SegmentMark>> = [];
  const pending: Array<Promise<unknown>> = [];
  const terminology: Array<Promise<string>> = [];
  let stopping: Promise<SessionSummary> | null = null;
  let pongAnswered: boolean | null = null;
  for (const action of actionsOf(plan)) {
    await transport.reached(action.after);
    const { step } = action;
    const kind = step.kind === 'json' ? step.data.type : step.kind;
    if (kind === 'binary') {
      pending.push(stt.sendAudio(new Uint8Array(action.audioBytes))); // zero-filled PCM of the recorded size
    } else if (kind === 'end_segment') {
      marks.push(stt.endSegment());
    } else if (kind === 'terminology') {
      // {keywords: 5} is deliberately invalid; the SDK passes terminology through, so a cast sends it.
      const terms = step.data.terminology as StreamTerminology | null;
      terminology.push(stt.setTerminology(terms).then((set) => `${set.type}:${set.active}`, (error: Error) => `error:${error.name}`));
    } else if (kind === 'stop') {
      stopping = stt.stop();
      stopping.catch(() => {}); // checked below
    } else if (kind === 'ping') {
      pongAnswered = await pingThroughKeepalive(transport, clock, action.index, () => !stt.closed);
    } else if (kind === 'close') {
      pending.push(stt.close());
    } else {
      throw new Error(`no Speech to Text call sends ${describeStep(step)}`);
    }
  }
  await transport.finished();
  await Promise.all(pending);
  expect(stt.closed, 'the recording ends with the socket closed').toBe(true);

  const events: SttEvent[] = [];
  let failure: unknown = null;
  try {
    for await (const event of stt) events.push(event);
  } catch (error) {
    failure = error;
  }

  // Transcripts: each recorded one, in the order it arrived, with its text, duration and credits.
  const recordedTranscripts = inbound(plan, 'transcript');
  const transcripts = events.filter((e): e is Transcript => e.type === 'transcript');
  expect(transcripts.map((t) => t.raw)).toStrictEqual(recordedTranscripts);
  expect(transcripts.map((t) => t.index)).toStrictEqual(recordedTranscripts.map((_, i) => i));
  expect(transcripts.map((t) => t.creditsConsumed)).toStrictEqual(recordedTranscripts.map((t) => t['creditsConsumed']));
  if (expected.transcripts === 'in order') {
    expect(transcripts.length).toBeGreaterThan(1);
    expect(transcripts.map((t) => t.segmentId)).toStrictEqual(recordedTranscripts.map((t) => t['segmentId']));
  } else if (expected.transcripts !== undefined) {
    expect(transcripts).toHaveLength(expected.transcripts);
  }
  // The SDK never waits for a transcript the server doesn't send (empty and very short segments).
  const cuts = await Promise.all(marks);
  expect(cuts.filter((m) => m.expectResult).length).toBeLessThanOrEqual(transcripts.length);

  const recordedEnded = inbound(plan, 'session.ended').at(0);
  const recordedSaved = inbound(plan, 'session.saved').at(0);
  if (expected.ended !== undefined) {
    expect(stopping, 'the recording stops the session').not.toBeNull();
    const summary = await stopping!;
    expect(summary.reason).toBe(expected.ended);
    expect(events.find((e) => e.type === 'session.ended')).toMatchObject({ reason: expected.ended });
    expect(summary.totalSeconds).toBe(recordedEnded!['totalSeconds']);
    expect(summary.creditsConsumed).toBe(recordedEnded!['creditsConsumed']);
    expect(summary.savedStatus).toBe(recordedSaved?.['status'] ?? null);
  }
  if (expected.saved !== undefined) {
    const saved = events.find((e) => e.type === 'session.saved');
    expect(saved !== undefined && typeof saved.jobId === 'string' && saved.jobId !== '').toBe(expected.saved);
    if (expected.saved) {
      expect(saved).toMatchObject({ jobId: recordedSaved!['jobId'], status: recordedSaved!['status'] });
      expect(stt.jobId).toBe(recordedSaved!['jobId']);
    }
  }
  if (expected.events !== undefined) {
    // What the caller sees: each setTerminology call resolves with terminology.set or raises the rejection.
    const seen = (await Promise.all(terminology)).map((s) => (s.startsWith('terminology.set') ? 'terminology.set' : s));
    expect(seen).toStrictEqual(expected.events);
    const recordedSets = inbound(plan, 'terminology.set').map((s) => `terminology.set:${s['active']}`);
    expect((await Promise.all(terminology)).filter((s) => s.startsWith('terminology.set'))).toStrictEqual(recordedSets);
  }

  if (expected.session_error !== undefined) {
    checkProtocolFailure(stt.failure, plan, expected.session_error);
    expect(failure, 'iterating raises the session error after the buffered events').toBe(stt.failure);
    await expect(stt.stop()).rejects.toBe(stt.failure);
  } else {
    expect(stt.failure).toBeNull();
    expect(failure).toBeNull();
  }
  if (expected.pong !== undefined) expect(pongAnswered).toBe(expected.pong);
}

// --- The replay -------------------------------------------------------------------------------

const label = (name: string): string => {
  const expected = EXPECTED.ws[name];
  if (expected === undefined) return 'NO EXPECTATION';
  return Object.entries(expected)
    .filter(([key]) => key !== 'note')
    .map(([key, value]) => `${key} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(', ');
};

describe('WebSocket replay of the recorded fixtures', () => {
  itCoversEveryFixture('ws');

  it.each(fixtureNames('ws').map((name) => [name, label(name)] as const))('%s: %s', async (name) => {
    const expected = EXPECTED.ws[name];
    expect(expected, `no entry in expected.json for ${name}`).toBeDefined();
    expect(Object.keys(expected!).filter((key) => !HANDLED.has(key)), 'expectation keys this replay understands').toEqual([]);
    const plan = planReplay(name, readFixture('ws', name));
    const transport = new ReplayTransport(plan);

    expect(plan.steps[0]?.kind, 'a recording starts with the connection').toBe('connect');
    if (plan.stream === 'tts') await replayTts(plan, expected!, transport);
    else await replayStt(plan, expected!, transport);

    expect(transport.problems, 'where the SDK departed from the recording').toEqual([]);
    expect(transport.pos, 'the whole recording was played').toBe(plan.steps.length);
    expect(transport.extrasSent, 'frames the SDK sends beyond the recording').toStrictEqual(plan.extras);
  });

  it('frames 70,000 bytes of audio in frames the server accepts (why stt/frame_too_large replays the server only)', () => {
    const frames = new PcmFramer(16_000).push(new Uint8Array(70_000));
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.length <= MAX_FRAME_BYTES)).toBe(true);
  });
});

describe('the replay plan', () => {
  // A new recording that needs the replay to depart from it shows up here, to be reviewed.
  it('departs from the recordings only in these reviewed places', () => {
    const departures = Object.fromEntries(
      fixtureNames('ws')
        .map((name) => [name, planReplay(name, readFixture('ws', name))] as const)
        .filter(([, plan]) => plan.adaptations.length > 0)
        .map(([name, plan]) => [name, plan.adaptations.map((a) => a.replace(/ \(line \d+\)/g, ''))]),
    );
    expect(departures).toStrictEqual({
      'stt/audio_before_started': ['in json session.started delivered right after the handshake: connect() waits for it'],
      'stt/frame_too_large': ['out binary: the SDK sends audio in frames of at most 65536 bytes'],
      'stt/ping': ['in json session.started delivered right after the handshake: connect() waits for it'],
      'tts/binary_frame': ['out binary: the SDK never sends binary frames on the Text to Speech stream'],
      'tts/cancel_while_idle': ['out json cancel: the SDK sends no cancel when nothing is in flight'],
      'tts/drop_mid_stream': ['out abort: the recorder dropped the connection here: the replay drops it with the recorded 1006 close'],
      'tts/invalid_json': ['out text: the SDK sends only JSON objects'],
      'tts/invalid_while_running': ['after in json error the SDK cancels r1, which the recorded client did not'],
    });
  });
});
