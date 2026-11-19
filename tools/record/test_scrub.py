from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scrub import Scrubber, find_leaks  # noqa: E402

KEY = "ek_" + "A1b2C3d4" * 8
SAS = "https://acct123.blob.core.windows.net/tts/out.wav?sv=2024-01-01&se=2026-11-05T12%3A00%3A00Z&sig=abcDEF%3D"


def test_secrets_and_signed_links_are_removed() -> None:
    s = Scrubber()
    out = s.value({"auth": f"Bearer {KEY}", "audioUrl": SAS, "note": "whsec_" + "x" * 43})
    assert out == {
        "auth": "Bearer ek_REDACTED",
        "audioUrl": "https://storage.example.com/files/1.wav?signature=REDACTED",
        "note": "whsec_REDACTED",
    }
    assert find_leaks(str(out)) == []


def test_ids_become_stable_placeholders() -> None:
    s = Scrubber()
    job = "66e5f0c2a1b2c3d4e5f60718"
    out = s.value({"jobId": job, "items": [{"id": job}, {"id": "66e5f0c2a1b2c3d4e5f60719"}]})
    assert out["jobId"] == out["items"][0]["id"] == "000000000000000000000001"
    assert out["items"][1]["id"] == "000000000000000000000002"


def test_request_ids_become_placeholders() -> None:
    s = Scrubber()
    first = s.text("3f2b8c1e-9a4d-4c6b-8e2f-1a2b3c4d5e6f")
    assert first == "00000000-0000-4000-8000-000000000001"
    assert s.text("3F2B8C1E-9A4D-4C6B-8E2F-1A2B3C4D5E6F") == first


def test_scrubbing_twice_changes_nothing() -> None:
    s = Scrubber()
    once = s.value({"id": "66e5f0c2a1b2c3d4e5f60718", "rid": "3f2b8c1e-9a4d-4c6b-8e2f-1a2b3c4d5e6f"})
    assert s.value(once) == once


def test_api_urls_keep_their_host_and_query() -> None:
    s = Scrubber()
    assert s.text("https://echonova.ai/docs/developers/errors") == "https://echonova.ai/docs/developers/errors"


def test_sensitive_fields_and_headers() -> None:
    s = Scrubber()
    assert s.value({"apiKeyName": "Acme production"}) == {"apiKeyName": "REDACTED"}
    assert s.value({"token": "eyJhbGciOi.room", "ticket": "wtk_abc"}) == {"token": "REDACTED", "ticket": "REDACTED"}
    headers = s.headers({"Authorization": f"Bearer {KEY}", "X-Request-Id": "abc", "Set-Cookie": "a=b", "Server": "x"})
    assert headers == {"x-request-id": "abc"}


def test_find_leaks_catches_unscrubbed_values() -> None:
    assert "API key" in find_leaks(KEY)
    assert "signed URL query" in find_leaks("?sig=abc")
    assert "storage hostname" in find_leaks("acct.blob.core.windows.net")
    assert "bearer token" in find_leaks("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc")
    assert find_leaks("whsec_TEST0000000000000000000000") == []  # made-up test secrets are allowed


def test_identifiers_containing_ek_are_not_keys() -> None:
    assert find_leaks("def test_non_ek_key_logs_a_warning(): ...") == []
    assert Scrubber().text("check_ek_prefix_handling") == "check_ek_prefix_handling"


def test_find_leaks_ignores_documentation_examples() -> None:
    assert find_leaks("Authorization: Bearer followed by your API key, e.g. Bearer ek_...") == []
    assert find_leaks("https://storage.example.com/tts/out.wav?X-Amz-Signature=...") == []


def test_storage_paths_keep_only_the_file_extension() -> None:
    s = Scrubber()
    first = "https://acct.blob.core.windows.net/container-name/workspaces/66e5f0c2a1b2c3d4e5f60718/tts/a__out.WAV?sig=x"
    second = "https://acct.blob.core.windows.net/container-name/voices/b__preview.mp3"
    out = s.value({"a": first, "again": first, "b": second})
    assert out == {
        "a": "https://storage.example.com/files/1.wav?signature=REDACTED",
        "again": "https://storage.example.com/files/1.wav?signature=REDACTED",
        "b": "https://storage.example.com/files/2.mp3",
    }
    assert "container-name" not in str(out)
    assert find_leaks(str(out), fixture=True) == []


def test_find_leaks_catches_a_storage_path() -> None:
    leaked = "https://storage.example.com/container-name/workspaces/x.wav"
    assert find_leaks(leaked, fixture=True) == ["storage path"]
    assert find_leaks("https://storage.example.com/files/3.wav.bak", fixture=True) == ["storage path"]
    assert find_leaks('"https://storage.example.com/files/3.wav?signature=REDACTED"', fixture=True) == []
    assert find_leaks(leaked) == []  # documentation may use any example path


def test_rescrubbing_with_a_new_scrubber_keeps_placeholders() -> None:
    once = Scrubber().value({"ids": ["66e5f0c2a1b2c3d4e5f60719", "66e5f0c2a1b2c3d4e5f60718"], "url": SAS})
    assert Scrubber().value(once) == once  # a fresh scrubber, as when promote re-scrubs an older recording


def test_placeholder_signatures_in_documentation_are_not_leaks() -> None:
    # The published API spec shows example links such as ...?sig=... (2026-11-15).
    assert find_leaks('"https://storage.echonova.ai/recordings/abc.wav?sig=..."') == []
    assert find_leaks('"https://storage.echonova.ai/recordings/abc.wav?sig=…"') == []
    assert find_leaks('"https://storage.echonova.ai/recordings/abc.wav?sig=aB3dE5"') == ["signed URL query"]


# A made-up token, joined at runtime so the secret scan doesn't see a JWT in the source.
JWT = ".".join(["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiJ1c2VyLTQyIiwicm9vbSI6InIxIn0", "c2lnbmF0dXJlLW1hZGUtdXA"])


def test_sensitive_names_match_any_case_and_any_part_of_the_name() -> None:
    s = Scrubber()
    out = s.value(
        {
            "accessToken": "abc",
            "roomToken": "abc",
            "ownerEmail": "abc",
            "ACCESS_TOKEN": "abc",
            "clientSecret": "abc",
            "userPassword": "abc",
            "x-api-key": "abc",
            "ApiKey": "abc",
            "WorkspaceName": "Acme",
            "secrets": ["one", "two"],
            "nested": {"Authorization": "Basic abc"},
        }
    )
    assert all(v == "REDACTED" for k, v in out.items() if k not in ("secrets", "nested")), out
    assert out["secrets"] == ["REDACTED", "REDACTED"]
    assert out["nested"] == {"Authorization": "REDACTED"}


def test_harmless_fields_the_fixtures_rely_on_are_kept() -> None:
    s = Scrubber()
    # The recorder's own note of which credential it sent: the replay tests read it.
    for marker in ("none", "set", "test key", "other key"):
        assert s.value({"authorization": marker}) == {"authorization": marker}
    kept = {"maxTokens": 256, "status": "completed", "voiceName": "Layla", "type": "session.started", "text": "hi"}
    assert s.value(kept) == kept
    assert s.value({"tokenCount": 12, "isSecret": False}) == {"tokenCount": 12, "isSecret": False}


def test_dict_keys_are_scrubbed() -> None:
    s = Scrubber()
    out = s.value({"66e5f0c2a1b2c3d4e5f60718": {"by": "owner@acme.io"}, "owner@acme.io": 1, KEY: "x"})
    assert out == {"000000000000000000000001": {"by": "user@example.com"}, "user@example.com": 1, "ek_REDACTED": "x"}
    assert find_leaks(str(out), fixture=True) == []


def test_stream_links_are_scrubbed() -> None:
    s = Scrubber()
    room = "wss://media-7.rtc.internal-host.net/rtc?token=" + JWT
    assert s.text(room) == "wss://stream.example.com?token=REDACTED"
    api = "wss://api.echonova.ai/v1/speech-to-text/stream?sample_rate=16000&access_token=abc.def&ticket=t1"
    assert s.text(api) == (
        "wss://api.echonova.ai/v1/speech-to-text/stream?sample_rate=16000&access_token=REDACTED&ticket=REDACTED"
    )
    plain = "wss://api.echonova.ai/v1/speech-to-text/stream?sample_rate=16000&language=ar"
    assert s.text(plain) == plain
    assert s.text("https://api.echonova.ai/v1/text-to-speech/jobs?limit=5") == (
        "https://api.echonova.ai/v1/text-to-speech/jobs?limit=5"
    )
    assert find_leaks(s.text(room), fixture=True) == []


def test_jwts_and_emails_are_scrubbed_in_free_text() -> None:
    s = Scrubber()
    out = s.text(f"room {JWT} for Owner.Name+tag@acme.co.uk")
    assert out == "room REDACTED_JWT for user@example.com"
    assert find_leaks(out, fixture=True) == []


def test_find_leaks_catches_jwts_and_emails() -> None:
    assert find_leaks(JWT) == ["JWT"]
    assert find_leaks(f"Authorization: Bearer {JWT}") == ["JWT", "bearer token"]
    assert find_leaks('{"ownerEmail": "someone@acme.io"}', fixture=True) == ["email address"]
    # Only recorded traffic is checked for addresses: the packages' metadata names a maintainer.
    assert find_leaks('{"ownerEmail": "someone@acme.io"}') == []
    assert find_leaks('{"by": "user@example.com", "cc": "a@docs.example.org"}', fixture=True) == []
    # Truncated or made-up tokens in tests and docs are not JWTs.
    assert find_leaks("eyJhbGciOiJIUzI1NiJ9.room-token-secret eyJ-SECRET-ROOM-TOKEN eyJhbGciOi..") == []
