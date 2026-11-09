"""Decide whether a failed attempt may be retried, and after how long.

Pure logic over the shared retry table in ``spec/error-rules.json``. The table
never retries a POST that may already have run, because the API has no
idempotency key and would charge again.
"""

from __future__ import annotations

import random
from collections.abc import Callable
from dataclasses import dataclass

from ._rules import Delay, Executed, RetryFlag, Rule, RuleSet, TransportRule, load_rules

Phase = str  # "connect" | "send_incomplete" | "no_response" | "malformed_success"


@dataclass(frozen=True, slots=True)
class RetryDecision:
    retry: bool
    delay: float
    row: str
    may_have_executed: Executed
    reason: str  # why: "retry", "not_retryable", "max_retries", "retry_after_too_long", "body_not_replayable", ...


class RetryPolicy:
    def __init__(
        self,
        *,
        max_retries: int | None = None,
        max_retry_after: float | None = None,
        rules: RuleSet | None = None,
        rng: Callable[[], float] = random.random,
    ) -> None:
        self.rules = rules or load_rules()
        defaults = self.rules.defaults
        self.max_retries = defaults.max_retries if max_retries is None else max_retries
        self.max_retry_after = defaults.max_retry_after if max_retry_after is None else max_retry_after
        self._rng = rng

    def backoff(self, retry_number: int) -> float:
        """Delay before retry number ``retry_number`` (1-based), with jitter."""
        d = self.rules.defaults
        base = min(d.backoff_max, d.backoff_initial * d.backoff_multiplier ** (retry_number - 1))
        low, high = d.backoff_jitter
        return base * (low + (high - low) * self._rng())

    def _retry_after_delay(self, retry_after: float) -> float:
        low, high = self.rules.defaults.retry_after_jitter
        return retry_after + low + (high - low) * self._rng()

    def decide_status(
        self,
        method: str,
        rule: Rule,
        *,
        retries_done: int,
        retry_after: float | None,
        body_replayable: bool = True,
        wait_for_slot: bool = False,
    ) -> RetryDecision:
        """Decide for an HTTP error status (``method`` is GET/DELETE/POST, or WS for a handshake)."""
        flag = rule.retry.for_method(method)
        max_retry_after = self.rules.defaults.ws_max_retry_after if method.upper() == "WS" else self.max_retry_after
        return self._decide(
            flag,
            rule.retry.delay,
            row=rule.row,
            executed=rule.may_have_executed,
            retries_done=retries_done,
            retry_after=retry_after,
            body_replayable=body_replayable,
            opted_in=wait_for_slot,
            max_retry_after=max_retry_after,
        )

    def decide_transport(
        self,
        method: str,
        phase: Phase,
        *,
        retries_done: int,
        body_replayable: bool = True,
    ) -> RetryDecision:
        """Decide for a failure without an HTTP status (connect error, timeout, broken body...)."""
        row: TransportRule = self.rules.transport[phase]
        return self._decide(
            row.retry.for_method(method),
            row.retry.delay,
            row=row.row,
            executed=row.may_have_executed,
            retries_done=retries_done,
            retry_after=None,
            body_replayable=body_replayable,
            opted_in=False,
            max_retry_after=self.max_retry_after,
        )

    def _decide(
        self,
        flag: RetryFlag,
        delay_kind: Delay,
        *,
        row: str,
        executed: Executed,
        retries_done: int,
        retry_after: float | None,
        body_replayable: bool,
        opted_in: bool,
        max_retry_after: float,
    ) -> RetryDecision:
        def no(reason: str) -> RetryDecision:
            return RetryDecision(retry=False, delay=0.0, row=row, may_have_executed=executed, reason=reason)

        if flag is False or delay_kind == "none":
            return no("not_retryable")
        if flag == "opt_in" and not opted_in:
            return no("not_opted_in")
        if flag == "once" and retries_done >= 1:
            return no("max_retries")
        if retries_done >= self.max_retries:
            return no("max_retries")
        if not body_replayable:
            return no("body_not_replayable")

        if delay_kind in ("retry_after", "retry_after_or_backoff") and retry_after is not None:
            if retry_after > max_retry_after:
                return no("retry_after_too_long")
            delay = self._retry_after_delay(retry_after)
        elif delay_kind == "retry_after":
            return no("missing_retry_after")
        else:
            delay = self.backoff(retries_done + 1)
        return RetryDecision(retry=True, delay=delay, row=row, may_have_executed=executed, reason="retry")
