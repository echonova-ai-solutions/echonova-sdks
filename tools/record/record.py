#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx>=0.27,<1", "websockets>=14"]
# ///
"""Record live EchoNova API traffic as scrubbed fixtures (SDK plan, milestone M1).

This calls the real API and COSTS CREDITS. Use the dedicated test workspace only.

Environment:
  ECHONOVA_API_KEY        full-access test key, with a Credit Limit set (required)
  ECHONOVA_TTS_ONLY_KEY   a key limited to Text to Speech (optional: 403 fixtures)
  ECHONOVA_DISABLED_KEY   a disabled key (optional: 401 fixtures)
  ECHONOVA_AGENT_ID       an agent in the test workspace (optional: agent-session fixtures; starts and
                          immediately ends one chat session, which uses workspace credits)
  ECHONOVA_BASE_URL       defaults to https://api.echonova.ai

Commands (run from the repo root):
  uv run tools/record/record.py audio        # test audio: TTS + ffmpeg into every STT format (~150 credits)
  uv run tools/record/record.py rest         # REST success and error fixtures (~400 credits)
  uv run tools/record/record.py tts-stream   # TTS WebSocket transcripts (~500 credits)
  uv run tools/record/record.py stt-stream   # STT WebSocket transcripts (~300 credits)
  uv run tools/record/record.py promote      # leak-check out/ and copy into spec/fixtures/

Add --slow to also record the 120-second idle timeouts (free, but slow).
Output goes to tools/record/out/ (git-ignored). Review it before `promote`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import websockets
from websockets.asyncio.client import connect as ws_connect

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrub import Scrubber, find_leaks  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "out"
AUDIO = OUT / "audio"
FIXTURES = ROOT / "spec" / "fixtures"
BASE_URL = os.environ.get("ECHONOVA_BASE_URL", "https://api.echonova.ai").rstrip("/")
WS_URL = BASE_URL.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
USER_AGENT = "echonova-sdks-recorder/1"

ARABIC_TEXT = "مرحبا بكم في إيكونوفا. هذا اختبار قصير لتحويل الكلام إلى نص."
ENGLISH_TEXT = "Welcome to EchoNova. This is a short speech to text test."
LONG_TEXT = (
    "هذا نص طويل نسبيا لاختبار البث، نستخدمه لنتأكد من أن الصوت يصل على دفعات متتالية، "
    "وأن الإلغاء والاستبدال يعملان كما هو موثق، قبل أن تنتهي القراءة بالكامل."
)
STT_FORMATS = {
    # extension: (ffmpeg args, content type the SDK will send)
    "wav": (["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"], "audio/wav"),
    "mp3": (["-c:a", "libmp3lame", "-b:a", "64k"], "audio/mpeg"),
    "flac": (["-c:a", "flac"], "audio/flac"),
    "ogg": (["-c:a", "libvorbis"], "audio/ogg"),
    "opus": (["-c:a", "libopus", "-b:a", "32k"], "audio/opus"),
    "m4a": (["-c:a", "aac", "-b:a", "64k"], "audio/mp4"),
    "aac": (["-c:a", "aac", "-b:a", "64k", "-f", "adts"], "audio/aac"),
    "webm": (["-c:a", "libopus", "-b:a", "32k"], "audio/webm"),
    "amr": (["-ar", "8000", "-ac", "1", "-c:a", "libopencore_amrnb", "-b:a", "12.2k"], "audio/amr"),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def require_key(name: str = "ECHONOVA_API_KEY", *, optional: bool = False) -> str | None:
    value = os.environ.get(name, "").strip()
    if not value and not optional:
        sys.exit(f"{name} is not set. Use a key from the dedicated test workspace.")
    return value or None


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


# --- REST -------------------------------------------------------------------------------------------


class RestRecorder:
    def __init__(self, key: str) -> None:
        self.key = key
        self.http = httpx.Client(base_url=BASE_URL, timeout=httpx.Timeout(600, connect=10),
                                 headers={"User-Agent": USER_AGENT})
        self.count = 0

    def call(self, fixture: str, method: str, path: str, *, key: str | None = "default",
             expect: int | None = None, **kwargs: Any) -> httpx.Response:
        headers = dict(kwargs.pop("headers", {}))
        token = self.key if key == "default" else key
        if token:
            headers["Authorization"] = f"Bearer {token}"
        files = kwargs.get("files")
        started = time.monotonic()
        response = self.http.request(method, path, headers=headers, **kwargs)
        elapsed = round(time.monotonic() - started, 3)

        s = Scrubber()
        request: dict[str, Any] = {"method": method, "path": s.text(path)}
        if kwargs.get("params"):
            request["query"] = s.value(kwargs["params"])
        if kwargs.get("json") is not None:
            request["json"] = s.value(kwargs["json"])
        if kwargs.get("content") is not None:
            request["content"] = {"bytes": len(kwargs["content"]), "content_type": headers.get("Content-Type")}
        if kwargs.get("data"):
            request["form"] = s.value(kwargs["data"])
        if files:
            name, (filename, blob, content_type) = next(iter(files.items()))
            request["file"] = {"field": name, "filename": filename, "content_type": content_type, "bytes": len(blob)}
        request["authorization"] = "none" if not token else ("test key" if key == "default" else "other key")
        if "Idempotency-Key" in headers:
            request["idempotency_key"] = s.text(headers["Idempotency-Key"])  # a UUID: becomes a placeholder

        content_type = response.headers.get("content-type", "")
        body: dict[str, Any]
        if "json" in content_type:
            try:
                body = {"json": s.value(response.json())}
            except ValueError:
                body = {"text": s.text(response.text)}
        elif content_type.startswith("text/") or "subrip" in content_type:
            body = {"text": s.text(response.text)}
        else:
            body = {"bytes": len(response.content), "content_type": content_type}

        record = {
            "name": fixture,
            "recorded_at": now_iso(),
            "elapsed_seconds": elapsed,
            "request": request,
            "response": {"status": response.status_code, "headers": s.headers(response.headers), **body},
        }
        if expect is not None and response.status_code != expect:
            record["note"] = f"expected {expect}"
            print(f"  ! {fixture}: got {response.status_code}, expected {expect}")
        write_json(OUT / "rest" / f"{fixture}.json", record)
        self.count += 1
        print(f"  {response.status_code} {method} {path.split('?')[0]} -> {fixture}")
        return response

    def poll(self, fixture: str, path: str, *, every: float) -> dict[str, Any]:
        first = True
        for _ in range(int(900 / every)):
            response = self.call(f"{fixture}_{'processing' if first else 'final'}", "GET", path)
            data = response.json().get("data") or {}
            if data.get("status") in ("completed", "failed"):
                return data
            first = False
            time.sleep(every)
        raise TimeoutError(f"{path} did not finish")


def audio_file(ext: str, language: str = "ar") -> tuple[str, bytes, str]:
    path = AUDIO / f"{language}.{ext}"
    if not path.exists():
        sys.exit(f"missing {path}: run the `audio` command first")
    return path.name, path.read_bytes(), STT_FORMATS[ext][1]


def pick_voices(rec: RestRecorder) -> dict[str, str]:
    voices = rec.call("tts/voices_list", "GET", "/v1/text-to-speech/voices").json()["data"]["items"]
    chosen = {}
    for language in ("ar", "en"):
        match = next((v for v in voices if v.get("language") == language), None)
        if match:
            chosen[language] = match["id"]
    return chosen


def cmd_audio(_: argparse.Namespace) -> None:
    key = require_key()
    assert key
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is required for the audio command")
    rec = RestRecorder(key)
    voices = pick_voices(rec)
    AUDIO.mkdir(parents=True, exist_ok=True)
    download = httpx.Client(timeout=60, headers={"User-Agent": USER_AGENT})  # no Authorization to storage
    for language, text in (("ar", ARABIC_TEXT), ("en", ENGLISH_TEXT)):
        response = rec.call(f"tts/sync_ok_{language}", "POST", "/v1/text-to-speech/sync",
                            json={"text": text, "voiceId": voices[language]}, expect=200)
        source = AUDIO / f"{language}.source.wav"
        source.write_bytes(download.get(response.json()["data"]["audioUrl"]).raise_for_status().content)
        for ext, (args, _) in STT_FORMATS.items():
            target = AUDIO / f"{language}.{ext}"
            done = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), *args, str(target)],
                                  check=False)
            if done.returncode != 0:
                print(f"  ! ffmpeg could not make {target.name} (missing encoder?)")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-ar", "16000", "-ac", "1",
                        "-f", "s16le", str(AUDIO / f"{language}.16k.pcm")], check=True)
    print(f"audio written to {AUDIO}")


def cmd_rest(_: argparse.Namespace) -> None:
    key = require_key()
    assert key
    rec = RestRecorder(key)
    voices = pick_voices(rec)
    ar = voices["ar"]
    tts = "/v1/text-to-speech"
    stt = "/v1/speech-to-text"
    clean = "/v1/sound-cleaning"

    print("Text to Speech")
    rec.call("tts/sync_ok", "POST", f"{tts}/sync", json={"text": ARABIC_TEXT, "voiceId": ar}, expect=200)
    # ADR 0014: the same Idempotency-Key returns the first result without a second charge; reused for
    # different text, it is refused.
    key = str(uuid.uuid4())
    for fixture in ("tts/sync_idempotent_first", "tts/sync_idempotent_repeat"):
        rec.call(fixture, "POST", f"{tts}/sync", json={"text": "مرحبا", "voiceId": ar},
                 headers={"Idempotency-Key": key}, expect=200)
    rec.call("tts/sync_idempotency_key_reused", "POST", f"{tts}/sync", json={"text": "أهلاً", "voiceId": ar},
             headers={"Idempotency-Key": key}, expect=409)
    rec.call("tts/sync_text_too_long", "POST", f"{tts}/sync", json={"text": "ا" * 501, "voiceId": ar}, expect=400)
    rec.call("tts/sync_voice_not_found", "POST", f"{tts}/sync",
             json={"text": "مرحبا", "voiceId": "000000000000000000000000"}, expect=404)
    rec.call("tts/sync_unknown_field", "POST", f"{tts}/sync", json={"text": "مرحبا", "voiceId": ar, "foo": 1},
             expect=400)
    rec.call("tts/sync_not_json", "POST", f"{tts}/sync", content=b"hello", headers={"Content-Type": "text/plain"},
             expect=415)
    created = rec.call("tts/job_create", "POST", tts, json={"text": ENGLISH_TEXT, "voiceId": voices["en"]},
                       expect=200).json()["data"]
    job = created["jobId"]
    rec.call("tts/job_delete_while_processing", "DELETE", f"{tts}/jobs/{job}", expect=400)
    rec.poll("tts/job_get", f"{tts}/jobs/{job}", every=3)
    rec.call("tts/jobs_list", "GET", f"{tts}/jobs", params={"limit": 2, "offset": 0}, expect=200)
    rec.call("tts/jobs_list_limit_too_big", "GET", f"{tts}/jobs", params={"limit": 101}, expect=400)
    rec.call("tts/job_get_invalid_id", "GET", f"{tts}/jobs/not-an-id", expect=400)
    rec.call("tts/job_delete", "DELETE", f"{tts}/jobs/{job}", expect=200)
    rec.call("tts/job_get_deleted", "GET", f"{tts}/jobs/{job}", expect=404)

    print("Speech to Text")
    terminology = json.dumps({"keywords": ["EchoNova", {"term": "KYC", "variants": ["كي واي سي"]}]})
    rec.call("stt/sync_ok_terminology", "POST", f"{stt}/sync", files={"file": audio_file("wav")},
             data={"language": "ar", "terminology": terminology}, expect=200)
    rec.call("stt/sync_ok_speakers", "POST", f"{stt}/sync", files={"file": audio_file("wav", "en")},
             data={"language": "en", "identify_speakers": "true"}, expect=200)
    for ext in STT_FORMATS:
        if (AUDIO / f"ar.{ext}").exists():
            rec.call(f"stt/sync_format_{ext}", "POST", f"{stt}/sync", files={"file": audio_file(ext)},
                     data={"language": "ar"}, expect=200)
    name, blob, _ = audio_file("mp3")
    rec.call("stt/sync_octet_stream_mp3", "POST", f"{stt}/sync",
             files={"file": (name, blob, "application/octet-stream")}, data={"language": "ar"}, expect=400)
    # Since 2026-11-15 language is optional: without it the API detects Arabic or English (auto).
    rec.call("stt/sync_auto_language", "POST", f"{stt}/sync", files={"file": audio_file("wav")}, expect=200)
    rec.call("stt/sync_bad_terminology", "POST", f"{stt}/sync", files={"file": audio_file("wav")},
             data={"language": "ar", "terminology": "{\"keywords\": 5}"}, expect=400)
    created = rec.call("stt/job_create", "POST", stt, files={"file": audio_file("wav")},
                       data={"language": "ar", "identify_speakers": "true"}, expect=200).json()["data"]
    job = created["jobId"]
    rec.call("stt/job_export_not_completed", "GET", f"{stt}/jobs/{job}/export", params={"format": "txt"})
    rec.poll("stt/job_get", f"{stt}/jobs/{job}", every=5)
    for fmt in ("txt", "srt", "json"):
        rec.call(f"stt/job_export_{fmt}", "GET", f"{stt}/jobs/{job}/export", params={"format": fmt}, expect=200)
    rec.call("stt/job_export_ar_labels", "GET", f"{stt}/jobs/{job}/export", params={"format": "srt", "lang": "ar"},
             expect=200)
    rec.call("stt/job_export_bad_format", "GET", f"{stt}/jobs/{job}/export", params={"format": "vtt"}, expect=400)
    rec.call("stt/jobs_list", "GET", f"{stt}/jobs", params={"limit": 2}, expect=200)
    rec.call("stt/job_delete", "DELETE", f"{stt}/jobs/{job}", expect=200)

    print("Sound Cleaning")
    cleaned = rec.call("clean/clean_ok", "POST", clean, files={"file": audio_file("wav")},
                       data={"targetLufs": "-16", "sampleRate": "48000", "bitDepth": "24"}, expect=200).json()["data"]
    rec.call("clean/clean_option_out_of_range", "POST", clean, files={"file": audio_file("wav")},
             data={"targetLufs": "0"}, expect=400)
    rec.call("clean/clean_unknown_field", "POST", clean, files={"file": audio_file("wav")}, data={"foo": "1"},
             expect=400)
    name, blob, _ = audio_file("wav")
    # The docs say the type must match the extension, but the API accepted this (recorded 2026-11-13).
    rec.call("clean/clean_mime_mismatch", "POST", clean, files={"file": (name, blob, "audio/mpeg")}, expect=200)
    rec.call("clean/jobs_list", "GET", f"{clean}/jobs", params={"limit": 2}, expect=200)
    rec.call("clean/job_get", "GET", f"{clean}/jobs/{cleaned['id']}", expect=200)
    rec.call("clean/job_delete", "DELETE", f"{clean}/jobs/{cleaned['id']}", expect=200)

    if agent := require_key("ECHONOVA_AGENT_ID", optional=True):
        print("Agent sessions")
        agents = f"/v1/agents/{agent}/sessions"
        started = rec.call("agents/session_start_chat", "POST", agents, json={"channel": "chat"}, expect=200)
        session = (started.json().get("data") or {}).get("id")
        if session:
            rec.call("agents/session_get", "GET", f"{agents}/{session}", expect=200)
            rec.call("agents/session_end", "POST", f"{agents}/{session}/end", expect=200)
            rec.call("agents/session_end_again", "POST", f"{agents}/{session}/end", expect=200)
        rec.call("agents/session_start_unknown_agent", "POST", "/v1/agents/000000000000000000000000/sessions",
                 json={"channel": "chat"}, expect=404)

    print("Authentication")
    rec.call("auth/missing_key", "GET", f"{tts}/voices", key=None, expect=401)
    if disabled := require_key("ECHONOVA_DISABLED_KEY", optional=True):
        rec.call("auth/disabled_key", "GET", f"{tts}/voices", key=disabled, expect=401)
    if tts_only := require_key("ECHONOVA_TTS_ONLY_KEY", optional=True):
        rec.call("auth/key_without_service", "GET", f"{stt}/jobs", key=tts_only, expect=403)
    print(f"{rec.count} REST fixtures in {OUT / 'rest'}")


# --- WebSocket --------------------------------------------------------------------------------------


class Transcript:
    """Records one WebSocket session as JSON lines. Binary audio is stored as length + nothing else."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.lines: list[dict[str, Any]] = []
        self.started = time.monotonic()
        self.inbound: list[dict[str, Any]] = []
        self.scrubber = Scrubber()

    def add(self, direction: str, kind: str, data: Any) -> None:
        line = {"t": round(time.monotonic() - self.started, 3), "dir": direction, "kind": kind,
                "data": self.scrubber.value(data)}
        self.lines.append(line)
        if direction == "in":
            self.inbound.append({"kind": kind, "data": data})

    def save(self) -> None:
        path = OUT / "ws" / f"{self.name}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(json.dumps(line, ensure_ascii=False) for line in self.lines) + "\n",
                        encoding="utf-8")
        summary = ", ".join(
            line["data"].get("type", "?") if line["kind"] == "json" else line["kind"]
            for line in self.lines if line["dir"] == "in" and line["kind"] != "binary"
        )
        print(f"  {self.name}: {summary}")


class WsSession:
    def __init__(self, transcript: Transcript, ws: Any) -> None:
        self.t = transcript
        self.ws = ws
        self.reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        try:
            async for message in self.ws:
                if isinstance(message, bytes):
                    self.t.add("in", "binary", {"bytes": len(message)})
                else:
                    try:
                        self.t.add("in", "json", json.loads(message))
                    except ValueError:
                        self.t.add("in", "text", {"text": message})
        except websockets.ConnectionClosed:
            pass
        self.t.add("in", "close", {"code": self.ws.close_code, "reason": self.ws.close_reason})

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.t.add("out", "json", payload)
        await self.ws.send(json.dumps(payload, ensure_ascii=False))

    async def send_text(self, text: str) -> None:
        self.t.add("out", "text", {"text": text})
        await self.ws.send(text)

    async def send_audio(self, pcm: bytes, *, chunk: int = 3200, realtime: float = 0.0) -> None:
        for start in range(0, len(pcm), chunk):
            frame = pcm[start:start + chunk]
            self.t.add("out", "binary", {"bytes": len(frame)})
            await self.ws.send(frame)
            if realtime:
                await asyncio.sleep(realtime)

    async def wait_for(self, predicate: Callable[[dict[str, Any]], bool], timeout: float = 30) -> bool:
        deadline = time.monotonic() + timeout
        seen = 0
        while time.monotonic() < deadline:
            for item in self.t.inbound[seen:]:
                if predicate(item):
                    return True
            seen = len(self.t.inbound)
            if self.reader.done():
                return False
            await asyncio.sleep(0.02)
        self.t.add("note", "timeout", {"waited_seconds": timeout})
        return False

    async def wait_type(self, kind: str, timeout: float = 30, **fields: Any) -> bool:
        return await self.wait_for(
            lambda m: m["kind"] == "json" and m["data"].get("type") == kind
            and all(m["data"].get(k) == v for k, v in fields.items()), timeout)

    async def close(self, code: int = 1000) -> None:
        self.t.add("out", "close", {"code": code})
        await self.ws.close(code)
        await asyncio.wait_for(self.reader, 15)

    async def abort(self) -> None:
        self.t.add("out", "abort", {})
        self.ws.transport.abort()
        await asyncio.wait_for(self.reader, 15)


async def open_session(name: str, path: str, key: str | None) -> tuple[Transcript, WsSession | None]:
    transcript = Transcript(name)
    headers = {"User-Agent": USER_AGENT}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    transcript.add("out", "connect", {"path": path, "authorization": "set" if key else "none"})
    try:
        ws = await ws_connect(WS_URL + path, additional_headers=headers, max_size=16 * 2**20, ping_interval=None,
                              open_timeout=10)
    except websockets.InvalidStatus as exc:
        response = exc.response
        body: Any = response.body.decode("utf-8", errors="replace") if response.body else None
        try:
            body = json.loads(body) if body else None
        except ValueError:
            pass
        transcript.add("in", "handshake_rejected", {"status": response.status_code,
                                                    "headers": transcript.scrubber.headers(response.headers),
                                                    "body": body})
        return transcript, None
    transcript.add("in", "open", {})
    return transcript, WsSession(transcript, ws)


async def run_tts(args: argparse.Namespace) -> None:
    key = require_key()
    assert key
    voice = pick_voices(RestRecorder(key))["ar"]
    path = "/v1/text-to-speech/stream"

    def synth(rid: str, text: str = ARABIC_TEXT, **extra: Any) -> dict[str, Any]:
        return {"type": "synthesize", "requestId": rid, "text": text, "voiceId": voice, **extra}

    async def scenario(name: str, body: Callable[[WsSession], Any], *, key_override: str | None = "default") -> None:
        t, session = await open_session(f"tts/{name}", path, key if key_override == "default" else key_override)
        if session:
            try:
                await body(session)
            finally:
                if not session.reader.done():
                    await session.close()
        t.save()

    async def normal(s: WsSession) -> None:
        await s.send_json(synth("r1"))
        await s.wait_type("done", requestId="r1")

    async def supersede(s: WsSession) -> None:
        await s.send_json(synth("r1", LONG_TEXT))
        await s.wait_for(lambda m: m["kind"] == "binary")
        await s.send_json(synth("r2", "مرحبا"))
        await s.wait_type("done", requestId="r2")

    async def cancel_before_start(s: WsSession) -> None:
        await s.send_json(synth("r1", LONG_TEXT))
        await s.send_json({"type": "cancel"})
        await s.wait_type("cancelled", 15, requestId="r1")

    async def cancel_mid_stream(s: WsSession) -> None:
        await s.send_json(synth("r1", LONG_TEXT))
        await s.wait_for(lambda m: m["kind"] == "binary")
        await s.send_json({"type": "cancel"})
        await s.wait_type("cancelled", 15, requestId="r1")

    async def cancel_while_idle(s: WsSession) -> None:
        await s.send_json({"type": "cancel"})
        await asyncio.sleep(3)

    async def invalid_while_running(s: WsSession) -> None:
        await s.send_json(synth("r1", LONG_TEXT))
        await s.wait_for(lambda m: m["kind"] == "binary")
        await s.send_json(synth("r2", speed=9))
        await s.wait_type("done", 60, requestId="r1")

    async def voice_not_found(s: WsSession) -> None:
        await s.send_json({**synth("r1"), "voiceId": "000000000000000000000000"})
        await s.wait_type("error", 15)

    async def unknown_field(s: WsSession) -> None:
        await s.send_json(synth("r1", foo=1))
        await s.wait_type("error", 15)

    async def ping(s: WsSession) -> None:
        await s.send_json({"type": "ping"})
        await s.wait_type("pong", 10)

    async def invalid_json(s: WsSession) -> None:
        await s.send_text("not json")
        await asyncio.wait_for(s.reader, 15)

    async def binary_frame(s: WsSession) -> None:
        await s.send_audio(b"\x00\x00")
        await asyncio.wait_for(s.reader, 15)

    async def drop_mid_stream(s: WsSession) -> None:
        await s.send_json(synth("r1", LONG_TEXT))
        await s.wait_for(lambda m: m["kind"] == "binary")
        await s.abort()

    async def idle_timeout(s: WsSession) -> None:
        await asyncio.wait_for(s.reader, 150)

    print("TTS stream")
    for name, body in [("normal", normal), ("supersede", supersede), ("cancel_before_start", cancel_before_start),
                       ("cancel_mid_stream", cancel_mid_stream), ("cancel_while_idle", cancel_while_idle),
                       ("invalid_while_running", invalid_while_running), ("voice_not_found", voice_not_found),
                       ("unknown_field", unknown_field), ("ping", ping), ("invalid_json", invalid_json),
                       ("binary_frame", binary_frame), ("drop_mid_stream", drop_mid_stream)]:
        await scenario(name, body)
    if args.slow:
        await scenario("idle_timeout", idle_timeout)
    await scenario("handshake_no_key", normal, key_override=None)
    if disabled := require_key("ECHONOVA_DISABLED_KEY", optional=True):
        await scenario("handshake_disabled_key", normal, key_override=disabled)


async def run_stt(args: argparse.Namespace) -> None:
    key = require_key()
    assert key
    pcm_path = AUDIO / "ar.16k.pcm"
    if not pcm_path.exists():
        sys.exit("missing 16 kHz PCM: run the `audio` command first")
    pcm = pcm_path.read_bytes()
    base = "/v1/speech-to-text/stream?sample_rate=16000&language=ar"
    second = 32_000  # bytes of 16 kHz PCM16 per second

    async def scenario(name: str, body: Callable[[WsSession], Any], *, path: str = base,
                       key_override: str | None = "default") -> None:
        t, session = await open_session(f"stt/{name}", path, key if key_override == "default" else key_override)
        if session:
            try:
                await body(session)
            finally:
                if not session.reader.done():
                    await session.close()
        t.save()

    async def stop(s: WsSession) -> None:
        await s.send_json({"type": "stop"})
        await asyncio.wait_for(s.reader, 30)

    async def normal(s: WsSession) -> None:
        await s.wait_type("session.started", 15)
        await s.send_audio(pcm)
        await s.send_json({"type": "end_segment"})
        await s.wait_type("transcript", 30)
        await stop(s)

    async def audio_before_started(s: WsSession) -> None:
        await s.send_audio(pcm)
        await s.send_json({"type": "end_segment"})
        await s.wait_type("transcript", 30)
        await stop(s)

    async def empty_and_tiny_segments(s: WsSession) -> None:
        await s.wait_type("session.started", 15)
        await s.send_json({"type": "end_segment"})  # no audio at all
        await s.send_audio(pcm[: second * 3 // 100])  # a very short segment (30 ms)
        await s.send_json({"type": "end_segment"})
        await asyncio.sleep(5)
        await stop(s)

    async def terminology(s: WsSession) -> None:
        await s.wait_type("session.started", 15)
        await s.send_json({"type": "terminology", "terminology": {"keywords": ["EchoNova", "KYC"]}})
        await s.wait_type("terminology.set", 10)
        await s.send_json({"type": "terminology", "terminology": {"keywords": 5}})
        await s.wait_type("error", 10)
        await s.send_json({"type": "terminology", "terminology": None})
        await s.wait_for(lambda m: m["kind"] == "json" and m["data"].get("type") == "terminology.set"
                         and m["data"].get("active") is False, 10)
        await stop(s)

    async def auto_cut(s: WsSession) -> None:
        await s.wait_type("session.started", 15)
        audio = (pcm * (20 * second // max(len(pcm), 1) + 1))[: 20 * second]
        await s.send_audio(audio)  # 20 s without end_segment: the server cuts at 15 s
        await s.wait_type("transcript", 60)
        await stop(s)

    async def fifo_order(s: WsSession) -> None:
        # Segments of increasing length: if results arrive in order, durationSeconds increases with each one.
        await s.wait_type("session.started", 15)
        for index in range(20):
            length = int(second * (0.6 + 0.1 * index))
            await s.send_audio((pcm * 4)[:length - length % 2])
            await s.send_json({"type": "end_segment"})
        await asyncio.sleep(20)
        await stop(s)

    async def frame_too_large(s: WsSession) -> None:
        await s.wait_type("session.started", 15)
        await s.send_audio(b"\x00" * 70_000, chunk=70_000)
        await asyncio.wait_for(s.reader, 15)

    async def ping(s: WsSession) -> None:
        await s.send_json({"type": "ping"})
        await s.wait_type("pong", 10)
        await stop(s)

    async def idle_timeout(s: WsSession) -> None:
        await s.wait_type("session.started", 15)
        await asyncio.wait_for(s.reader, 150)

    print("STT stream")
    for name, body in [("normal", normal), ("audio_before_started", audio_before_started),
                       ("empty_and_tiny_segments", empty_and_tiny_segments), ("terminology", terminology),
                       ("auto_cut", auto_cut), ("fifo_order", fifo_order), ("frame_too_large", frame_too_large),
                       ("ping", ping)]:
        await scenario(name, body)
    if args.slow:
        await scenario("idle_timeout", idle_timeout)
    await scenario("handshake_bad_query", normal, path="/v1/speech-to-text/stream?sample_rate=7000&language=ar")
    await scenario("auto_language", normal, path="/v1/speech-to-text/stream?sample_rate=16000")  # language: auto
    await scenario("handshake_no_key", normal, key_override=None)
    if tts_only := require_key("ECHONOVA_TTS_ONLY_KEY", optional=True):
        await scenario("handshake_key_without_service", normal, key_override=tts_only)


# --- Promote ----------------------------------------------------------------------------------------


def rescrub(path: Path) -> None:
    """Run a recording through the current scrubber, so one made before a scrubber fix is cleaned too."""
    text = path.read_text(encoding="utf-8")
    scrubber = Scrubber()  # placeholders already in the file are kept as they are
    if path.suffix == ".jsonl":
        lines = [json.dumps(scrubber.value(json.loads(line)), ensure_ascii=False) for line in text.splitlines() if line]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    else:
        path.write_text(json.dumps(scrubber.value(json.loads(text)), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def cmd_promote(_: argparse.Namespace) -> None:
    if not OUT.exists():
        sys.exit("nothing recorded yet")
    problems = []
    files = [p for p in OUT.rglob("*") if p.is_file() and p.suffix in (".json", ".jsonl")]
    for path in files:
        rescrub(path)
        for leak in find_leaks(path.read_text(encoding="utf-8"), fixture=True):
            problems.append(f"{path.relative_to(OUT)}: {leak}")
    if problems:
        sys.exit("not promoted, possible leaks:\n  " + "\n  ".join(problems))
    for path in files:
        target = FIXTURES / path.relative_to(OUT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    print(f"promoted {len(files)} fixtures into {FIXTURES.relative_to(ROOT)} (audio stays local)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["audio", "rest", "tts-stream", "stt-stream", "promote"])
    parser.add_argument("--slow", action="store_true", help="also record the 120 s idle timeouts")
    args = parser.parse_args()
    if args.command == "audio":
        cmd_audio(args)
    elif args.command == "rest":
        cmd_rest(args)
    elif args.command == "tts-stream":
        asyncio.run(run_tts(args))
    elif args.command == "stt-stream":
        asyncio.run(run_stt(args))
    else:
        cmd_promote(args)


if __name__ == "__main__":
    main()
