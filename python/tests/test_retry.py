from __future__ import annotations

import pytest

from echonova._core._retry import RetryPolicy, retry_column
from echonova._core._rules import Rule, load_rules

RULES = load_rules()


def policy(**kwargs: object) -> RetryPolicy:
    return RetryPolicy(rng=lambda: 0.5, **kwargs)  # type: ignore[arg-type]


def rule(rule_id: str) -> Rule:
    return next(r for r in RULES.rules if r.id == rule_id)


@pytest.mark.parametrize("r", RULES.rules, ids=lambda r: r.id)
def test_post_is_never_retried_when_it_may_have_run(r: Rule) -> None:
    """The safety invariant: without an idempotency key, a POST that may have run is never sent again."""
    decision = policy().decide_status("POST", r, retries_done=0, retry_after=1.0)
    if r.may_have_executed != "no":
        assert decision.retry is False


@pytest.mark.parametrize("r", RULES.rules, ids=lambda r: r.id)
def test_idempotent_post_retries_at_least_what_a_post_does(r: Rule) -> None:
    """A key only adds retries: whatever a plain POST retries, an idempotent one retries too."""
    plain = policy().decide_status("POST", r, retries_done=0, retry_after=1.0)
    keyed = policy().decide_status("POST_IDEMPOTENT", r, retries_done=0, retry_after=1.0)
    assert keyed.retry or not plain.retry


def test_retry_column() -> None:
    assert retry_column("POST", idempotency_key=True) == "POST_IDEMPOTENT"
    assert retry_column("post", idempotency_key=True) == "POST_IDEMPOTENT"
    assert retry_column("POST", idempotency_key=False) == "POST"
    assert retry_column("GET", idempotency_key=True) == "GET"
    assert retry_column("DELETE", idempotency_key=False) == "DELETE"


@pytest.mark.parametrize(
    ("rule_id", "method", "retry"),
    [
        ("throttled", "POST", True),
        ("throttled", "GET", True),
        ("spending_limit", "GET", False),
        ("insufficient_balance", "POST", False),
        ("unauthorized", "GET", False),
        ("unavailable_refunded", "POST", True),
        ("unavailable_other", "POST", False),
        ("unavailable_other", "GET", True),
        ("storage_delete_failed", "DELETE", True),
        ("storage_delete_failed", "GET", False),
        ("ingress_unavailable", "POST", True),
        ("internal_error", "POST", False),
        ("internal_error", "GET", True),
        ("bad_gateway", "POST", False),
        ("ingress_timeout", "POST", False),
        ("ingress_timeout", "DELETE", True),
        ("request_timeout", "POST", True),
        ("invalid_request", "GET", False),
        # ADR 0014: a POST with an Idempotency-Key is retried after a server error...
        ("internal_error", "POST_IDEMPOTENT", True),
        ("bad_gateway", "POST_IDEMPOTENT", True),
        ("unavailable_other", "POST_IDEMPOTENT", True),
        ("ingress_unavailable", "POST_IDEMPOTENT", True),
        ("unavailable_refunded", "POST_IDEMPOTENT", True),
        ("gateway_timeout", "POST_IDEMPOTENT", True),
        ("ingress_timeout", "POST_IDEMPOTENT", True),
        ("throttled", "POST_IDEMPOTENT", True),
        ("request_timeout", "POST_IDEMPOTENT", True),
        # ...and while the first request with its key is still running...
        ("idempotency_in_progress", "POST_IDEMPOTENT", True),
        ("same_request_starting", "POST_IDEMPOTENT", True),
        ("idempotency_in_progress", "POST", False),
        ("same_request_starting", "GET", False),
        # ...but never after a client, authentication or billing error, or a key reused for another request.
        ("idempotency_key_reused", "POST_IDEMPOTENT", False),
        ("invalid_request", "POST_IDEMPOTENT", False),
        ("unauthorized", "POST_IDEMPOTENT", False),
        ("forbidden", "POST_IDEMPOTENT", False),
        ("insufficient_balance", "POST_IDEMPOTENT", False),
        ("spending_limit", "POST_IDEMPOTENT", False),
        ("voice_not_found", "POST_IDEMPOTENT", False),
        ("rate_limited_other", "POST_IDEMPOTENT", False),
        ("server_error_other", "POST_IDEMPOTENT", False),
    ],
)
def test_status_table(rule_id: str, method: str, retry: bool) -> None:
    assert policy().decide_status(method, rule(rule_id), retries_done=0, retry_after=5.0).retry is retry


def test_throttle_waits_retry_after_plus_jitter() -> None:
    decision = policy().decide_status("GET", rule("throttled"), retries_done=0, retry_after=12.0)
    assert decision.retry
    assert decision.delay == pytest.approx(12.5)


def test_retry_after_longer_than_the_cap_is_not_waited_for() -> None:
    decision = policy().decide_status("GET", rule("throttled"), retries_done=0, retry_after=61.0)
    assert not decision.retry
    assert decision.reason == "retry_after_too_long"


def test_max_retries() -> None:
    p = policy(max_retries=2)
    assert p.decide_status("GET", rule("internal_error"), retries_done=1, retry_after=None).retry
    decision = p.decide_status("GET", rule("internal_error"), retries_done=2, retry_after=None)
    assert not decision.retry
    assert decision.reason == "max_retries"


def test_unreplayable_body_is_not_retried() -> None:
    decision = policy().decide_status(
        "POST", rule("unavailable_refunded"), retries_done=0, retry_after=None, body_replayable=False
    )
    assert not decision.retry
    assert decision.reason == "body_not_replayable"


@pytest.mark.parametrize(
    ("phase", "method", "retry", "executed"),
    [
        ("connect", "POST", True, "no"),
        ("send_incomplete", "POST", True, "no"),
        ("no_response", "POST", False, "yes"),
        ("no_response", "GET", True, "yes"),
        ("no_response", "DELETE", True, "yes"),
        ("malformed_success", "POST", False, "yes"),
        ("connect", "POST_IDEMPOTENT", True, "no"),
        ("send_incomplete", "POST_IDEMPOTENT", True, "no"),
        ("no_response", "POST_IDEMPOTENT", True, "yes"),
        ("malformed_success", "POST_IDEMPOTENT", True, "yes"),
    ],
)
def test_transport_phases(phase: str, method: str, retry: bool, executed: str) -> None:
    decision = policy().decide_transport(method, phase, retries_done=0)
    assert decision.retry is retry
    assert decision.may_have_executed == executed


@pytest.mark.parametrize("column", ["GET", "POST_IDEMPOTENT"])
def test_malformed_success_is_retried_once(column: str) -> None:
    p = policy(max_retries=5)
    assert p.decide_transport(column, "malformed_success", retries_done=0).retry
    assert not p.decide_transport(column, "malformed_success", retries_done=1).retry


def test_in_progress_waits_retry_after_when_given_else_backs_off() -> None:
    r = rule("idempotency_in_progress")
    assert policy().decide_status("POST_IDEMPOTENT", r, retries_done=0, retry_after=4.0).delay == pytest.approx(4.5)
    assert policy().decide_status("POST_IDEMPOTENT", r, retries_done=1, retry_after=None).delay == pytest.approx(0.75)


def test_backoff_grows_and_is_capped() -> None:
    p = RetryPolicy(rng=lambda: 1.0)  # top of the jitter range
    assert [p.backoff(n) for n in (1, 2, 3, 4, 5, 6)] == [0.5, 1.0, 2.0, 4.0, 8.0, 8.0]
    low = RetryPolicy(rng=lambda: 0.0)
    assert low.backoff(1) == pytest.approx(0.25)


def test_handshake_concurrency_limit_needs_opt_in() -> None:
    r = rule("concurrent_streams")
    assert not policy().decide_status("WS", r, retries_done=0, retry_after=None).retry
    assert policy().decide_status("WS", r, retries_done=0, retry_after=None, wait_for_slot=True).retry


def test_handshake_has_a_shorter_retry_after_cap() -> None:
    r = rule("throttled")
    assert policy().decide_status("WS", r, retries_done=0, retry_after=30.0).retry
    assert not policy().decide_status("WS", r, retries_done=0, retry_after=31.0).retry


@pytest.mark.parametrize("rule_id", ["unauthorized", "insufficient_balance", "spending_limit", "streaming_disabled"])
def test_handshake_never_retries_account_problems(rule_id: str) -> None:
    assert not policy().decide_status("WS", rule(rule_id), retries_done=0, retry_after=1.0).retry
