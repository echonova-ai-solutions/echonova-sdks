#!/usr/bin/env python3
"""Build spec/mapping.json: every API operation, parameter and stream message,
with its name in each SDK.

The SDK method names are curated in SDK_METHODS and STREAM_MESSAGES below.
Parameter names are derived (Python: snake_case; TypeScript and Dart: camelCase)
with overrides in RENAMES. The build fails if the vendored spec has an
operation or stream message that has no SDK name and is not in EXCLUDED, so a
new endpoint can't slip past the SDKs unnoticed.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OPENAPI = ROOT / "spec" / "openapi.json"
ASYNCAPI = ROOT / "spec" / "asyncapi.json"
OUT = ROOT / "spec" / "mapping.json"

# operationId -> (python, typescript/dart) method path on the client
SDK_METHODS: dict[str, tuple[str, str]] = {
    "V1TtsController_generateSync": ("text_to_speech.generate", "textToSpeech.generate"),
    "V1TtsController_generateAsync": ("text_to_speech.jobs.create", "textToSpeech.jobs.create"),
    "V1TtsController_listVoices": ("text_to_speech.voices.list", "textToSpeech.voices.list"),
    "V1TtsController_listJobs": ("text_to_speech.jobs.list", "textToSpeech.jobs.list"),
    "V1TtsController_getJob": ("text_to_speech.jobs.get", "textToSpeech.jobs.get"),
    "V1TtsController_deleteJob": ("text_to_speech.jobs.delete", "textToSpeech.jobs.delete"),
    "V1SttController_transcribeSync": ("speech_to_text.transcribe", "speechToText.transcribe"),
    "V1SttController_transcribe": ("speech_to_text.jobs.create", "speechToText.jobs.create"),
    "V1SttController_listJobs": ("speech_to_text.jobs.list", "speechToText.jobs.list"),
    "V1SttController_getJob": ("speech_to_text.jobs.get", "speechToText.jobs.get"),
    "V1SttController_deleteJob": ("speech_to_text.jobs.delete", "speechToText.jobs.delete"),
    "V1SttController_exportJob": ("speech_to_text.jobs.export", "speechToText.jobs.export"),
    "V1CleanController_clean": ("sound_cleaning.clean", "soundCleaning.clean"),
    "V1CleanController_listJobs": ("sound_cleaning.jobs.list", "soundCleaning.jobs.list"),
    "V1CleanController_getJob": ("sound_cleaning.jobs.get", "soundCleaning.jobs.get"),
    "V1CleanController_deleteJob": ("sound_cleaning.jobs.delete", "soundCleaning.jobs.delete"),
    "V1WidgetsController_mint": ("widgets.create_ticket", "widgets.createTicket"),
    "V1AgentSessionsController_startSession": ("agents.sessions.start", "agents.sessions.start"),
    "V1AgentSessionsController_getSession": ("agents.sessions.get", "agents.sessions.get"),
    "V1AgentSessionsController_endSession": ("agents.sessions.end", "agents.sessions.end"),
}

# Operations deliberately not exposed, with the reason (shown by the coverage gate).
# The agent-management API (agents, conversations, knowledge, tools, test runs, LLM models,
# secrets) was added to the published spec on 2026-11-15 and is planned for the 0.1.0 releases.
AGENTS_MANAGEMENT = "agent-management API: planned for the 0.1.0 releases (ADR 0014)"
EXCLUDED: dict[str, str] = {
    "V1AgentsController_listAgents": AGENTS_MANAGEMENT,
    "V1AgentsWriteController_createAgent": AGENTS_MANAGEMENT,
    "V1AgentsController_compareAgents": AGENTS_MANAGEMENT,
    "V1AgentsController_getAgent": AGENTS_MANAGEMENT,
    "V1AgentsWriteController_updateAgent": AGENTS_MANAGEMENT,
    "V1AgentsController_listConversations": AGENTS_MANAGEMENT,
    "V1AgentsController_getConversation": AGENTS_MANAGEMENT,
    "V1AgentsController_getTranscript": AGENTS_MANAGEMENT,
    "V1AgentsController_getRecordingLink": AGENTS_MANAGEMENT,
    "V1AgentsController_listKnowledge": AGENTS_MANAGEMENT,
    "V1AgentsController_getAgentTools": AGENTS_MANAGEMENT,
    "V1AgentsController_listTestRuns": AGENTS_MANAGEMENT,
    "V1AgentsController_getTestRun": AGENTS_MANAGEMENT,
    "V1AgentsController_getWidget": AGENTS_MANAGEMENT,
    "V1AgentsController_estimateLlm": AGENTS_MANAGEMENT,
    "V1AgentsController_listAgentVoices": AGENTS_MANAGEMENT,
    "V1AgentsController_listLlmModels": AGENTS_MANAGEMENT,
    "V1AgentsWriteController_duplicateAgent": AGENTS_MANAGEMENT,
    "V1AgentsWriteController_archiveAgent": AGENTS_MANAGEMENT,
    "V1AgentsWriteController_restoreAgent": AGENTS_MANAGEMENT,
    "V1AgentsWriteController_attachTools": AGENTS_MANAGEMENT,
    "V1AgentsWriteController_detachTools": AGENTS_MANAGEMENT,
    "V1AgentsWriteController_addTextKnowledge": AGENTS_MANAGEMENT,
    "V1AgentsWriteController_addWebKnowledge": AGENTS_MANAGEMENT,
    "V1AgentsWriteController_setRag": AGENTS_MANAGEMENT,
    "V1ToolsController_createWebhookTool": AGENTS_MANAGEMENT,
    "V1ToolsController_previewOpenApiTool": AGENTS_MANAGEMENT,
    "V1ToolsController_createOpenApiTool": AGENTS_MANAGEMENT,
    "V1ToolsController_listTools": AGENTS_MANAGEMENT,
    "V1ToolsController_getTool": AGENTS_MANAGEMENT,
    "V1ToolsController_listSecrets": AGENTS_MANAGEMENT,
    "V1ToolsController_listAuthConnections": AGENTS_MANAGEMENT,
}

# AsyncAPI message -> (python, typescript/dart) SDK surface
STREAM_MESSAGES: dict[str, tuple[str, str]] = {
    "ttsSynthesize": ("TtsSession.synthesize", "TtsSession.synthesize"),
    "ttsCancel": ("TtsSession.cancel / Synthesis.cancel", "TtsSession.cancel / Synthesis.cancel"),
    "ping": ("keepalive (automatic)", "keepalive (automatic)"),
    "pong": ("keepalive (automatic)", "keepalive (automatic)"),
    "ttsStart": ("Synthesis.sample_rate / Synthesis.metrics", "Synthesis.sampleRate / Synthesis.metrics"),
    "ttsAudio": ("iter(Synthesis)", "for await (Synthesis)"),
    "ttsDone": ("Synthesis.result()", "Synthesis.result"),
    "ttsCancelled": ("Synthesis.result().outcome", "Synthesis.result.outcome"),
    "error": ("StreamErrorEvent / exceptions", "StreamErrorEvent / exceptions"),
    "sttAudio": ("SttSession.send_audio", "SttSession.sendAudio"),
    "sttEndSegment": ("SttSession.end_segment", "SttSession.endSegment"),
    "sttTerminology": ("SttSession.set_terminology", "SttSession.setTerminology"),
    "sttStop": ("SttSession.stop", "SttSession.stop"),
    "sttSessionStarted": ("SttSession.session_id / connect()", "SttSession.sessionId / connect()"),
    "sttTranscript": ("Transcript event", "TranscriptEvent"),
    "sttTerminologySet": ("TerminologySet event", "TerminologySetEvent"),
    "sttSessionEnded": ("SessionEnded event / SttSession.stop() result", "SessionEndedEvent / SttSession.stop()"),
    "sttSessionSaved": ("SessionSaved event / SessionSummary.job_id", "SessionSavedEvent / SessionSummary.jobId"),
}

# API name -> explicit SDK names where the derived ones are wrong or ambiguous.
RENAMES: dict[str, dict[str, str]] = {
    "jobId": {"python": "job_id", "ts": "jobId"},
    "format": {"python": "format", "ts": "format"},
    # TypeScript takes it in the request options object; Dart only through RequestOptions.
    "Idempotency-Key": {"python": "idempotency_key", "ts": "idempotencyKey", "dart": "RequestOptions.idempotencyKey"},
}


def snake(name: str) -> str:
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name).lower()


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def names(api_name: str) -> dict[str, str]:
    override = RENAMES.get(api_name, {})
    ts = override.get("ts", camel(api_name) if "_" in api_name else api_name)
    return {"python": override.get("python", snake(api_name)), "ts": ts, "dart": override.get("dart", ts)}


def resolve(spec: dict, schema: dict) -> dict:
    if "$ref" in schema:
        return resolve(spec, spec["components"]["schemas"][schema["$ref"].rsplit("/", 1)[-1]])
    if "allOf" in schema:
        merged: dict = {"properties": {}, "required": []}
        for part in schema["allOf"]:
            sub = resolve(spec, part)
            merged["properties"].update(sub.get("properties", {}))
            merged["required"] += sub.get("required", [])
        return merged
    return schema


def main() -> int:
    openapi = json.loads(OPENAPI.read_text(encoding="utf-8"))
    asyncapi = json.loads(ASYNCAPI.read_text(encoding="utf-8"))
    problems: list[str] = []
    operations = {}

    for path, items in openapi["paths"].items():
        for method, operation in items.items():
            if method not in ("get", "post", "put", "patch", "delete"):
                continue
            op_id = operation["operationId"]
            if op_id in EXCLUDED:
                operations[op_id] = {"method": method.upper(), "path": path, "excluded": EXCLUDED[op_id]}
                continue
            if op_id not in SDK_METHODS:
                problems.append(f"operation {op_id} ({method.upper()} {path}) has no SDK method and is not excluded")
                continue
            params = []
            for parameter in operation.get("parameters", []):
                params.append({"api": parameter["name"], "in": parameter["in"],
                               "required": bool(parameter.get("required")), **names(parameter["name"])})
            for content_type, content in operation.get("requestBody", {}).get("content", {}).items():
                schema = resolve(openapi, content["schema"])
                where = "json" if content_type == "application/json" else "form"
                for prop in schema.get("properties", {}):
                    params.append({"api": prop, "in": where, "required": prop in schema.get("required", []),
                                   **names(prop)})
            python_method, ts_method = SDK_METHODS[op_id]
            operations[op_id] = {
                "method": method.upper(),
                "path": path,
                "sdk": {"python": python_method, "ts": ts_method, "dart": ts_method},
                "params": params,
                # ADR 0014: the SDK sends a key on every call and may retry with it.
                "idempotency_key": any(p["api"] == "Idempotency-Key" and p["in"] == "header" for p in params),
            }

    for op_id in SDK_METHODS:
        if op_id not in operations:
            problems.append(f"SDK_METHODS names {op_id}, which is no longer in the spec")

    messages = {}
    for message in asyncapi["components"]["messages"]:
        if message not in STREAM_MESSAGES:
            problems.append(f"stream message {message} has no SDK surface")
            continue
        python_name, ts_name = STREAM_MESSAGES[message]
        messages[message] = {"python": python_name, "ts": ts_name, "dart": ts_name}

    stream_query = []
    for channel in asyncapi["channels"].values():
        query = channel.get("bindings", {}).get("ws", {}).get("query", {})
        for prop in query.get("properties", {}):
            stream_query.append({"channel": channel["address"], "api": prop,
                                 "required": prop in query.get("required", []), **names(prop)})

    if problems:
        print("mapping incomplete:\n  " + "\n  ".join(problems))
        return 1

    OUT.write_text(json.dumps({
        "$comment": "Generated by tools/build_mapping.py from the vendored specs. Edit the tool, not this file.",
        "operations": operations,
        "stream_query": stream_query,
        "stream_messages": messages,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(operations)} operations, {len(messages)} stream messages")
    return 0


if __name__ == "__main__":
    sys.exit(main())
