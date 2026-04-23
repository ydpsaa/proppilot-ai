"""
PropPilot AI — Execution Engine
Handles trade placement in paper or live mode.

Paper mode: calls execute-paper-trade Edge Function (Supabase).
Live mode:  stubs for MT5 / OANDA / Alpaca (enable per broker).

The engine is intentionally thin — all risk logic lives in risk_engine.py.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import httpx
import structlog

import config
from risk_engine import RiskCheck
from signal_engine import SignalResult

log = structlog.get_logger("execution_engine")

# ─── Result types ─────────────────────────────────────────────────────────────

@dataclass
class TradeResult:
    success:      bool
    position_id:  Optional[int]
    symbol:       str
    direction:    str
    lot_size:     float
    entry_price:  float
    sl_price:     float
    tp1_price:    float
    tp2_price:    float
    risk_usd:     float
    error:        Optional[str] = None
    raw_response: Optional[dict] = None

    def __bool__(self) -> bool:
        return self.success


# ─── Execution Engine ─────────────────────────────────────────────────────────

class ExecutionEngine:
    """
    Stateless trade executor.
    Usage:
        engine = ExecutionEngine(mode="paper")
        result = await engine.open_trade(signal, risk_check, session_type)
    """

    def __init__(self, mode: str = "paper"):
        self.mode = mode.lower()
        log.info("execution_engine_init", mode=self.mode)

    async def open_trade(
        self,
        signal:       SignalResult,
        risk_check:   RiskCheck,
        session_type: str = "adhoc",
    ) -> TradeResult:
        """Open a new trade based on a valid signal + risk check."""
        if not risk_check.passed:
            raise ValueError(f"Cannot open trade — risk check failed: {risk_check.reason}")

        if self.mode == "paper":
            return await self._open_paper(signal, risk_check, session_type)
        elif self.mode == "live_mt5":
            return await self._open_live_mt5(signal, risk_check)
        elif self.mode == "live_alpaca":
            return await self._open_live_alpaca(signal, risk_check)
        elif self.mode == "live_oanda":
            return await self._open_live_oanda(signal, risk_check)
        else:
            log.error("unknown_execution_mode", mode=self.mode)
            return TradeResult(
                success=False, position_id=None,
                symbol=signal.symbol, direction=signal.direction or "",
                lot_size=0.0, entry_price=0.0, sl_price=0.0,
                tp1_price=0.0, tp2_price=0.0, risk_usd=0.0,
                error=f"Unknown execution mode: {self.mode}",
            )

    # ── Paper execution via Edge Function ──────────────────────────────────────

    async def _open_paper(
        self, signal: SignalResult, risk_check: RiskCheck, session_type: str
    ) -> TradeResult:
        """POST to execute-paper-trade Supabase Edge Function."""
        if signal.entry_price is None:
            return TradeResult(
                success=False, position_id=None,
                symbol=signal.symbol, direction=signal.direction or "",
                lot_size=0.0, entry_price=0.0, sl_price=0.0,
                tp1_price=0.0, tp2_price=0.0, risk_usd=0.0,
                error="No entry price from signal engine",
            )

        payload = {
            "symbol":       signal.symbol,
            "direction":    signal.direction,
            "entry_price":  signal.entry_price,
            "sl_price":     signal.sl_price,
            "tp1_price":    signal.tp1_price,
            "tp2_price":    signal.tp2_price,
            "confidence":   signal.confidence,
            "session_type": session_type,
            "signal_id":    None,
            "atr":          signal.atr,
            "notes":        f"SMC: {', '.join(signal.reasoning_codes[:3])}",
        }

        log.info("opening_paper_trade", symbol=signal.symbol,
                 direction=signal.direction, entry=signal.entry_price,
                 confidence=signal.confidence)

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.post(
                    config.EDGE_EXECUTE_TRADE,
                    headers=config.EDGE_HEADERS,
                    json=payload,
                )
            data = r.json()

            if not r.is_success or not data.get("success"):
                err = data.get("error", f"HTTP {r.status_code}")
                log.warning("paper_trade_rejected", symbol=signal.symbol,
                            reason=err, action=data.get("action"))
                return TradeResult(
                    success=False, position_id=None,
                    symbol=signal.symbol, direction=signal.direction or "",
                    lot_size=risk_check.lot_size or 0.0,
                    entry_price=signal.entry_price or 0.0,
                    sl_price=signal.sl_price or 0.0,
                    tp1_price=signal.tp1_price or 0.0,
                    tp2_price=signal.tp2_price or 0.0,
                    risk_usd=risk_check.risk_usd or 0.0,
                    error=err, raw_response=data,
                )

            log.info("paper_trade_opened",
                     symbol=signal.symbol,
                     position_id=data.get("position_id"),
                     lot=data.get("lot_size"),
                     risk_usd=data.get("risk_usd"),
                     direction=signal.direction)

            return TradeResult(
                success=True,
                position_id=data.get("position_id"),
                symbol=signal.symbol,
                direction=signal.direction or "",
                lot_size=float(data.get("lot_size", risk_check.lot_size or 0.01)),
                entry_price=float(data.get("entry_price", signal.entry_price or 0)),
                sl_price=float(data.get("sl_price", signal.sl_price or 0)),
                tp1_price=float(data.get("tp1_price", signal.tp1_price or 0)),
                tp2_price=float(data.get("tp2_price", signal.tp2_price or 0)),
                risk_usd=float(data.get("risk_usd", risk_check.risk_usd or 0)),
                raw_response=data,
            )

        except Exception as e:
            log.error("paper_trade_error", symbol=signal.symbol, error=str(e))
            return TradeResult(
                success=False, position_id=None,
                symbol=signal.symbol, direction=signal.direction or "",
                lot_size=0.0, entry_price=0.0, sl_price=0.0,
                tp1_price=0.0, tp2_price=0.0, risk_usd=0.0,
                error=str(e),
            )

    # ── Live execution stubs ───────────────────────────────────────────────────

    async def _open_live_mt5(self, signal: SignalResult, risk_check: RiskCheck) -> TradeResult:
        """
        MT5 live execution stub.
        Requires MetaTrader5 Python package installed and MT5 terminal running.
        Uncomment and configure when ready for live trading.
        """
        log.warning("mt5_live_stub_called", symbol=signal.symbol)
        # Example (requires: pip install MetaTrader5):
        # import MetaTrader5 as mt5
        # mt5.initialize()
        # request = {
        #     "action":   mt5.TRADE_ACTION_DEAL,
        #     "symbol":   signal.symbol.replace("/", ""),
        #     "volume":   risk_check.lot_size,
        #     "type":     mt5.ORDER_TYPE_BUY if signal.direction == "LONG" else mt5.ORDER_TYPE_SELL,
        #     "price":    mt5.symbol_info_tick(symbol).ask,
        #     "sl":       signal.sl_price,
        #     "tp":       signal.tp1_price,
        #     "comment":  "PropPilot SMC",
        # }
        # result = mt5.order_send(request)
        raise NotImplementedError("MT5 live mode not configured — set credentials and uncomment code")

    async def _open_live_alpaca(self, signal: SignalResult, risk_check: RiskCheck) -> TradeResult:
        """Alpaca live execution stub (US stocks/ETFs)."""
        log.warning("alpaca_live_stub_called", symbol=signal.symbol)
        raise NotImplementedError("Alpaca live mode not configured")

    async def _open_live_oanda(self, signal: SignalResult, risk_check: RiskCheck) -> TradeResult:
        """OANDA REST API live execution stub (forex)."""
        log.warning("oanda_live_stub_called", symbol=signal.symbol)
        raise NotImplementedError("OANDA live mode not configured")

    # ── Position monitoring ────────────────────────────────────────────────────

    async def trigger_position_update(self) -> dict:
        """
        Trigger the Supabase update-paper-positions Edge Function.
        Called by the main loop every 5 minutes during trading hours.
        """
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                r = await client.post(
                    config.EDGE_UPDATE_POSITIONS,
                    headers=config.EDGE_HEADERS,
                    json={},
                )
            data = r.json()
            log.info("position_update_triggered",
                     updated=data.get("updated", 0),
                     closed=data.get("closed", 0))
            return data
        except Exception as e:
            log.error("position_update_error", error=str(e))
            return {"error": str(e)}

    async def emergency_close_all(self, open_positions: list[dict]) -> list[dict]:
        """
        Emergency: directly PATCH all open positions to MANUAL_CLOSE via REST.
        Used as a last resort when the position manager is unreachable.
        """
        from config import SUPABASE_URL, EDGE_HEADERS
        now = datetime.now(tz=timezone.utc).isoformat()
        results = []
        async with httpx.AsyncClient(timeout=15) as client:
            for pos in open_positions:
                pid = pos.get("id")
                try:
                    r = await client.patch(
                        f"{SUPABASE_URL}/rest/v1/paper_positions?id=eq.{pid}",
                        headers={**EDGE_HEADERS, "Prefer": "return=minimal"},
                        json={
                            "status": "MANUAL_CLOSE",
                            "close_price": pos.get("entry_price"),
                            "closed_at": now,
                            "pnl_usd": pos.get("partial_pnl_usd", 0),
                            "pnl_r": pos.get("partial_pnl_r", 0),
                            "notes": (pos.get("notes") or "") + " | Emergency close by daemon",
                        },
                    )
                    results.append({"id": pid, "ok": r.is_success})
                    log.info("emergency_closed", position_id=pid)
                except Exception as e:
                    results.append({"id": pid, "ok": False, "error": str(e)})
        return results
