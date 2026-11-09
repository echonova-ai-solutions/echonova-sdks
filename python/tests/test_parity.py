"""EchoNova and AsyncEchoNova expose the same surface with the same parameters."""

from __future__ import annotations

import inspect
from typing import Any

import pytest

from echonova import AsyncEchoNova, EchoNova

KEY = "ek_REDACTED0parity0test0key00000"


def public_members(obj: Any) -> dict[str, Any]:
    return {name: getattr(obj, name) for name in dir(obj) if not name.startswith("_")}


def walk(sync_obj: Any, async_obj: Any, path: str) -> list[str]:
    checked = []
    sync_members, async_members = public_members(sync_obj), public_members(async_obj)
    assert set(sync_members) == set(async_members), path
    for name, member in sync_members.items():
        other = async_members[name]
        where = f"{path}.{name}"
        if inspect.ismethod(member):
            sync_sig, async_sig = inspect.signature(member), inspect.signature(other)
            assert list(sync_sig.parameters) == list(async_sig.parameters), where
            for param in sync_sig.parameters:
                assert sync_sig.parameters[param].default == async_sig.parameters[param].default, f"{where}({param})"
                assert sync_sig.parameters[param].kind == async_sig.parameters[param].kind, f"{where}({param})"
            checked.append(where)
        elif type(member).__module__.startswith("echonova.resources"):
            checked += walk(member, other, where)
    return checked


def test_same_resources_methods_and_parameters() -> None:
    sync_client, async_client = EchoNova(api_key=KEY), AsyncEchoNova(api_key=KEY)
    checked = walk(sync_client, async_client, "client")
    for expected in [
        "client.text_to_speech.generate",
        "client.text_to_speech.voices.list",
        "client.text_to_speech.jobs.find_candidates",
        "client.speech_to_text.jobs.export",
        "client.sound_cleaning.jobs.download",
        "client.widgets.create_ticket",
        "client.download",
        "client.with_options",
    ]:
        assert expected in checked


def test_same_raw_response_surface() -> None:
    sync_raw, async_raw = EchoNova(api_key=KEY).with_raw_response, AsyncEchoNova(api_key=KEY).with_raw_response

    def names(obj: Any, prefix: str = "") -> set[str]:
        found = set()
        for name, member in vars(obj).items():
            if callable(member):
                found.add(prefix + name)
            else:
                found |= names(member, f"{prefix}{name}.")
        return found

    assert names(sync_raw) == names(async_raw)
    assert "text_to_speech.jobs.list" in names(sync_raw)


@pytest.mark.parametrize("name", ["_ws_base_url", "_user_agent", "_auth_headers", "_async_auth_headers"])
def test_streaming_hooks_exist_on_both(name: str) -> None:
    assert hasattr(EchoNova(api_key=KEY), name)
    assert hasattr(AsyncEchoNova(api_key=KEY), name)
