"""
PropPilot AI — Memory Manager
Read/write bot context from Supabase (bot_memory, execution_log, paper_account).

Before each session:  load_context()  → dict with recent lessons, key levels
After each session:   save_session()  → write bot_memory row
After each close:     log_execution() → write execution_log row
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import structlog

import config

log = structlog.get_logger("memory_manager")

# ─── MemoryManager ────────────────────────────────────────────────────────────

class MemoryManager:
    """Thin async wrapper around Supabase tables for bot state."""

    def __init__(self):
        self._sb = config.get_supabase()

    # ── Account state ─────────────────────────────────────────────────────────

    def fetch_account(self) -> dict:
        """Fetch paper_account row 1."""
        try:
            res = self._sb.table("paper_account").select("*").eq("id", 1).single().execute()
            return res.data or {}
        except Exception as e:
            log.error("fetch_account_error", error=str(e))
            return {}

    def fetch_settings(self) -> dict:
        """Fetch bot_settings row 1."""
        try:
            res = self._sb.table("bot_settings").select("*").eq("id", 1).single().execute()
            return res.data or {}
        except Exception as e:
            log.error("fetch_settings_error", error=str(e))
            return {}

    def fetch_open_positions(self) -> list[dict]:
        """Fetch all positions with status OPEN or TP1_HIT."""
        try:
            res = (self._sb.table("paper_positions")
                   .select("*")
                   .in_("status", ["OPEN", "TP1_HIT"])
                   .execute())
            return res.data or []
        except Exception as e:
            log.error("fetch_open_positions_error", error=str(e))
            return []

    def update_kill_switch(self, reason: str) -> None:
        """Activate kill-switch in paper_account and pause bot_settings."""
        now = datetime.now(tz=timezone.utc).isoformat()
        try:
            self._sb.table("paper_account").update({
                "kill_switch_active": True,
                "kill_switch_reason": reason,
                "kill_switch_at": now,
                "updated_at": now,
            }).eq("id", 1).execute()
            self._sb.table("bot_settings").update({
                "is_paused": True,
                "updated_at": now,
            }).eq("id", 1).execute()
            log.warning("kill_switch_activated", reason=reason)
        except Exception as e:
            log.error("kill_switch_update_error", error=str(e))

    def reset_daily(self) -> None:
        """Reset daily tracking (called at 00:01 UTC via cron, also available locally)."""
        try:
            self._sb.rpc("reset_daily_tracking").execute()
            log.info("daily_tracking_reset")
        except Exception as e:
            log.error("daily_reset_error", error=str(e))

    # ── Bot memory ────────────────────────────────────────────────────────────

    def load_context(self, n: int = 5) -> dict:
        """
        Load recent bot_memory entries to prime the bot with context.
        Returns a dict usable as context for the current session.
        """
        try:
            res = (self._sb.table("bot_memory")
                   .select("*")
                   .order("run_at", desc=True)
                   .limit(n)
                   .execute())
            rows = res.data or []
        except Exception as e:
            log.error("load_context_error", error=str(e))
            rows = []

        # Aggregate lessons and key levels
        lessons:  list[str] = []
        levels:   dict = {}
        trades_placed = 0

        for row in rows:
            ll = row.get("lessons_learned", "")
            if ll and ll.strip():
                lessons.append(ll.strip())
            nwl = row.get("next_watch_levels") or {}
            levels.update(nwl)
            trades_placed += len(row.get("trades_placed") or [])

        context = {
            "recent_lessons":    lessons[:3],
            "key_levels":        levels,
            "trades_this_week":  trades_placed,
            "last_run_at":       rows[0].get("run_at") if rows else None,
            "last_market_notes": rows[0].get("market_notes", "") if rows else "",
        }
        log.info("context_loaded", lessons=len(lessons), levels=len(levels))
        return context

    def save_session(
        self,
        session_type:       str,
        signals_found:      list[dict],
        trades_placed:      list[dict],
        market_notes:       str = "",
        lessons_learned:    str = "",
        next_watch_levels:  Optional[dict] = None,
        signals_saved:      int = 0,
        duration_ms:        int = 0,
        error_log:          str = "",
    ) -> None:
        """Write a bot_memory row after a session completes."""
        try:
            self._sb.table("bot_memory").insert({
                "session_type":      session_type,
                "run_at":            datetime.now(tz=timezone.utc).isoformat(),
                "signals_found":     signals_found,
                "trades_placed":     trades_placed,
                "market_notes":      market_notes,
                "lessons_learned":   lessons_learned,
                "next_watch_levels": next_watch_levels or {},
                "signals_saved":     signals_saved,
                "duration_ms":       duration_ms,
                "error_log":         error_log,
            }).execute()
            log.info("session_saved", session_type=session_type,
                     signals=len(signals_found), trades=len(trades_placed))
        except Exception as e:
            log.error("save_session_error", error=str(e))

    # ── Signal persistence ────────────────────────────────────────────────────

    def save_signal(self, signal) -> Optional[int]:
        """Insert a SignalResult into smc_signals. Returns the new row id."""
        from signal_engine import SignalResult
        try:
            row = signal.to_db_dict()
            row["created_at"] = datetime.now(tz=timezone.utc).isoformat()
            row["data_status"] = "live"
            res = self._sb.table("smc_signals").insert(row).execute()
            sid = res.data[0]["id"] if res.data else None
            log.info("signal_saved", symbol=signal.symbol,
                     verdict=signal.verdict, id=sid)
            return sid
        except Exception as e:
            log.error("save_signal_error", error=str(e))
            return None

    # ── Execution log ─────────────────────────────────────────────────────────

    def log_execution(
        self,
        symbol:       str,
        direction:    Optional[str],
        action:       str,
        reason:       str,
        confidence:   Optional[int]  = None,
        entry_price:  Optional[float] = None,
        sl_price:     Optional[float] = None,
        lot_size:     Optional[float] = None,
        risk_usd:     Optional[float] = None,
        position_id:  Optional[int]  = None,
        session_type: str            = "adhoc",
        metadata:     Optional[dict] = None,
    ) -> None:
        """Write a row to execution_log for audit trail."""
        try:
            self._sb.table("execution_log").insert({
                "created_at":  datetime.now(tz=timezone.utc).isoformat(),
                "symbol":      symbol,
                "direction":   direction,
                "action":      action,
                "reason":      reason,
                "confidence":  confidence,
                "entry_price": entry_price,
                "sl_price":    sl_price,
                "lot_size":    lot_size,
                "risk_usd":    risk_usd,
                "position_id": position_id,
                "session_type": session_type,
                "metadata":    metadata or {},
            }).execute()
        except Exception as e:
            log.error("log_execution_error", action=action, symbol=symbol, error=str(e))

    # ── Equity snapshot ───────────────────────────────────────────────────────

    def take_equity_snapshot(self, account: dict, open_positions: list[dict]) -> None:
        """Insert an equity_snapshots row."""
        try:
            open_pnl = sum(float(p.get("pnl_usd") or 0) for p in open_positions)
            self._sb.table("equity_snapshots").insert({
                "created_at": datetime.now(tz=timezone.utc).isoformat(),
                "balance":    float(account.get("balance", 100_000)),
                "equity":     float(account.get("equity", 100_000)),
                "open_pnl":   open_pnl,
                "open_count": len(open_positions),
                "daily_pnl":  float(account.get("daily_pnl_usd", 0)),
                "source":     "daemon",
            }).execute()
        except Exception as e:
            log.error("equity_snapshot_error", error=str(e))
