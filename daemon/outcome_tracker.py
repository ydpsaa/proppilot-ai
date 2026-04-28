"""
PropPilot AI — Outcome Tracker
Automatically marks smc_signals as tp1_hit / tp2_hit / sl_hit / expired
by comparing stored entry levels against live prices from the DataFeed.

Design decisions:
  - Runs every 5 min inside the position_update_loop (non-blocking).
  - Only processes signals that are actionable (LONG_NOW / SHORT_NOW)
    and have no outcome yet.
  - Signals expire after OUTCOME_EXPIRE_HOURS without a hit.
  - Partial results: TP1 is recorded first; TP2 checked independently
    on a separate pass — allows tracking "rode to full TP" vs "cut early".
  - All DB writes go through the Supabase REST API (same client as MemoryManager).
  - Thread-safe: designed to be called from asyncio.to_thread().

Usage (from main.py):
    tracker = OutcomeTracker()
    await asyncio.to_thread(tracker.run, feed_stores)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from typing import Optional

import structlog

import config

log = structlog.get_logger("outcome_tracker")

# How long (hours) before an open signal is marked "expired"
OUTCOME_EXPIRE_HOURS = int(config.__dict__.get("OUTCOME_EXPIRE_HOURS", 48))

# Minimum bars to wait before checking outcome (avoids marking on entry candle)
MIN_BARS_BEFORE_CHECK = 1


@dataclass
class OutcomeResult:
    signal_id:    int
    outcome:      str      # tp1_hit | tp2_hit | sl_hit | expired
    outcome_price: Optional[float]
    pnl_r:        Optional[float]
    notes:        str = ""


class OutcomeTracker:
    """
    Queries Supabase for pending signals and updates their outcomes
    based on live price data from the DataFeed CandleStores.
    """

    def __init__(self) -> None:
        self._sb = None   # lazy-init

    def _supabase(self):
        if self._sb is None:
            self._sb = config.get_supabase()
        return self._sb

    # ── Public entry point ────────────────────────────────────────────────────

    def run(self, stores: dict) -> list[OutcomeResult]:
        """
        Main method — call via asyncio.to_thread().
        `stores` is the DataFeed.stores dict: symbol → CandleStore.
        Returns list of outcomes recorded this run.
        """
        pending = self._fetch_pending_signals()
        if not pending:
            log.debug("outcome_tracker_no_pending")
            return []

        results: list[OutcomeResult] = []

        for sig in pending:
            result = self._evaluate(sig, stores)
            if result is None:
                continue
            self._write_outcome(result)
            results.append(result)

        if results:
            log.info("outcomes_recorded", count=len(results),
                     breakdown=self._breakdown(results))
        return results

    # ── Fetch pending signals from Supabase ───────────────────────────────────

    def _fetch_pending_signals(self) -> list[dict]:
        """
        Fetch LONG_NOW / SHORT_NOW signals with no outcome, created within
        OUTCOME_EXPIRE_HOURS + 1h (to catch signals just past expiry).
        """
        sb = self._supabase()
        cutoff = (datetime.now(tz=timezone.utc)
                  - timedelta(hours=OUTCOME_EXPIRE_HOURS + 1)).isoformat()
        try:
            resp = (
                sb.table("smc_signals")
                .select(
                    "id,created_at,symbol,direction,verdict,"
                    "entry_price,sl_price,tp1_price,tp2_price,risk_reward,atr"
                )
                .in_("verdict", ["LONG_NOW", "SHORT_NOW"])
                .is_("outcome", "null")
                .gte("created_at", cutoff)
                .order("created_at", desc=False)
                .limit(200)
                .execute()
            )
            return resp.data or []
        except Exception as e:
            log.error("outcome_fetch_error", error=str(e))
            return []

    # ── Evaluate a single signal ──────────────────────────────────────────────

    def _evaluate(self, sig: dict, stores: dict) -> Optional[OutcomeResult]:
        """
        Checks whether a signal's TP1 / TP2 / SL has been hit.

        Logic:
          - Scan all M5 candles created AFTER the signal's created_at timestamp.
          - For LONG:
              TP1 hit  = any candle.high ≥ tp1_price
              TP2 hit  = any candle.high ≥ tp2_price   (only if TP1 already hit)
              SL  hit  = any candle.low  ≤ sl_price
          - For SHORT: symmetric (low for TP, high for SL).
          - Whichever comes first in time wins (scan in chronological order).
          - If no hit and signal is older than OUTCOME_EXPIRE_HOURS → expired.
        """
        sig_id    = sig.get("id")
        symbol    = sig.get("symbol")
        direction = sig.get("direction")   # LONG | SHORT
        created_ts = _parse_ts(sig.get("created_at"))

        entry = _f(sig.get("entry_price"))
        sl    = _f(sig.get("sl_price"))
        tp1   = _f(sig.get("tp1_price"))
        tp2   = _f(sig.get("tp2_price"))

        if entry is None or sl is None or tp1 is None:
            log.debug("outcome_skip_no_levels", signal_id=sig_id)
            return None

        store = stores.get(symbol)
        if store is None:
            log.debug("outcome_skip_no_store", signal_id=sig_id, symbol=symbol)
            return None

        # Get M5 candles after signal creation
        m5_candles = [
            c for c in store.bars(5)
            if c.ts > created_ts
        ]

        if len(m5_candles) < MIN_BARS_BEFORE_CHECK:
            return None   # Too early

        # ── Scan candles chronologically ──────────────────────────────────────
        tp1_hit_ts: Optional[int] = None
        result_outcome: Optional[str] = None
        result_price:   Optional[float] = None

        for candle in m5_candles:
            if direction == "LONG":
                # SL hit takes priority over TP on the same candle
                if candle.low <= sl:
                    result_outcome = "sl_hit"
                    result_price   = sl
                    break
                if candle.high >= tp1 and tp1_hit_ts is None:
                    tp1_hit_ts = candle.ts
                    # Don't break — check for TP2 on subsequent candles
                if tp2 is not None and tp1_hit_ts is not None and candle.high >= tp2:
                    result_outcome = "tp2_hit"
                    result_price   = tp2
                    break

            else:  # SHORT
                if candle.high >= sl:
                    result_outcome = "sl_hit"
                    result_price   = sl
                    break
                if candle.low <= tp1 and tp1_hit_ts is None:
                    tp1_hit_ts = candle.ts
                if tp2 is not None and tp1_hit_ts is not None and candle.low <= tp2:
                    result_outcome = "tp2_hit"
                    result_price   = tp2
                    break

        # If TP1 hit but no TP2 / SL after that
        if result_outcome is None and tp1_hit_ts is not None:
            result_outcome = "tp1_hit"
            result_price   = tp1

        # Expiry check
        if result_outcome is None:
            age_hours = (datetime.now(tz=timezone.utc) - datetime.fromtimestamp(
                created_ts, tz=timezone.utc
            )).total_seconds() / 3600
            if age_hours >= OUTCOME_EXPIRE_HOURS:
                # Mark as expired; use last close price
                last_close = m5_candles[-1].close if m5_candles else entry
                return OutcomeResult(
                    signal_id=sig_id,
                    outcome="expired",
                    outcome_price=last_close,
                    pnl_r=self._calc_pnl_r(direction, entry, sl, last_close),
                    notes=f"Expired after {age_hours:.0f}h without hit",
                )
            return None   # Still alive — check next run

        pnl_r = self._calc_pnl_r(direction, entry, sl, result_price)
        return OutcomeResult(
            signal_id=sig_id,
            outcome=result_outcome,
            outcome_price=result_price,
            pnl_r=pnl_r,
        )

    # ── Write outcome to Supabase ─────────────────────────────────────────────

    def _write_outcome(self, result: OutcomeResult) -> None:
        sb = self._supabase()
        try:
            sb.table("smc_signals").update({
                "outcome":       result.outcome,
                "outcome_price": result.outcome_price,
                "outcome_pnl_r": result.pnl_r,
                "outcome_at":    datetime.now(tz=timezone.utc).isoformat(),
            }).eq("id", result.signal_id).is_("outcome", "null").execute()

            log.info("outcome_written",
                     signal_id=result.signal_id,
                     outcome=result.outcome,
                     pnl_r=result.pnl_r)
        except Exception as e:
            log.error("outcome_write_error", signal_id=result.signal_id, error=str(e))

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _calc_pnl_r(direction: Optional[str], entry: float, sl: float,
                    close_price: float) -> Optional[float]:
        """P&L in R-multiples (e.g. +2.5 = hit 2.5× the risk)."""
        if direction is None or entry is None or sl is None:
            return None
        sl_dist = abs(entry - sl)
        if sl_dist <= 0:
            return None
        if direction == "LONG":
            return round((close_price - entry) / sl_dist, 3)
        else:
            return round((entry - close_price) / sl_dist, 3)

    @staticmethod
    def _breakdown(results: list[OutcomeResult]) -> dict:
        from collections import Counter
        return dict(Counter(r.outcome for r in results))

    # ── Batch mark outcomes (utility for backfill / testing) ──────────────────

    def backfill(self, stores: dict, max_signals: int = 1000) -> dict:
        """
        Backfill outcomes for the last `max_signals` actionable signals.
        Useful when the tracker was not running (e.g. after a fresh deploy).
        Returns a summary dict.
        """
        sb = self._supabase()
        try:
            resp = (
                sb.table("smc_signals")
                .select(
                    "id,created_at,symbol,direction,verdict,"
                    "entry_price,sl_price,tp1_price,tp2_price,risk_reward,atr"
                )
                .in_("verdict", ["LONG_NOW", "SHORT_NOW"])
                .is_("outcome", "null")
                .order("created_at", desc=False)
                .limit(max_signals)
                .execute()
            )
            pending = resp.data or []
        except Exception as e:
            log.error("backfill_fetch_error", error=str(e))
            return {"error": str(e)}

        results = []
        for sig in pending:
            r = self._evaluate(sig, stores)
            if r:
                self._write_outcome(r)
                results.append(r)

        summary = {"processed": len(pending), "marked": len(results),
                   **self._breakdown(results)}
        log.info("backfill_complete", **summary)
        return summary


# ── Utilities ─────────────────────────────────────────────────────────────────

def _f(v) -> Optional[float]:
    """Safe float cast."""
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _parse_ts(iso: Optional[str]) -> int:
    """Parse ISO-8601 timestamp string → unix seconds."""
    if not iso:
        return 0
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return int(dt.timestamp())
    except Exception:
        return 0
