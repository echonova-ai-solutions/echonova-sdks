"""The packaged rules match spec/, and the Python error classes match the shared taxonomy."""

from __future__ import annotations

from pathlib import Path

from echonova._core._rules import load_rules
from echonova.errors import ERROR_CLASSES

PACKAGED = Path(__file__).resolve().parents[1] / "src" / "echonova" / "_data" / "error-rules.json"


def test_packaged_rules_are_a_copy_of_the_spec(spec_dir: Path) -> None:
    assert PACKAGED.read_bytes() == (spec_dir / "error-rules.json").read_bytes(), "run tools/sync_sdk_data.py"


def test_error_classes_match_the_taxonomy() -> None:
    taxonomy = load_rules().taxonomy
    assert set(taxonomy) == set(ERROR_CLASSES)
    for name, parent in taxonomy.items():
        base = ERROR_CLASSES[name].__mro__[1]
        expected = Exception if parent is None else ERROR_CLASSES[parent]
        assert base is expected, f"{name} should subclass {parent}"


def test_rules_are_version_2_with_the_idempotent_post_column() -> None:
    rules = load_rules()
    assert rules.version == 2
    assert all(rule.retry.post_idempotent is not None for rule in rules.rules)
    assert all(row.retry.post_idempotent is not None for row in rules.transport.values())


def test_rules_are_well_formed() -> None:
    rules = load_rules()
    ids = [rule.id for rule in rules.rules]
    assert len(ids) == len(set(ids)), "rule ids must be unique"
    for rule in rules.rules:
        assert rule.error in rules.taxonomy, rule.id
        assert rule.row.startswith("R"), rule.id
    # The last rules are catch-alls, so every 4xx and 5xx status classifies.
    for status in range(400, 600):
        rules.classify(status, is_json=True, message="anything", has_retry_after=False)
        rules.classify(status, is_json=False, message=None, has_retry_after=False)


def test_spending_limit_is_not_a_rate_limit() -> None:
    assert not issubclass(ERROR_CLASSES["SpendingLimitError"], ERROR_CLASSES["RateLimitError"])
