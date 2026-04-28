"""
PropPilot AI — Journal Manager
CRUD layer for the Trading Journal system.

Completely isolated from the algo trading system.
Connects to the same Supabase instance but only touches journal_* tables.

Usage:
    jm = JournalManager()

    # Log a new trade
    trade_id = jm.log_trade({
        "symbol":       "XAU/USD",
        "direction":    "LONG",
        "entry_time":   "2026-04-28T09:15:00Z",
        "entry_price":  2340.50,
        "exit_price":   2358.00,
        "sl_price":     2330.00,
        "tp_price":     2360.00,
        "lot_size":     0.1,
        "pnl_usd":      175.0,
        "pnl_r":        1.75,
        "outcome":      "win",
        "strategy":     "SMC",
        "session":      "London",
        "entry_reason": "Clean sweep of prior day high, MSS confirmed, OTE zone",
        "mindset_score": 8,
        "followed_plan": True,
        "lessons_learned": "Waited patiently for the OTE — textbook entry",
    })

    # Fetch recent trades
    trades = jm.fetch_recent(limit=10)

    # Performance summary
    summary = jm.performance_summary()
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import structlog

import config

log = structlog.get_logger("journal_manager")


class JournalManager:
    """
    Supabase interface for the Trading Journal.
    All methods are synchronous (use asyncio.to_thread for async contexts).
    """

    def __init__(self) -> None:
        self._sb = config.get_supabase()

    # ── Write operations ──────────────────────────────────────────────────────

    def log_trade(self, data: dict) -> Optional[int]:
        """
        Insert a new trade into journal_trades.
        Returns the new trade id on success, None on failure.

        Required fields: symbol, direction
        Optional but recommended: entry_time, entry_price, exit_price,
            sl_price, pnl_r, outcome, strategy, session, entry_reason, mindset_score
        """
        now = datetime.now(tz=timezone.utc).isoformat()
        row = {
            "created_at": now,
            "updated_at": now,
            "account_id": data.get("account_id", 1),
            # Core
            "symbol":           data.get("symbol"),
            "direction":        data.get("direction"),
            "session":          data.get("session"),
            "timeframe":        data.get("timeframe"),
            # Execution
            "entry_time":       data.get("entry_time"),
            "exit_time":        data.get("exit_time"),
            "entry_price":      data.get("entry_price"),
            "exit_price":       data.get("exit_price"),
            "sl_price":         data.get("sl_price"),
            "tp_price":         data.get("tp_price"),
            "lot_size":         data.get("lot_size"),
            "risk_pct":         data.get("risk_pct"),
            # P&L
            "pnl_usd":          data.get("pnl_usd"),
            "pnl_r":            data.get("pnl_r"),
            "outcome":          data.get("outcome"),
            # Strategy
            "strategy":         data.get("strategy"),
            "setup_type":       data.get("setup_type"),
            "htf_trend":        data.get("htf_trend"),
            "confluence":       data.get("confluence"),
            # Context
            "entry_reason":     data.get("entry_reason"),
            "exit_reason":      data.get("exit_reason"),
            "market_context":   data.get("market_context"),
            "what_happened":    data.get("what_happened"),
            # Psychology
            "mindset_score":    data.get("mindset_score"),
            "emotions":         data.get("emotions"),
            "followed_plan":    data.get("followed_plan"),
            "impulsive":        data.get("impulsive", False),
            # Quality
            "entry_quality":    data.get("entry_quality"),
            "exit_quality":     data.get("exit_quality"),
            "risk_quality":     data.get("risk_quality"),
            "overall_rating":   data.get("overall_rating"),
            # Notes
            "lessons_learned":  data.get("lessons_learned"),
            "mistakes":         data.get("mistakes"),
            "tags":             data.get("tags"),
            "chart_url":        data.get("chart_url"),
            "screenshot_note":  data.get("screenshot_note"),
            # Source
            "smc_signal_id":    data.get("smc_signal_id"),
            "source":           data.get("source", "manual"),
        }
        # Remove None values to avoid overwriting defaults
        row = {k: v for k, v in row.items() if v is not None}

        try:
            res = self._sb.table("journal_trades").insert(row).execute()
            trade_id = res.data[0]["id"] if res.data else None
            log.info("journal_trade_logged",
                     symbol=data.get("symbol"),
                     direction=data.get("direction"),
                     outcome=data.get("outcome"),
                     pnl_r=data.get("pnl_r"),
                     id=trade_id)
            return trade_id
        except Exception as e:
            log.error("journal_log_error", error=str(e))
            return None

    def update_trade(self, trade_id: int, updates: dict) -> bool:
        """Update specific fields on an existing trade."""
        updates["updated_at"] = datetime.now(tz=timezone.utc).isoformat()
        try:
            self._sb.table("journal_trades").update(updates).eq("id", trade_id).execute()
            log.info("journal_trade_updated", id=trade_id, fields=list(updates.keys()))
            return True
        except Exception as e:
            log.error("journal_update_error", id=trade_id, error=str(e))
            return False

    def save_analysis(self, trade_id: int, analysis: dict) -> Optional[int]:
        """
        Save AI analysis to journal_analyses and update the parent trade
        with summary scores + verdict.
        """
        now = datetime.now(tz=timezone.utc).isoformat()
        row = {
            "trade_id":             trade_id,
            "created_at":           now,
            "entry_score":          analysis.get("entry_score"),
            "exit_score":           analysis.get("exit_score"),
            "risk_score":           analysis.get("risk_score"),
            "overall_score":        analysis.get("overall_score"),
            "what_happened":        analysis.get("what_happened"),
            "what_went_well":       analysis.get("what_went_well"),
            "what_to_improve":      analysis.get("what_to_improve"),
            "key_lesson":           analysis.get("key_lesson"),
            "pattern_identified":   analysis.get("pattern_identified"),
            "similar_trades_count": analysis.get("similar_trades_count"),
            "similar_win_rate":     analysis.get("similar_win_rate"),
            "user_edge_in_setup":   analysis.get("user_edge_in_setup"),
            "recommended_action":   analysis.get("recommended_action"),
            "recommendation_reason": analysis.get("recommendation_reason"),
            "verdict":              analysis.get("verdict"),
            "raw_groq_response":    analysis.get("raw_response"),
            "model_used":           analysis.get("model", "llama-3.3-70b-versatile"),
            "tokens_used":          analysis.get("tokens_used"),
        }
        row = {k: v for k, v in row.items() if v is not None}

        try:
            res = self._sb.table("journal_analyses").insert(row).execute()
            aid = res.data[0]["id"] if res.data else None

            # Update parent trade with AI summary
            self.update_trade(trade_id, {
                "ai_analyzed":    True,
                "ai_analyzed_at": now,
                "ai_entry_score": analysis.get("entry_score"),
                "ai_exit_score":  analysis.get("exit_score"),
                "ai_risk_score":  analysis.get("risk_score"),
                "ai_overall_score": analysis.get("overall_score"),
                "ai_verdict":     analysis.get("verdict"),
                "ai_key_lesson":  analysis.get("key_lesson"),
                "ai_pattern":     analysis.get("pattern_identified"),
            })
            log.info("journal_analysis_saved", trade_id=trade_id, analysis_id=aid,
                     verdict=analysis.get("verdict"), score=analysis.get("overall_score"))
            return aid
        except Exception as e:
            log.error("journal_analysis_error", trade_id=trade_id, error=str(e))
            return None

    # ── Read operations ───────────────────────────────────────────────────────

    def fetch_trade(self, trade_id: int) -> dict:
        """Fetch a single trade with its analysis."""
        try:
            res = (self._sb.table("journal_trades")
                   .select("*")
                   .eq("id", trade_id)
                   .single()
                   .execute())
            return res.data or {}
        except Exception as e:
            log.error("journal_fetch_error", id=trade_id, error=str(e))
            return {}

    def fetch_recent(self, limit: int = 20, account_id: int = 1) -> list[dict]:
        """Fetch the most recent N trades."""
        try:
            res = (self._sb.table("journal_trades")
                   .select("*")
                   .eq("account_id", account_id)
                   .order("created_at", desc=True)
                   .limit(limit)
                   .execute())
            return res.data or []
        except Exception as e:
            log.error("journal_fetch_recent_error", error=str(e))
            return []

    def fetch_unanalyzed(self, limit: int = 50, account_id: int = 1) -> list[dict]:
        """Fetch trades that haven't been analyzed by AI yet."""
        try:
            res = (self._sb.table("journal_trades")
                   .select("*")
                   .eq("account_id", account_id)
                   .eq("ai_analyzed", False)
                   .not_.is_("outcome", "null")
                   .order("created_at", desc=True)
                   .limit(limit)
                   .execute())
            return res.data or []
        except Exception as e:
            log.error("journal_fetch_unanalyzed_error", error=str(e))
            return []

    def fetch_by_symbol(self, symbol: str, limit: int = 50,
                        account_id: int = 1) -> list[dict]:
        """Fetch trades for a specific symbol."""
        try:
            res = (self._sb.table("journal_trades")
                   .select("*")
                   .eq("account_id", account_id)
                   .eq("symbol", symbol)
                   .order("entry_time", desc=True)
                   .limit(limit)
                   .execute())
            return res.data or []
        except Exception as e:
            log.error("journal_fetch_symbol_error", symbol=symbol, error=str(e))
            return []

    def fetch_by_session(self, session: str, limit: int = 50,
                         account_id: int = 1) -> list[dict]:
        """Fetch trades for a specific session."""
        try:
            res = (self._sb.table("journal_trades")
                   .select("*")
                   .eq("account_id", account_id)
                   .eq("session", session)
                   .order("entry_time", desc=True)
                   .limit(limit)
                   .execute())
            return res.data or []
        except Exception as e:
            log.error("journal_fetch_session_error", error=str(e))
            return []

    def fetch_all(self, account_id: int = 1, limit: int = 500) -> list[dict]:
        """Fetch all trades for pattern analysis."""
        try:
            res = (self._sb.table("journal_trades")
                   .select("*")
                   .eq("account_id", account_id)
                   .not_.is_("outcome", "null")
                   .order("entry_time", desc=True)
                   .limit(limit)
                   .execute())
            return res.data or []
        except Exception as e:
            log.error("journal_fetch_all_error", error=str(e))
            return []

    def fetch_patterns(self, account_id: int = 1) -> list[dict]:
        """Fetch learned patterns sorted by edge strength."""
        try:
            res = (self._sb.table("journal_patterns")
                   .select("*")
                   .eq("account_id", account_id)
                   .order("avg_r", desc=True)
                   .execute())
            return res.data or []
        except Exception as e:
            log.error("journal_fetch_patterns_error", error=str(e))
            return []

    def fetch_pattern_for_setup(
        self,
        symbol:    str,
        session:   str,
        direction: str,
        strategy:  Optional[str] = None,
        account_id: int = 1,
    ) -> Optional[dict]:
        """
        Find the best-matching pattern for a current market setup.
        Uses fn_journal_pattern_match() Postgres function.
        """
        try:
            res = self._sb.rpc("fn_journal_pattern_match", {
                "p_account_id": account_id,
                "p_symbol":     symbol,
                "p_session":    session,
                "p_direction":  direction,
                "p_strategy":   strategy,
            }).execute()
            rows = res.data or []
            return rows[0] if rows else None
        except Exception as e:
            log.warning("journal_pattern_match_error", error=str(e))
            return None

    # ── Analytics ─────────────────────────────────────────────────────────────

    def performance_summary(self, account_id: int = 1) -> dict:
        """
        Compute overall journal statistics from closed trades.
        Returns a dict with key metrics.
        """
        trades = self.fetch_all(account_id=account_id, limit=1000)
        if not trades:
            return {"total_trades": 0, "message": "No closed trades in journal yet"}

        wins   = [t for t in trades if t.get("outcome") == "win"]
        losses = [t for t in trades if t.get("outcome") == "loss"]
        r_vals = [float(t["pnl_r"]) for t in trades if t.get("pnl_r") is not None]
        pnl    = [float(t["pnl_usd"]) for t in trades if t.get("pnl_usd") is not None]

        total   = len(trades)
        win_rt  = len(wins) / total * 100 if total else 0.0
        avg_r   = sum(r_vals) / len(r_vals) if r_vals else 0.0
        total_r = sum(r_vals)
        total_pnl = sum(pnl)

        mindset_scores = [t["mindset_score"] for t in trades
                          if t.get("mindset_score") is not None]
        avg_mindset = sum(mindset_scores) / len(mindset_scores) if mindset_scores else None

        off_plan = sum(1 for t in trades if t.get("followed_plan") is False)

        # Best and worst symbol
        from collections import defaultdict
        sym_r: dict = defaultdict(list)
        for t in trades:
            if t.get("pnl_r") is not None:
                sym_r[t["symbol"]].append(float(t["pnl_r"]))
        sym_avg = {s: sum(rs) / len(rs) for s, rs in sym_r.items() if rs}
        best_symbol  = max(sym_avg, key=sym_avg.get) if sym_avg else None
        worst_symbol = min(sym_avg, key=sym_avg.get) if sym_avg else None

        log.info("performance_summary_built",
                 trades=total, win_rate=f"{win_rt:.1f}%", total_r=f"{total_r:+.2f}R")

        return {
            "total_trades":    total,
            "wins":            len(wins),
            "losses":          len(losses),
            "win_rate_pct":    round(win_rt, 1),
            "avg_r":           round(avg_r, 3),
            "total_r":         round(total_r, 2),
            "total_pnl_usd":   round(total_pnl, 2),
            "avg_mindset":     round(avg_mindset, 1) if avg_mindset else None,
            "off_plan_trades": off_plan,
            "off_plan_pct":    round(off_plan / total * 100, 1) if total else 0,
            "best_symbol":     best_symbol,
            "worst_symbol":    worst_symbol,
        }

    def refresh_patterns(self, account_id: int = 1) -> int:
        """
        Trigger fn_refresh_journal_patterns() to recompute patterns from trade history.
        Returns count of patterns updated.
        """
        try:
            res = self._sb.rpc("fn_refresh_journal_patterns",
                               {"p_account_id": account_id}).execute()
            count = res.data or 0
            log.info("patterns_refreshed", count=count, account_id=account_id)
            return int(count)
        except Exception as e:
            log.error("patterns_refresh_error", error=str(e))
            return 0
