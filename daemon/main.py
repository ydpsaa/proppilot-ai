"""
PropPilot AI — Main Daemon
Entry point for the VPS trading daemon.

Architecture
────────────
• DataFeed  — async WebSocket streams → CandleStore
• Scheduler — fires analyze_and_act() at session open + every 15 min during session
• Loop      — 5-min position update heartbeat
• Shutdown  — SIGINT/SIGTERM → graceful DataFeed teardown, final snapshot

Env file: daemon/.env  (copy .env.example and fill in secrets)

Run:
    cd daemon
    python main.py

Run with specific profile:
    PROP_PROFILE=ftmo_standard python main.py

Run in dry-run (no trades, just signals):
    DRY_RUN=true python main.py
"""

from __future__ import annotations

import asyncio
import os
import signal
import time
from datetime import datetime, timezone
from typing import Optional

import structlog

import config
config.setup_logging()

from ai_coach        import AICoach
from data_feed       import DataFeed
from execution_engine import ExecutionEngine
from journal_manager import JournalManager
from memory_manager  import MemoryManager
from news_filter     import NewsFilter
from outcome_tracker import OutcomeTracker
from risk_engine     import RiskEngine
from signal_engine   import SignalResult, analyze

# MT5 monitor — started only when EXECUTION_MODE=live_mt5
_MT5_MONITOR = None

log = structlog.get_logger("main")

# ─── Runtime config ───────────────────────────────────────────────────────────

PROP_PROFILE   = os.getenv("PROP_PROFILE",   "paper")
EXECUTION_MODE = os.getenv("EXECUTION_MODE", "paper")    # paper | live_mt5 | live_oanda
DRY_RUN        = os.getenv("DRY_RUN", "false").lower() == "true"
HEALTHCHECK_PORT = int(os.getenv("HEALTHCHECK_PORT", "8765"))

# ── Prop challenge integration (optional) ─────────────────────────────────────
# Set CHALLENGE_ID=<int> in .env to enable real-time prop rule checking.
# When set, every proposed trade is validated against the challenge's ruleset
# and closed trades are automatically recorded to prop_daily_stats.
_CHALLENGE_ID_STR = os.getenv("CHALLENGE_ID", "")
CHALLENGE_ID: Optional[int] = int(_CHALLENGE_ID_STR) if _CHALLENGE_ID_STR.isdigit() else None

# How often to run the analysis loop (seconds) during an active session
ANALYZE_INTERVAL_S = int(os.getenv("ANALYZE_INTERVAL_S", "900"))  # 15 min

# How often to update open positions via Edge Function (seconds)
POSITION_UPDATE_S  = int(os.getenv("POSITION_UPDATE_S", "300"))   # 5 min
FEED_STALE_LIMIT_S = int(os.getenv("FEED_STALE_LIMIT_S", "30"))

# Symbols to monitor — space-separated env var or defaults
SYMBOLS = os.getenv(
    "SYMBOLS",
    " ".join(config.TRADING_CONFIG.get(
        "symbols",
        ["XAU/USD", "EUR/USD", "GBP/USD", "USD/JPY", "NAS100"],
    ))
).split()

# ─── Helpers ─────────────────────────────────────────────────────────────────

def _now_utc() -> datetime:
    return datetime.now(tz=timezone.utc)


def _is_trading_hours() -> bool:
    """
    True between 07:00–21:00 UTC Mon–Fri (covers London+NY sessions).
    Paper mode always returns True.
    """
    if PROP_PROFILE == "paper":
        return True
    now = _now_utc()
    if now.weekday() >= 5:       # Saturday=5, Sunday=6
        return False
    return 7 <= now.hour < 21


# ─── Core session logic ───────────────────────────────────────────────────────

class PropPilotDaemon:
    """
    Top-level orchestrator.
    Owns the DataFeed, engine singletons, and the main event loop.
    """

    def __init__(self):
        self.feed    = DataFeed(symbols=SYMBOLS)
        self.memory  = MemoryManager()
        self.risk    = RiskEngine(prop_profile=PROP_PROFILE)
        self.exec    = ExecutionEngine(mode=EXECUTION_MODE)
        self.coach   = AICoach()
        self.tracker = OutcomeTracker()
        self.journal = JournalManager()
        self.news    = NewsFilter(enabled=os.getenv("NEWS_FILTER_ENABLED", "true").lower() == "true")
        self._stop   = asyncio.Event()
        self._last_feed_tick = time.monotonic()
        self._session_signals: list[dict] = []
        self._session_trades:  list[dict] = []
        self._session_start:   Optional[float] = None
        self._session_name:    str = "adhoc"
        # Maps position_id → journal_trade_id so we can update journal on close
        self._position_journal_map: dict[str, int] = {}

        # Prop challenge systems (optional — only active when CHALLENGE_ID is set)
        self._prop_rules = None
        self._prop_coach = None
        if CHALLENGE_ID is not None:
            try:
                from rules_engine import RulesEngine
                from prop_coach   import PropCoach
                self._prop_rules = RulesEngine(CHALLENGE_ID)
                self._prop_coach = PropCoach(CHALLENGE_ID)
                log.info("prop_challenge_active", challenge_id=CHALLENGE_ID)
            except Exception as e:
                log.warning("prop_challenge_init_error", error=str(e))

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        log.info("daemon_starting",
                 prop_profile=PROP_PROFILE,
                 execution_mode=EXECUTION_MODE,
                 dry_run=DRY_RUN,
                 symbols=SYMBOLS,
                 challenge_id=CHALLENGE_ID)

        # Log challenge status on startup if a challenge is active
        if self._prop_rules is not None and CHALLENGE_ID is not None:
            try:
                status = await asyncio.to_thread(
                    self._prop_rules._tracker.get_status
                )
                if status:
                    log.info("challenge_status_on_start",
                             firm=status.rules.firm_name,
                             phase=status.current_phase,
                             balance=status.current_balance,
                             pnl_pct=f"{status.total_pnl_pct:+.2f}%",
                             profit_progress=f"{status.profit_progress_pct:.0f}%",
                             daily_remaining=status.daily_loss_remaining_usd,
                             dd_remaining=status.total_dd_remaining_usd,
                             days_left=status.days_remaining)
                    for alert in status.alerts:
                        log.warning("challenge_alert", msg=alert)
            except Exception as e:
                log.warning("challenge_status_startup_error", error=str(e))

        # Start MT5 position monitor if running in live MT5 mode
        if EXECUTION_MODE == "live_mt5":
            global _MT5_MONITOR
            try:
                from mt5_executor import MT5PositionMonitor
                # MT5Executor is lazily created inside ExecutionEngine on first trade
                # Monitor starts as a daemon thread — non-blocking
                _MT5_MONITOR = MT5PositionMonitor(
                    executor       = None,   # will be injected after first trade
                    memory_manager = self.memory,
                )
                log.info("mt5_monitor_deferred",
                         msg="Monitor will activate after first trade execution")
            except Exception as e:
                log.warning("mt5_monitor_init_skip", error=str(e))

        for store in self.feed.stores.values():
            store.add_callback(lambda _c: self._mark_feed_tick())

        # Wire graceful shutdown
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self._request_stop)

        # Run the concurrent tasks
        await asyncio.gather(
            self.feed.start(),               # WebSocket streams
            self._analyze_loop(),            # signal + trade decisions
            self._position_update_loop(),    # update open positions + outcomes
            self._healthcheck_server(),      # simple TCP health endpoint
        )

    def _request_stop(self) -> None:
        log.info("shutdown_requested")
        self._stop.set()
        try:
            asyncio.create_task(self.feed.stop())
        except RuntimeError:
            pass

    def _mark_feed_tick(self) -> None:
        """Record the latest data-feed heartbeat for stale-feed kill-switch logic."""
        self._last_feed_tick = time.monotonic()

    # ── Analysis loop ─────────────────────────────────────────────────────────

    async def _analyze_loop(self) -> None:
        """
        Every ANALYZE_INTERVAL_S seconds during trading hours:
        1. Detect active session
        2. Run signal analysis for each symbol
        3. Pass high-confidence signals through risk engine
        4. Execute trades (or log DRY_RUN)
        5. Save session memory when loop pauses
        """
        await asyncio.sleep(30)          # Let DataFeed warm up first
        log.info("analyze_loop_started")

        while not self._stop.is_set():
            if not _is_trading_hours():
                log.debug("outside_trading_hours_sleeping")
                await asyncio.sleep(600)
                continue

            self._session_start = time.monotonic()
            self._detect_session()

            account    = self.memory.fetch_account()
            settings   = self.memory.fetch_settings()
            positions  = self.memory.fetch_open_positions()
            context    = self.memory.load_context(n=5)
            strategy_weights = self.memory.fetch_strategy_weights()

            # Take an equity snapshot at the start of each analysis cycle
            self.memory.take_equity_snapshot(account, positions)

            session_signals: list[SignalResult] = []

            for symbol in SYMBOLS:
                store = self.feed.stores.get(symbol)
                if store is None:
                    log.debug("no_store_for_symbol", symbol=symbol)
                    continue

                try:
                    sig = analyze(symbol, store, self._session_name, strategy_weights)
                    log.info("signal_analyzed",
                             symbol=symbol,
                             verdict=sig.verdict,
                             confidence=sig.confidence,
                             direction=sig.direction,
                             market_regime=sig.market_regime.name if sig.market_regime else None)
                    session_signals.append(sig)
                    self._session_signals.append(sig.to_db_dict())

                    # Save signal to DB regardless of verdict
                    self.memory.save_signal(sig)

                except Exception as e:
                    log.error("signal_analysis_error", symbol=symbol, error=str(e))
                    continue

                # Only act on actionable verdicts
                if sig.verdict not in ("LONG_NOW", "SHORT_NOW"):
                    continue

                news_blocked, news_reason = await asyncio.to_thread(
                    self.news.is_blocked, symbol, _now_utc()
                )
                if news_blocked:
                    log.info("trade_blocked_news", symbol=symbol, reason=news_reason)
                    self.memory.log_execution(
                        symbol=symbol,
                        direction=sig.direction,
                        action="REJECT_NEWS_BLOCK",
                        reason=news_reason,
                        confidence=sig.confidence,
                        entry_price=sig.entry_price,
                        sl_price=sig.sl_price,
                        session_type=self._session_name,
                        metadata={"market_regime": sig.market_regime.to_dict() if sig.market_regime else {}},
                    )
                    continue

                # Risk check
                risk = self.risk.check(sig, account, settings, positions)
                if not risk.passed:
                    log.info("trade_blocked", symbol=symbol,
                             action=risk.action, reason=risk.reason)
                    self.memory.log_execution(
                        symbol=symbol,
                        direction=sig.direction,
                        action=risk.action,
                        reason=risk.reason,
                        confidence=sig.confidence,
                        entry_price=sig.entry_price,
                        sl_price=sig.sl_price,
                        session_type=self._session_name,
                        metadata={"market_regime": sig.market_regime.to_dict() if sig.market_regime else {}},
                    )
                    continue

                # Prop challenge rule check (hard block if CHALLENGE_ID set)
                if self._prop_rules is not None:
                    try:
                        prop_check = await asyncio.to_thread(
                            self._prop_rules.check,
                            risk.risk_usd or 0.0,
                            risk.lot_size  or 0.0,
                            symbol,
                            self._session_name,
                        )
                        if not prop_check.passed:
                            block_reason = "; ".join(prop_check.reasons)
                            log.warning("trade_blocked_prop_rules",
                                        symbol=symbol, reasons=prop_check.reasons)
                            self.memory.log_execution(
                                symbol=symbol,
                                direction=sig.direction,
                                action="REJECT_PROP_RULES",
                                reason=block_reason,
                                confidence=sig.confidence,
                                entry_price=sig.entry_price,
                                sl_price=sig.sl_price,
                                session_type=self._session_name,
                            )
                            continue
                        # Log soft warnings so they appear in execution log
                        if prop_check.warnings:
                            log.info("prop_rule_warnings",
                                     symbol=symbol, warnings=prop_check.warnings)
                    except Exception as e:
                        log.warning("prop_rules_check_error", error=str(e))

                # AI pre-trade narrative (best-effort, non-blocking)
                try:
                    narrative = await asyncio.to_thread(
                        self.coach.pre_trade_narrative, sig, account, context
                    )
                    log.info("pre_trade_narrative", symbol=symbol, text=narrative[:120])
                except Exception as e:
                    log.warning("ai_narrative_error", error=str(e))
                    narrative = ""

                if DRY_RUN:
                    log.info("DRY_RUN_skipping_trade",
                             symbol=symbol, direction=sig.direction,
                             confidence=sig.confidence)
                    self.memory.log_execution(
                        symbol=symbol,
                        direction=sig.direction,
                        action="DRY_RUN",
                        reason=f"DRY_RUN: would have traded. {narrative[:80]}",
                        confidence=sig.confidence,
                        entry_price=sig.entry_price,
                        sl_price=sig.sl_price,
                        session_type=self._session_name,
                        metadata={"market_regime": sig.market_regime.to_dict() if sig.market_regime else {}},
                    )
                    continue

                # Execute trade
                result = await self.exec.open_trade(sig, risk, self._session_name)

                self.memory.log_execution(
                    symbol=symbol,
                    direction=sig.direction,
                    action="OPEN" if result.success else "OPEN_FAILED",
                    reason=narrative[:200] if result.success else (result.error or ""),
                    confidence=sig.confidence,
                    entry_price=result.entry_price,
                    sl_price=result.sl_price,
                    lot_size=result.lot_size,
                    risk_usd=result.risk_usd,
                    position_id=result.position_id,
                    session_type=self._session_name,
                )

                if result.success:
                    positions = self.memory.fetch_open_positions()  # refresh
                    self._session_trades.append({
                        "symbol":       result.symbol,
                        "direction":    result.direction,
                        "entry_price":  result.entry_price,
                        "success":      True,
                        "position_id":  result.position_id,
                    })
                    account = self.memory.fetch_account()  # refresh balance

                    # ── Log opened trade to Trading Journal ───────────────────
                    try:
                        sig_dict = sig.to_db_dict()
                        journal_trade_id = await asyncio.to_thread(
                            self.journal.log_trade, {
                                "symbol":         result.symbol,
                                "direction":      result.direction,
                                "session":        self._session_name,
                                "entry_time":     datetime.now(tz=timezone.utc).isoformat(),
                                "entry_price":    result.entry_price,
                                "sl_price":       result.sl_price,
                                "tp_price":       sig_dict.get("tp1_price") or sig_dict.get("tp_price"),
                                "lot_size":       result.lot_size,
                                "strategy":       "SMC",
                                "setup_type":     sig_dict.get("setup_type"),
                                "htf_trend":      sig_dict.get("htf_trend") or (
                                    sig.market_regime.name if sig.market_regime else None
                                ),
                                "confluence":     sig_dict.get("confluence", []),
                                "entry_reason":   narrative[:400] if narrative else sig.verdict,
                                "market_context": (
                                    f"Regime: {sig.market_regime.name}"
                                    if sig.market_regime else ""
                                ),
                                "smc_signal_id":  sig_dict.get("id"),
                                "source":         "algo",
                                "followed_plan":  True,
                            }
                        )
                        if journal_trade_id and result.position_id:
                            self._position_journal_map[str(result.position_id)] = journal_trade_id
                        log.info("journal_trade_opened",
                                 symbol=symbol,
                                 journal_id=journal_trade_id,
                                 position_id=result.position_id)
                    except Exception as je:
                        log.warning("journal_open_log_error", symbol=symbol, error=str(je))

                    # Wire MT5 monitor to the executor after first live trade
                    global _MT5_MONITOR
                    if (EXECUTION_MODE == "live_mt5" and _MT5_MONITOR is not None
                            and self.exec._mt5 is not None
                            and not _MT5_MONITOR._thread.is_alive()):
                        _MT5_MONITOR._exec = self.exec._mt5
                        _MT5_MONITOR.start()
                        log.info("mt5_monitor_activated")

                    # NOTE: prop trade P&L is recorded after the trade closes
                    # (in _position_update_loop when outcome_tracker detects close).
                    # On open we only check rules — recording happens on exit.

            # End-of-cycle: generate session summary if we saw any signals
            if session_signals:
                await self._save_session_memory(session_signals, account)

            # Reset per-cycle accumulators
            self._session_signals = []
            self._session_trades  = []

            # Wait for next cycle or stop
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=ANALYZE_INTERVAL_S)
            except asyncio.TimeoutError:
                pass

        log.info("analyze_loop_stopped")

    async def _save_session_memory(
        self, signals: list[SignalResult], account: dict
    ) -> None:
        """Generate AI summary and persist bot_memory row."""
        sig_dicts   = [s.to_db_dict() for s in signals]
        trade_dicts = self._session_trades.copy()

        market_notes  = ""
        lessons       = ""
        watch_levels: dict = {}

        try:
            market_notes, lessons, watch_levels = await asyncio.to_thread(
                self.coach.session_summary,
                sig_dicts,
                trade_dicts,
                account,
                self._session_name,
            )
        except Exception as e:
            log.warning("session_summary_error", error=str(e))

        duration_ms = int((time.monotonic() - (self._session_start or 0)) * 1000)

        self.memory.save_session(
            session_type      = self._session_name,
            signals_found     = sig_dicts,
            trades_placed     = trade_dicts,
            market_notes      = market_notes,
            lessons_learned   = lessons,
            next_watch_levels = watch_levels,
            signals_saved     = len(sig_dicts),
            duration_ms       = duration_ms,
        )
        log.info("session_memory_saved",
                 session=self._session_name,
                 signals=len(sig_dicts),
                 trades=len(trade_dicts))

        # Refresh journal patterns after each session (non-blocking, best-effort)
        if trade_dicts:
            try:
                n = await asyncio.to_thread(self.journal.refresh_patterns)
                log.info("journal_patterns_refreshed", patterns=n)
            except Exception as e:
                log.warning("journal_patterns_refresh_error", error=str(e))

    # ── Journal: sync closed positions ───────────────────────────────────────

    async def _sync_closed_journal_trades(self) -> None:
        """
        Check paper_positions for any recently closed positions that have a
        corresponding journal entry. Update those entries with exit info + outcome.
        Runs best-effort inside position_update_loop — never raises.
        """
        if not self._position_journal_map:
            return

        try:
            sb = self.memory._sb  # reuse MemoryManager's Supabase client
            # Fetch recently closed paper positions (last 24 h)
            closed = sb.table("paper_positions") \
                .select("id,symbol,direction,entry_price,exit_price,pnl_usd,pnl_r,outcome,exit_time,sl_price,tp_price") \
                .eq("status", "closed") \
                .in_("id", list(map(int, self._position_journal_map.keys()))) \
                .execute()

            rows = closed.data or []
            for pos in rows:
                pos_id = str(pos["id"])
                journal_id = self._position_journal_map.get(pos_id)
                if not journal_id:
                    continue

                # Map paper_position outcome → journal outcome
                raw_outcome = pos.get("outcome") or ""
                if "tp2" in raw_outcome:
                    journal_outcome = "win"
                elif "tp1" in raw_outcome:
                    journal_outcome = "partial_win"
                elif "sl" in raw_outcome:
                    journal_outcome = "loss"
                else:
                    journal_outcome = "manual_close"

                updated = await asyncio.to_thread(
                    self.journal.update_trade, journal_id, {
                        "exit_time":   pos.get("exit_time"),
                        "exit_price":  pos.get("exit_price"),
                        "pnl_usd":     pos.get("pnl_usd"),
                        "pnl_r":       pos.get("pnl_r"),
                        "outcome":     journal_outcome,
                        "exit_reason": raw_outcome,
                    }
                )
                if updated:
                    log.info("journal_trade_closed",
                             journal_id=journal_id,
                             position_id=pos_id,
                             outcome=journal_outcome,
                             pnl_r=pos.get("pnl_r"))
                    # Remove from map — already settled
                    del self._position_journal_map[pos_id]

        except Exception as e:
            log.warning("journal_sync_closed_error", error=str(e))

    # ── Position update loop ──────────────────────────────────────────────────

    async def _position_update_loop(self) -> None:
        """
        Every POSITION_UPDATE_S seconds (default 5 min):
          1. Trigger update-paper-positions Edge Function
          2. Check and activate kill-switch if daily loss limit breached
          3. Run OutcomeTracker to mark tp1_hit / tp2_hit / sl_hit on smc_signals
        """
        await asyncio.sleep(60)   # Initial delay — let DataFeed warm up
        log.info("position_update_loop_started")

        # Backfill any outcomes missed while daemon was offline
        try:
            summary = await asyncio.to_thread(
                self.tracker.backfill, self.feed.stores, 500
            )
            log.info("outcome_backfill_complete", **summary)
        except Exception as e:
            log.warning("outcome_backfill_error", error=str(e))

        while not self._stop.is_set():
            try:
                # 1. Paper position P&L update
                data = await self.exec.trigger_position_update()
                log.debug("positions_updated",
                          updated=data.get("updated", 0),
                          closed=data.get("closed", 0))

                # 2. Kill-switch check
                account  = self.memory.fetch_account()
                settings = self.memory.fetch_settings()
                feed_stale_s = time.monotonic() - self._last_feed_tick
                if feed_stale_s > FEED_STALE_LIMIT_S and not account.get("kill_switch_active"):
                    reason = f"Data feed stale for {feed_stale_s:.0f}s"
                    self.memory.update_kill_switch(reason)
                    log.warning("kill_switch_feed_stale", reason=reason)
                    account = self.memory.fetch_account()
                if (not account.get("kill_switch_active") and
                        RiskEngine.should_trigger_kill_switch(account, settings)):
                    reason = (
                        f"Daily loss limit breached: "
                        f"${account.get('daily_pnl_usd', 0):.2f}"
                    )
                    self.memory.update_kill_switch(reason)
                    log.warning("kill_switch_auto_triggered", reason=reason)

                # 3. Outcome tracking for smc_signals
                outcomes = await asyncio.to_thread(
                    self.tracker.run, self.feed.stores
                )
                if outcomes:
                    log.info("signal_outcomes_recorded",
                             count=len(outcomes),
                             breakdown={o.outcome: sum(
                                 1 for x in outcomes if x.outcome == o.outcome
                             ) for o in outcomes})

                # 4. Sync closed positions back to journal
                await self._sync_closed_journal_trades()

            except Exception as e:
                log.error("position_update_loop_error", error=str(e))

            try:
                await asyncio.wait_for(self._stop.wait(), timeout=POSITION_UPDATE_S)
            except asyncio.TimeoutError:
                pass

        log.info("position_update_loop_stopped")

    # ── Session detection ─────────────────────────────────────────────────────

    def _detect_session(self) -> None:
        """Set self._session_name based on current UTC time."""
        now = _now_utc()
        h, m = now.hour, now.minute

        # Rough session boundaries (UTC)
        if 0 <= h < 7:
            self._session_name = "Asia"
        elif h == 7:
            self._session_name = "Frankfurt"
        elif 8 <= h < 12:
            self._session_name = "London"
        elif 12 <= h < 17:
            self._session_name = "Overlap"
        elif 17 <= h < 21:
            self._session_name = "NewYork"
        else:
            self._session_name = "Dead"

        log.debug("session_detected", session=self._session_name,
                  utc=f"{h:02d}:{m:02d}")

    # ── Healthcheck ───────────────────────────────────────────────────────────

    async def _healthcheck_server(self) -> None:
        """
        Tiny TCP server on HEALTHCHECK_PORT.
        Responds 'OK\n' to any connection — useful for Docker/systemd health probes.
        """
        async def handle(reader, writer):
            writer.write(b"OK\n")
            await writer.drain()
            writer.close()

        try:
            srv = await asyncio.start_server(handle, "0.0.0.0", HEALTHCHECK_PORT)
            log.info("healthcheck_server_started", port=HEALTHCHECK_PORT)
            async with srv:
                await self._stop.wait()
        except Exception as e:
            log.warning("healthcheck_server_error", error=str(e))


# ─── Entry point ──────────────────────────────────────────────────────────────

def main() -> None:
    import sys

    # Friendly startup banner
    challenge_line = (
        f"  Challenge: #{CHALLENGE_ID} (prop rules active)\n"
        if CHALLENGE_ID else
        "  Challenge: none\n"
    )
    print(
        f"\n{'='*60}\n"
        f"  PropPilot AI Daemon\n"
        f"  Profile : {PROP_PROFILE}\n"
        f"  Mode    : {EXECUTION_MODE}\n"
        f"  Dry run : {DRY_RUN}\n"
        f"  Symbols : {', '.join(SYMBOLS)}\n"
        f"{challenge_line}"
        f"  Started : {_now_utc().strftime('%Y-%m-%d %H:%M:%S')} UTC\n"
        f"{'='*60}\n"
    )

    daemon = PropPilotDaemon()

    try:
        asyncio.run(daemon.start())
    except KeyboardInterrupt:
        pass
    finally:
        log.info("daemon_exited")
        sys.exit(0)


if __name__ == "__main__":
    main()
