# 7. Streaming: charge-aware Text to Speech, Speech to Text sessions that never reconnect on their own

Date: 2026-11-09

## Status

Accepted. Amended 2026-11-10 for the published API update: partial billing of stopped syntheses, and stream sessions saved as jobs (`session.saved`).

## Context

The API has two WebSocket protocols, described in the published AsyncAPI spec.

**Text to Speech stream.**

- One socket carries many syntheses, one at a time. A new `synthesize` cancels the running one (barge-in).
- For each synthesis the server sends `start`, then binary PCM frames, then `done`. Binary frames carry no `requestId`.
- Each synthesis is charged per character when it starts. One that stops after its audio started (a cancel, a barge-in or a speech service failure) costs only the share of audio sent, at least 1 credit, and the rest is refunded. `cancelled` and `error` report the final `creditsConsumed`; a `cancelled` without it was cancelled before it was charged.

**Speech to Text stream.**

- The client sends PCM audio and receives a final transcript per segment.
- A segment ends when the client sends `end_segment`, or automatically every 15 seconds.
- Each segment is charged when its transcript is sent.

**Both streams.**

- Sessions have a maximum length (30 minutes for Text to Speech, 25 for Speech to Text) and an idle timeout.
- A workspace can have 10 streams open at once.

Connections drop. Reconnecting and resending looks helpful, but resending a synthesis can charge for it twice, and a Speech to Text reconnect starts a different session.

## Decision

### Rules for both streams

- **Handshake errors are classified like REST errors.** A rejected upgrade goes through the same classifier (ADR 0005), with `transport="websocket"`. This needs a WebSocket client that exposes the handshake response, so the SDKs use such clients (ADR 0009).
- **Handshake retries** follow the `WS` column of `spec/error-rules.json`: for example network failures, a throttle 429 with a short `Retry-After`, and 502 or 503 responses. Never 401, 402, 403, a spending-limit 429 or "Streaming is not enabled". A "Too many concurrent streams" 429 is retried only when the caller opts in with `wait_for_slot`.
- **Keepalive.** The SDK sends a JSON `ping` whenever it has sent nothing for 30 seconds. It raises `StreamConnectionLostError` if a `ping` gets no `pong` within 15 seconds, or if nothing at all arrives for 60 seconds. `keepalive=None` turns this off.
- **One reader per socket that never waits on the consumer**, so pongs and closes are handled on time. **One send lock.** Outgoing JSON frames are size-checked locally, so an oversized frame raises `UsageError` instead of closing the socket.
- **The close frame decides whether an error is fatal**, not the error event before it. For example, 1001 and 4008 allow a new session; 1008, 1009, 4002 and 4029 don't.
- Unknown event types become `UnknownEvent` and never raise.

### Text to Speech: correlation and charge state

- **The SDK always generates a `requestId`** (a UUID) for each synthesis.
- **Binary frames belong to the synthesis whose `start` came last** and that hasn't finished. Frames that arrive while no synthesis is active, or while one is being cancelled, are dropped and counted.
- `done` and `cancelled` are matched by `requestId`. Duplicates are ignored. When a newer `start` arrives, the older synthesis is marked `superseded`.
- `synthesize()` follows the server's semantics: it supersedes the running synthesis. `enqueue()` is a client-side queue: the next item is sent only after the current one is `done`, because sending it earlier would cancel the current one.
- `cancel()` on a request that was never sent is handled locally; nothing goes over the socket.
- Each synthesis handle moves through `QUEUED → SENT → STREAMING → COMPLETED`, or ends as `CANCELLED`, `FAILED` or `LOST`. A cancellation the caller asked for is an outcome, reported by `result()`, not an exception. Its result reports the final `credits_consumed` and `charged=True` when the server reports a cost, `charged=False` for a cancel that came before any charge, and `charged=None` when the SDK resolved the cancel itself before its audio started (an acknowledgement timeout or a lost socket).
- **When the connection is lost, each affected handle reports `charge_state`:**
  - `yes`: `start` or audio arrived, so the synthesis started and was charged.
  - `unknown`: it was sent, but nothing arrived for it. It may have started, and so it may already have been charged.
  - `no`: it was never sent.
- **The SDK never resends a synthesis that was sent but not started, because it may already have been charged.** It reports the outcome and the charge state, and the caller decides.
- The one automatic resend: when the server reports `upstream_error` for a synthesis before its `start` arrived, that synthesis never started, and the SDK resends it once. A conformance fixture pins this behaviour.
- Requests still queued locally (never sent) survive a reconnect and are sent normally.
- **The socket reconnects lazily**, on the next `synthesize()` after a close that allows it. Before the 30-minute limit, an idle session rotates its socket: it closes the old one first and then opens the new one, so it never holds two of the workspace's stream slots.

### Speech to Text: sessions never reconnect on their own

- An `SttSession` is one server session. A new connection would be a new session, with a new `sessionId`, no terminology and no open segment. So **`SttSession` never reconnects automatically.**
- `connect()` returns after `session.started`, and after `terminology.set` when terminology was given, so setup errors are raised from `connect()`.
- `sample_rate` is required and has no default, because a wrong rate produces wrong transcripts without any error.
- `send_audio()` goes through the PCM framer: frames of about 100 ms, never over 64 KiB, always an even number of bytes. It copies its input and waits for the socket to drain.
- `end_segment()` returns a mark with the audio offset, computed from the bytes the SDK sent.
- `stop()` waits for the remaining transcripts, `session.ended` and, when the server sends it, `session.saved`, which says whether the session was kept as a Speech to Text job (`job_id`, `saved` / `empty` / `failed`). `close()` aborts and discards audio that wasn't transcribed.
- **If a session ends abnormally, the event iterator first delivers every event already received, then raises.** Transcripts that were already sent, and charged, are never lost.

### Two layers: L0 sessions and L2 helpers built only on public L0 calls

- **L0** is the full protocol: `TtsSession` and `SttSession`.
- **L2** helpers make common tasks easy: `speak`, `speak_stream`, `transcribe_stream`, and for REST `jobs.wait`, `find_candidates`, page iteration and `download`.
- **L2 is built only from public L0 calls.** It uses no private hooks, so anything an L2 helper does, a caller can do with L0.

`transcribe_stream()` is the L2 helper for long or unreliable Speech to Text sources:

- It cuts segments itself, sending `end_segment` every 14 seconds of audio, just under the server's 15-second automatic cut. The SDK therefore knows exactly where every segment starts and ends.
- Before the 25-minute limit, it rolls over to a new session: it ends the current segment, stops, waits for `session.ended`, opens a new session and sends the terminology again. Audio that arrives during the handover is buffered and sent to the new session. It emits a `Reconnected(reason="rollover")` event and holds only one stream slot at a time.
- After a close that allows it (1001, 1006, 1011), it reconnects a limited number of times, sends the terminology again, and replays the audio sent since the last cut. That audio never produced a transcript, so under the published billing rule it wasn't charged.
- Segments that were cut but had no transcript yet are reported as `AudioDropped`, not resent, until the SDK can match results to cuts reliably.
- It never reconnects after 4002, 4029, 1008 or 1009.

## Consequences

- Callers always know whether a lost synthesis may have been charged, and the SDK never resends a synthesis that may have started.
- Voice agents get ordered audio from `enqueue()` and `speak_stream()`. There can be a short pause between queued sentences, because each one is sent only after the previous one finishes.
- Long Speech to Text sources keep working past the session limit through `transcribe_stream()`, while `SttSession` stays a predictable one-to-one view of a server session.
- The state machines have many paths. Every path is covered by recorded WebSocket transcripts in `spec/fixtures/ws/`, replayed by every SDK (ADR 0011).
- Streaming needs WebSocket clients that expose handshake responses, which limits the runtimes that support streaming (ADR 0009).
