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
from memory_manager  import MemoryManager
from risk_engine     import RiskEngine
from signal_engine   import SignalResult, analyze

log = structlog.get_logger("main")

# ─── Runtime config ───────────────────────────────────────────────────────────

PROP_PROFILE   = os.getenv("PROP_PROFILE",   "paper")
EXECUTION_MODE = os.getenv("EXECUTION_MODE", "paper")    # paper | live_mt5 | live_oanda
DRY_RUN        = os.getenv("DRY_RUN", "false").lower() == "true"
HEALTHCHECK_PORT = int(os.getenv("HEALTHCHECK_PORT", "8765"))

# How often to run the analysis loop (seconds) during an active session
ANALYZE_INTERVAL_S = int(os.getenv("ANALYZE_INTERVAL_S", "900"))  # 15 min

# How often to update open positions via Edge Function (seconds)
POSITION_UPDATE_S  = int(os.getenv("POSITION_UPDATE_S", "300"))   # 5 min

# Symbols to monitor — space-separated env var or defaults
SYMBOLS = os.getenv(
    "SYMBOLS",
    "XAU/USD EUR/USD GBP/USD USD/JPY NAS100 BTC/USD"
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
        self._stop   = asyncio.Event()
        self._session_signals: list[dict] = []
        self._session_trades:  list[dict] = []
        self._session_start:   Optional[float] = None
        self._session_name:    str = "adhoc"

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        log.info("daemon_starting",
                 prop_profile=PROP_PROFILE,
                 execution_mode=EXECUTION_MODE,
                 dry_run=DRY_RUN,
                 symbols=SYMBOLS)

        # Wire graceful shutdown
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self._request_stop)

        # Run the three concurrent tasks
        await asyncio.gather(
            self.feed.start(),               # WebSocket streams
            self._analyze_loop(),            # signal + trade decisions
            self._position_update_loop(),    # update open positions
            self._healthcheck_server(),      # simple TCP health endpoint
        )

    def _request_stop(self) -> None:
        log.info("shutdown_requested")
        self._stop.set()
        self.feed.stop()

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

            # Take an equity snapshot at the start of each analysis cycle
            self.memory.take_equity_snapshot(account, positions)

            session_signals: list[SignalResult] = []

            for symbol in SYMBOLS:
                store = self.feed.stores.get(symbol)
                if store is None:
                    log.debug("no_store_for_symbol", symbol=symbol)
                    continue

                try:
                    sig = analyze(symbol, store, self._session_name)
                    log.info("signal_analyzed",
                             symbol=symbol,
                             verdict=sig.verdict,
                             confidence=sig.confidence,
                             direction=sig.direction)
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
                    )
                    continue

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

    # ── Position update loop ──────────────────────────────────────────────────

    async def _position_update_loop(self) -> None:
        """
        Triggers the update-paper-positions Edge Function every 5 minutes.
        Independently checks whether kill-switch should be activated.
        """
        await asyncio.sleep(60)   # Initial delay
        log.info("position_update_loop_started")

        while not self._stop.is_set():
            try:
                data = await self.exec.trigger_position_update()
                log.debug("positions_updated",
                          updated=data.get("updated", 0),
                          closed=data.get("closed", 0))

                # Kill-switch check after position updates
                account  = self.memory.fetch_account()
                settings = self.memory.fetch_settings()
                if (not account.get("kill_switch_active") and
                        RiskEngine.should_trigger_kill_switch(account, settings)):
                    reason = (
                        f"Daily loss limit breached: "
                        f"${account.get('daily_pnl_usd', 0):.2f}"
                    )
                    self.memory.update_kill_switch(reason)
                    log.warning("kill_switch_auto_triggered", reason=reason)

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
    print(
        f"\n{'='*60}\n"
        f"  PropPilot AI Daemon\n"
        f"  Profile : {PROP_PROFILE}\n"
        f"  Mode    : {EXECUTION_MODE}\n"
        f"  Dry run : {DRY_RUN}\n"
        f"  Symbols : {', '.join(SYMBOLS)}\n"
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
