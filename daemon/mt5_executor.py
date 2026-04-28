"""
PropPilot AI — MT5 Live Executor
Full MetaTrader 5 bridge for live trade execution.

Prerequisites:
  1. Windows machine (or Wine) with MetaTrader 5 terminal installed and running
  2. pip install MetaTrader5
  3. Add to daemon/.env:
       MT5_LOGIN=12345678
       MT5_PASSWORD=your_password
       MT5_SERVER=YourBroker-Live
       MT5_PATH=C:/Program Files/MetaTrader 5/terminal64.exe  # optional

Architecture:
  MT5Connection     — manages the terminal connection with auto-reconnect
  MT5OrderResult    — result of a single order_send() call
  MT5Position       — snapshot of one open position
  ScaleOutState     — tracks split-order pairs for TP1 → BE → TP2 management
  MT5Executor       — high-level trade management, Supabase sync
  MT5PositionMonitor— background thread: moves SL to BE after TP1 hit

Scale-out logic (tp_strategy="scale_out"):
  - Place TWO orders at 50% lot each: order A with tp=tp1, order B with tp=tp2
  - When order A closes (TP1 hit): modify order B's SL → entry (breakeven)
  - When order B closes (TP2 or BE): record final outcome

Single-TP logic (tp_strategy="tp1_only"):
  - One order with tp=tp1. Clean and simple.

The executor is intentionally synchronous (blocking) because MetaTrader5 calls are
blocking by design. Use asyncio.to_thread() in main.py when calling from async context.

Usage:
    from mt5_executor import MT5Connection, MT5Executor

    conn = MT5Connection()
    if conn.connect():
        executor = MT5Executor(conn, tp_strategy="scale_out")
        result   = executor.open_trade(signal, risk_check)
        if result.success:
            print(f"Trade opened: ticket={result.position_id}")
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import structlog

import config
from execution_engine import TradeResult
from risk_engine import RiskCheck
from signal_engine import SignalResult

log = structlog.get_logger("mt5_executor")

# ─── MetaTrader5 import guard ─────────────────────────────────────────────────
# MT5 Python package only works on Windows (or Wine on Linux).
# System degrades gracefully when it is not installed.

try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    mt5 = None  # type: ignore
    MT5_AVAILABLE = False
    log.warning("mt5_package_missing",
                msg="pip install MetaTrader5  (Windows only — needed for live trading)")

# ─── Constants ────────────────────────────────────────────────────────────────

# EA magic number — used to identify PropPilot orders in MT5 history
MAGIC = int(os.getenv("MT5_MAGIC", "20260428"))

# Maximum price deviation accepted (in broker points)
DEFAULT_DEVIATION = int(os.getenv("MT5_DEVIATION", "20"))

# Retry attempts for order_send on REQUOTE / PRICE_CHANGED errors
ORDER_RETRY_ATTEMPTS = 3
ORDER_RETRY_DELAY_S  = 0.5

# Symbol name mapping: PropPilot name → MT5 terminal name
# Override per-broker by setting MT5_SYMBOL_MAP JSON in .env
_DEFAULT_SYMBOL_MAP: dict[str, str] = {
    "XAU/USD": "XAUUSD",
    "EUR/USD": "EURUSD",
    "GBP/USD": "GBPUSD",
    "USD/JPY": "USDJPY",
    "GBP/JPY": "GBPJPY",
    "EUR/JPY": "EURJPY",
    "NAS100":  "NAS100",
    "BTC/USD": "BTCUSD",
    "ETH/USD": "ETHUSD",
}

# Retcodes that indicate the price moved and we should retry
_REQUOTE_CODES = {
    10004,  # TRADE_RETCODE_REQUOTE
    10006,  # TRADE_RETCODE_REJECT
    10014,  # TRADE_RETCODE_INVALID_PRICE
    10015,  # TRADE_RETCODE_INVALID_STOPS
    10016,  # TRADE_RETCODE_INVALID_VOLUME
    10021,  # TRADE_RETCODE_PRICE_CHANGED
    10031,  # TRADE_RETCODE_CONNECTION
}

_SUCCESS_CODE = 10009   # TRADE_RETCODE_DONE


# ─── Data structures ──────────────────────────────────────────────────────────

@dataclass
class MT5OrderResult:
    """Result of a single mt5.order_send() call."""
    success:    bool
    ticket:     Optional[int]       # position ticket on success
    retcode:    int
    comment:    str
    price:      Optional[float]     # actual fill price
    volume:     Optional[float]     # actual fill volume
    symbol:     str
    raw:        Optional[object] = None  # raw mt5.OrderSendResult

    def __bool__(self) -> bool:
        return self.success


@dataclass
class MT5Position:
    """Snapshot of an open MT5 position."""
    ticket:         int
    symbol:         str
    direction:      str             # LONG | SHORT
    volume:         float
    entry_price:    float
    sl_price:       float
    tp_price:       float
    current_price:  float
    pnl_usd:        float
    open_time:      datetime
    comment:        str
    magic:          int

    def to_dict(self) -> dict:
        return {
            "ticket":       self.ticket,
            "symbol":       self.symbol,
            "direction":    self.direction,
            "volume":       self.volume,
            "entry_price":  self.entry_price,
            "sl_price":     self.sl_price,
            "tp_price":     self.tp_price,
            "current_price": self.current_price,
            "pnl_usd":      self.pnl_usd,
            "open_time":    self.open_time.isoformat(),
            "comment":      self.comment,
            "magic":        self.magic,
        }


@dataclass
class ScaleOutState:
    """Tracks both legs of a scale-out split position."""
    symbol:         str
    direction:      str
    ticket_a:       int             # first leg  — tp = tp1
    ticket_b:       int             # second leg — tp = tp2
    entry_price:    float
    tp1_price:      float
    tp2_price:      float
    sl_price:       float
    risk_usd:       float
    confidence:     int
    session:        str
    be_moved:       bool = False    # True once SL on leg B is at breakeven
    signal_id:      Optional[int] = None
    supabase_id_a:  Optional[int] = None
    supabase_id_b:  Optional[int] = None


# ─── MT5Connection ────────────────────────────────────────────────────────────

class MT5Connection:
    """
    Wraps mt5.initialize() / mt5.shutdown() with auto-reconnect logic.
    Thread-safe singleton per process.
    """

    def __init__(
        self,
        login:    Optional[int]  = None,
        password: Optional[str]  = None,
        server:   Optional[str]  = None,
        path:     Optional[str]  = None,
    ) -> None:
        self._login    = login    or int(os.getenv("MT5_LOGIN", "0") or 0) or None
        self._password = password or os.getenv("MT5_PASSWORD", "") or None
        self._server   = server   or os.getenv("MT5_SERVER",   "") or None
        self._path     = path     or os.getenv("MT5_PATH",     "") or None
        self._lock     = threading.Lock()
        self._connected = False

    def connect(self) -> bool:
        """Initialize MT5 terminal connection. Returns True on success."""
        if not MT5_AVAILABLE:
            log.error("mt5_not_available",
                      msg="MetaTrader5 package not installed. "
                          "Run: pip install MetaTrader5  (Windows only)")
            return False

        with self._lock:
            kwargs: dict = {}
            if self._path:
                kwargs["path"] = self._path
            if self._login:
                kwargs["login"] = self._login
            if self._password:
                kwargs["password"] = self._password
            if self._server:
                kwargs["server"] = self._server

            ok = mt5.initialize(**kwargs)
            if not ok:
                err = mt5.last_error()
                log.error("mt5_init_failed", error=err)
                self._connected = False
                return False

            info = mt5.account_info()
            if info is None:
                log.error("mt5_account_info_none")
                mt5.shutdown()
                self._connected = False
                return False

            self._connected = True
            log.info("mt5_connected",
                     login=info.login,
                     server=info.server,
                     balance=info.balance,
                     leverage=info.leverage,
                     currency=info.currency)
            return True

    def disconnect(self) -> None:
        if MT5_AVAILABLE and self._connected:
            mt5.shutdown()
            self._connected = False
            log.info("mt5_disconnected")

    def is_connected(self) -> bool:
        if not MT5_AVAILABLE or not self._connected:
            return False
        return mt5.terminal_info() is not None

    def ensure_connected(self) -> bool:
        """Reconnect if connection was lost. Returns True if connected."""
        if self.is_connected():
            return True
        log.warning("mt5_reconnecting")
        return self.connect()

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *_):
        self.disconnect()


# ─── MT5Executor ─────────────────────────────────────────────────────────────

class MT5Executor:
    """
    High-level trade executor for MT5.
    All methods are synchronous — call via asyncio.to_thread() from async code.

    Responsibilities:
      - Normalize PropPilot symbol names to MT5 names
      - Place market orders with correct direction, SL, TP
      - Manage scale-out (two legs per signal)
      - Sync positions to Supabase for dashboard visibility
      - Emergency close all PropPilot positions
    """

    def __init__(
        self,
        connection:     MT5Connection,
        tp_strategy:    str  = "scale_out",  # "tp1_only" | "scale_out"
        deviation:      int  = DEFAULT_DEVIATION,
        symbol_map:     Optional[dict[str, str]] = None,
    ) -> None:
        self.conn        = connection
        self.tp_strategy = tp_strategy
        self.deviation   = deviation
        self._sym_map    = {**_DEFAULT_SYMBOL_MAP, **(symbol_map or {})}
        self._scale_out_states: dict[str, ScaleOutState] = {}  # symbol → state
        self._sb         = config.get_supabase()
        log.info("mt5_executor_ready",
                 tp_strategy=tp_strategy,
                 deviation=deviation)

    # ── Public API ────────────────────────────────────────────────────────────

    def open_trade(self, signal: SignalResult, risk_check: RiskCheck) -> TradeResult:
        """
        Open a trade from a validated signal + risk check.
        Returns TradeResult compatible with paper mode output.
        """
        if not self.conn.ensure_connected():
            return self._fail(signal, risk_check, "MT5 not connected")

        sym_mt5  = self._mt5_symbol(signal.symbol)
        lot      = risk_check.lot_size or 0.01
        entry    = self._current_price(sym_mt5, signal.direction)
        if entry is None:
            return self._fail(signal, risk_check, "Cannot fetch current price from MT5")

        sl       = signal.sl_price
        tp1      = signal.tp1_price or self._fallback_tp(entry, sl, signal.direction, 1.5)
        tp2      = signal.tp2_price or self._fallback_tp(entry, sl, signal.direction, 2.5)
        comment  = f"PP-SMC c={signal.confidence}"

        if self.tp_strategy == "scale_out":
            return self._open_scale_out(signal, risk_check, sym_mt5, lot, entry, sl, tp1, tp2, comment)
        else:
            return self._open_single(signal, risk_check, sym_mt5, lot, entry, sl, tp1, comment)

    def close_by_ticket(self, ticket: int) -> MT5OrderResult:
        """Close a single open position by ticket."""
        if not self.conn.ensure_connected():
            return MT5OrderResult(success=False, ticket=None, retcode=-1,
                                  comment="not connected", price=None, volume=None, symbol="")

        pos_list = mt5.positions_get(ticket=ticket)
        if not pos_list:
            return MT5OrderResult(success=False, ticket=ticket, retcode=-1,
                                  comment="position not found", price=None, volume=None, symbol="")

        pos = pos_list[0]
        return self._send_close_order(pos)

    def close_all(self, symbol: Optional[str] = None) -> list[MT5OrderResult]:
        """
        Emergency: close all PropPilot positions (magic = MAGIC).
        If symbol is specified, closes only that symbol.
        """
        if not self.conn.ensure_connected():
            return []

        kwargs = {}
        if symbol:
            kwargs["symbol"] = self._mt5_symbol(symbol)

        positions = mt5.positions_get(**kwargs) or []
        results = []
        for pos in positions:
            if pos.magic != MAGIC:
                continue
            result = self._send_close_order(pos)
            results.append(result)
            if not result.success:
                log.warning("emergency_close_failed",
                            ticket=pos.ticket, comment=result.comment)
            else:
                log.info("emergency_closed", ticket=pos.ticket, symbol=pos.symbol)
        return results

    def modify_sl_tp(
        self,
        ticket: int,
        sl:     Optional[float] = None,
        tp:     Optional[float] = None,
    ) -> bool:
        """Modify SL and/or TP for an open position."""
        if not self.conn.ensure_connected():
            return False

        pos_list = mt5.positions_get(ticket=ticket)
        if not pos_list:
            log.warning("modify_no_position", ticket=ticket)
            return False

        pos = pos_list[0]
        request = {
            "action":   mt5.TRADE_ACTION_SLTP,
            "position": ticket,
            "symbol":   pos.symbol,
            "sl":       sl if sl is not None else pos.sl,
            "tp":       tp if tp is not None else pos.tp,
        }
        result = mt5.order_send(request)
        ok = result is not None and result.retcode == _SUCCESS_CODE
        if not ok:
            log.warning("modify_failed",
                        ticket=ticket,
                        retcode=getattr(result, "retcode", None),
                        comment=getattr(result, "comment", ""))
        return ok

    def move_to_breakeven(self, ticket: int, entry_price: float) -> bool:
        """Move SL to entry price (breakeven) for a position."""
        return self.modify_sl_tp(ticket, sl=entry_price)

    def get_positions(self, symbol: Optional[str] = None) -> list[MT5Position]:
        """Return all open PropPilot positions as MT5Position list."""
        if not self.conn.ensure_connected():
            return []
        kwargs = {}
        if symbol:
            kwargs["symbol"] = self._mt5_symbol(symbol)
        raw = mt5.positions_get(**kwargs) or []
        result = []
        for pos in raw:
            if pos.magic != MAGIC:
                continue
            result.append(self._wrap_position(pos))
        return result

    def get_account_info(self) -> dict:
        """Return current MT5 account state as a dict."""
        if not self.conn.ensure_connected():
            return {}
        info = mt5.account_info()
        if info is None:
            return {}
        return {
            "login":      info.login,
            "server":     info.server,
            "balance":    info.balance,
            "equity":     info.equity,
            "margin":     info.margin,
            "free_margin": info.margin_free,
            "leverage":   info.leverage,
            "currency":   info.currency,
            "profit":     info.profit,
        }

    def check_scale_out_transitions(self) -> list[str]:
        """
        Check if any scale-out leg A has been closed (TP1 hit).
        If so, move leg B's SL to breakeven.
        Returns list of symbols where BE was moved.
        Called periodically by MT5PositionMonitor.
        """
        moved = []
        for symbol, state in list(self._scale_out_states.items()):
            if state.be_moved:
                continue
            # Check if ticket_a is still open
            pos_a = mt5.positions_get(ticket=state.ticket_a) if MT5_AVAILABLE else []
            if pos_a:
                continue  # leg A still open — TP1 not hit yet

            # Leg A closed — assume TP1 hit (could be SL too, but we're conservative)
            log.info("scale_out_tp1_hit",
                     symbol=symbol, ticket_a=state.ticket_a, ticket_b=state.ticket_b)

            ok = self.move_to_breakeven(state.ticket_b, state.entry_price)
            if ok:
                state.be_moved = True
                moved.append(symbol)
                log.info("breakeven_moved",
                         symbol=symbol, ticket_b=state.ticket_b,
                         be_price=state.entry_price)
                # Update Supabase position B SL
                self._update_supabase_sl(state.supabase_id_b, state.entry_price)

            # If leg B is also gone, clean up state
            pos_b = mt5.positions_get(ticket=state.ticket_b) if MT5_AVAILABLE else []
            if not pos_b:
                del self._scale_out_states[symbol]
                log.info("scale_out_complete", symbol=symbol)

        return moved

    # ── Supabase sync ─────────────────────────────────────────────────────────

    def sync_positions_to_supabase(self) -> int:
        """
        Sync all open MT5 positions to paper_positions table (with data_status='live_mt5').
        Returns count of upserted rows.
        """
        positions = self.get_positions()
        now       = datetime.now(tz=timezone.utc).isoformat()
        count     = 0

        for pos in positions:
            try:
                existing = (
                    self._sb.table("paper_positions")
                    .select("id")
                    .eq("mt5_ticket", pos.ticket)
                    .execute()
                )
                if existing.data:
                    # Update P&L
                    self._sb.table("paper_positions").update({
                        "pnl_usd":    pos.pnl_usd,
                        "updated_at": now,
                    }).eq("mt5_ticket", pos.ticket).execute()
                else:
                    self._sb.table("paper_positions").insert({
                        "symbol":       pos.symbol,
                        "direction":    pos.direction,
                        "entry_price":  pos.entry_price,
                        "sl_price":     pos.sl_price,
                        "tp1_price":    pos.tp_price,
                        "tp2_price":    pos.tp_price,
                        "lot_size":     pos.volume,
                        "status":       "OPEN",
                        "pnl_usd":      pos.pnl_usd,
                        "data_status":  "live_mt5",
                        "mt5_ticket":   pos.ticket,
                        "opened_at":    pos.open_time.isoformat(),
                        "created_at":   now,
                        "updated_at":   now,
                        "notes":        pos.comment,
                    }).execute()
                count += 1
            except Exception as e:
                log.warning("supabase_sync_error", ticket=pos.ticket, error=str(e))

        if count:
            log.info("supabase_positions_synced", count=count)
        return count

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _open_single(
        self, signal, risk_check, sym_mt5, lot, entry, sl, tp1, comment
    ) -> TradeResult:
        """Open one order with TP = tp1."""
        res = self._place_order(sym_mt5, lot, signal.direction, sl, tp1, comment)
        if not res.success:
            return self._fail(signal, risk_check, res.comment)

        supabase_id = self._record_supabase(
            signal   = signal,
            lot      = lot,
            entry    = res.price or entry,
            sl       = sl,
            tp1      = tp1,
            tp2      = tp1,
            risk_usd = risk_check.risk_usd or 0,
            ticket   = res.ticket,
        )
        log.info("mt5_trade_opened",
                 symbol=signal.symbol, direction=signal.direction,
                 ticket=res.ticket, lot=lot, entry=res.price, sl=sl, tp=tp1)

        return TradeResult(
            success      = True,
            position_id  = supabase_id,
            symbol       = signal.symbol,
            direction    = signal.direction or "",
            lot_size     = lot,
            entry_price  = res.price or entry,
            sl_price     = sl,
            tp1_price    = tp1,
            tp2_price    = tp1,
            risk_usd     = risk_check.risk_usd or 0,
            raw_response = {"ticket": res.ticket, "retcode": res.retcode},
        )

    def _open_scale_out(
        self, signal, risk_check, sym_mt5, lot, entry, sl, tp1, tp2, comment
    ) -> TradeResult:
        """Open two half-lot orders: one at TP1 and one at TP2."""
        half_lot = max(0.01, round(lot / 2 * 100) / 100)

        res_a = self._place_order(sym_mt5, half_lot, signal.direction, sl, tp1, comment + " [A]")
        if not res_a.success:
            return self._fail(signal, risk_check, f"Leg A failed: {res_a.comment}")

        res_b = self._place_order(sym_mt5, half_lot, signal.direction, sl, tp2, comment + " [B]")
        if not res_b.success:
            # Close leg A as safety measure
            log.warning("scale_out_leg_b_failed", symbol=signal.symbol,
                        comment=res_b.comment, closing_leg_a=res_a.ticket)
            self.close_by_ticket(res_a.ticket)
            return self._fail(signal, risk_check, f"Leg B failed: {res_b.comment}")

        fill_price = res_a.price or entry
        risk_usd   = risk_check.risk_usd or 0

        sid_a = self._record_supabase(signal, half_lot, fill_price, sl, tp1, tp2,
                                      risk_usd * 0.5, res_a.ticket)
        sid_b = self._record_supabase(signal, half_lot, fill_price, sl, tp1, tp2,
                                      risk_usd * 0.5, res_b.ticket)

        self._scale_out_states[signal.symbol] = ScaleOutState(
            symbol       = signal.symbol,
            direction    = signal.direction or "LONG",
            ticket_a     = res_a.ticket,
            ticket_b     = res_b.ticket,
            entry_price  = fill_price,
            tp1_price    = tp1,
            tp2_price    = tp2,
            sl_price     = sl,
            risk_usd     = risk_usd,
            confidence   = signal.confidence,
            session      = signal.session_name or "",
            supabase_id_a = sid_a,
            supabase_id_b = sid_b,
        )

        log.info("mt5_scale_out_opened",
                 symbol=signal.symbol, direction=signal.direction,
                 ticket_a=res_a.ticket, ticket_b=res_b.ticket,
                 lot=half_lot, entry=fill_price, sl=sl, tp1=tp1, tp2=tp2)

        return TradeResult(
            success      = True,
            position_id  = sid_a,
            symbol       = signal.symbol,
            direction    = signal.direction or "",
            lot_size     = lot,
            entry_price  = fill_price,
            sl_price     = sl,
            tp1_price    = tp1,
            tp2_price    = tp2,
            risk_usd     = risk_usd,
            raw_response = {
                "ticket_a": res_a.ticket,
                "ticket_b": res_b.ticket,
                "retcode":  res_a.retcode,
            },
        )

    def _place_order(
        self,
        sym_mt5:   str,
        lot:       float,
        direction: Optional[str],
        sl:        Optional[float],
        tp:        Optional[float],
        comment:   str,
    ) -> MT5OrderResult:
        """Send a market order to MT5 with retry on requote."""
        is_buy   = direction == "LONG"
        tick     = mt5.symbol_info_tick(sym_mt5)
        if tick is None:
            return MT5OrderResult(
                success=False, ticket=None, retcode=-1,
                comment=f"No tick data for {sym_mt5}",
                price=None, volume=None, symbol=sym_mt5,
            )

        price = tick.ask if is_buy else tick.bid
        order_type = mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL

        request = {
            "action":      mt5.TRADE_ACTION_DEAL,
            "symbol":      sym_mt5,
            "volume":      lot,
            "type":        order_type,
            "price":       price,
            "sl":          sl or 0.0,
            "tp":          tp or 0.0,
            "deviation":   self.deviation,
            "magic":       MAGIC,
            "comment":     comment,
            "type_time":   mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }

        for attempt in range(1, ORDER_RETRY_ATTEMPTS + 1):
            result = mt5.order_send(request)
            if result is None:
                err = mt5.last_error()
                log.warning("order_send_none", sym=sym_mt5, attempt=attempt, error=err)
                time.sleep(ORDER_RETRY_DELAY_S)
                continue

            if result.retcode == _SUCCESS_CODE:
                return MT5OrderResult(
                    success = True,
                    ticket  = result.order,
                    retcode = result.retcode,
                    comment = result.comment,
                    price   = result.price,
                    volume  = result.volume,
                    symbol  = sym_mt5,
                    raw     = result,
                )

            if result.retcode in _REQUOTE_CODES:
                # Refresh price and retry
                tick2 = mt5.symbol_info_tick(sym_mt5)
                if tick2:
                    request["price"] = tick2.ask if is_buy else tick2.bid
                log.debug("order_requote_retry",
                          sym=sym_mt5, attempt=attempt, retcode=result.retcode)
                time.sleep(ORDER_RETRY_DELAY_S)
                continue

            # Non-retryable error
            log.error("order_send_failed",
                      sym=sym_mt5, retcode=result.retcode, comment=result.comment)
            return MT5OrderResult(
                success = False,
                ticket  = None,
                retcode = result.retcode,
                comment = result.comment,
                price   = None,
                volume  = None,
                symbol  = sym_mt5,
                raw     = result,
            )

        return MT5OrderResult(
            success=False, ticket=None, retcode=-1,
            comment=f"Max retries exceeded for {sym_mt5}",
            price=None, volume=None, symbol=sym_mt5,
        )

    def _send_close_order(self, pos) -> MT5OrderResult:
        """Build and send a close order for an MT5 position object."""
        is_buy_pos = pos.type == 0    # POSITION_TYPE_BUY = 0
        close_type = mt5.ORDER_TYPE_SELL if is_buy_pos else mt5.ORDER_TYPE_BUY
        tick = mt5.symbol_info_tick(pos.symbol)
        if tick is None:
            return MT5OrderResult(
                success=False, ticket=pos.ticket, retcode=-1,
                comment="no tick", price=None, volume=None, symbol=pos.symbol,
            )
        price = tick.bid if is_buy_pos else tick.ask
        request = {
            "action":      mt5.TRADE_ACTION_DEAL,
            "position":    pos.ticket,
            "symbol":      pos.symbol,
            "volume":      pos.volume,
            "type":        close_type,
            "price":       price,
            "deviation":   self.deviation,
            "magic":       MAGIC,
            "comment":     "PP-close",
            "type_time":   mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        for attempt in range(1, ORDER_RETRY_ATTEMPTS + 1):
            result = mt5.order_send(request)
            if result and result.retcode == _SUCCESS_CODE:
                return MT5OrderResult(
                    success=True, ticket=pos.ticket, retcode=result.retcode,
                    comment=result.comment, price=result.price, volume=result.volume,
                    symbol=pos.symbol, raw=result,
                )
            if result and result.retcode in _REQUOTE_CODES:
                tick2 = mt5.symbol_info_tick(pos.symbol)
                if tick2:
                    request["price"] = tick2.bid if is_buy_pos else tick2.ask
                time.sleep(ORDER_RETRY_DELAY_S)
                continue
            retcode = getattr(result, "retcode", -1)
            comment = getattr(result, "comment", "unknown error")
            return MT5OrderResult(
                success=False, ticket=pos.ticket, retcode=retcode,
                comment=comment, price=None, volume=None, symbol=pos.symbol,
            )
        return MT5OrderResult(
            success=False, ticket=pos.ticket, retcode=-1,
            comment="max retries", price=None, volume=None, symbol=pos.symbol,
        )

    def _current_price(self, sym_mt5: str, direction: Optional[str]) -> Optional[float]:
        """Ask price for LONG, Bid price for SHORT."""
        tick = mt5.symbol_info_tick(sym_mt5) if MT5_AVAILABLE else None
        if tick is None:
            return None
        return tick.ask if direction == "LONG" else tick.bid

    def _mt5_symbol(self, symbol: str) -> str:
        return self._sym_map.get(symbol, symbol.replace("/", ""))

    def _fallback_tp(
        self, entry: float, sl: Optional[float], direction: Optional[str], rr: float
    ) -> float:
        sl = sl or entry
        sl_dist = abs(entry - (sl or entry))
        if direction == "LONG":
            return entry + sl_dist * rr
        return entry - sl_dist * rr

    def _wrap_position(self, pos) -> MT5Position:
        is_buy = pos.type == 0
        return MT5Position(
            ticket       = pos.ticket,
            symbol       = pos.symbol,
            direction    = "LONG" if is_buy else "SHORT",
            volume       = pos.volume,
            entry_price  = pos.price_open,
            sl_price     = pos.sl,
            tp_price     = pos.tp,
            current_price = pos.price_current,
            pnl_usd      = pos.profit,
            open_time    = datetime.fromtimestamp(pos.time, tz=timezone.utc),
            comment      = pos.comment,
            magic        = pos.magic,
        )

    def _record_supabase(
        self,
        signal:   SignalResult,
        lot:      float,
        entry:    float,
        sl:       Optional[float],
        tp1:      Optional[float],
        tp2:      Optional[float],
        risk_usd: float,
        ticket:   Optional[int],
    ) -> Optional[int]:
        """Insert a row into paper_positions for dashboard tracking."""
        try:
            now = datetime.now(tz=timezone.utc).isoformat()
            res = self._sb.table("paper_positions").insert({
                "symbol":      signal.symbol,
                "direction":   signal.direction,
                "entry_price": entry,
                "sl_price":    sl,
                "tp1_price":   tp1,
                "tp2_price":   tp2,
                "lot_size":    lot,
                "status":      "OPEN",
                "data_status": "live_mt5",
                "mt5_ticket":  ticket,
                "risk_usd":    round(risk_usd, 2),
                "confidence":  signal.confidence,
                "session_type": signal.session_name or "",
                "opened_at":   now,
                "created_at":  now,
                "updated_at":  now,
                "notes":       f"MT5 ticket={ticket}",
            }).execute()
            return res.data[0]["id"] if res.data else None
        except Exception as e:
            log.warning("record_supabase_error", ticket=ticket, error=str(e))
            return None

    def _update_supabase_sl(self, supabase_id: Optional[int], new_sl: float) -> None:
        """Update SL in Supabase after BE move."""
        if supabase_id is None:
            return
        try:
            self._sb.table("paper_positions").update({
                "sl_price":   new_sl,
                "updated_at": datetime.now(tz=timezone.utc).isoformat(),
                "notes":      "SL moved to breakeven after TP1",
            }).eq("id", supabase_id).execute()
        except Exception as e:
            log.warning("update_supabase_sl_error", id=supabase_id, error=str(e))

    @staticmethod
    def _fail(signal: SignalResult, risk_check: RiskCheck, reason: str) -> TradeResult:
        log.error("mt5_trade_failed", symbol=signal.symbol, reason=reason)
        return TradeResult(
            success     = False,
            position_id = None,
            symbol      = signal.symbol,
            direction   = signal.direction or "",
            lot_size    = risk_check.lot_size or 0.0,
            entry_price = signal.entry_price or 0.0,
            sl_price    = signal.sl_price or 0.0,
            tp1_price   = signal.tp1_price or 0.0,
            tp2_price   = signal.tp2_price or 0.0,
            risk_usd    = risk_check.risk_usd or 0.0,
            error       = reason,
        )


# ─── MT5 Position Monitor ─────────────────────────────────────────────────────

class MT5PositionMonitor:
    """
    Background daemon thread that:
      1. Checks scale-out transitions every 30s (TP1 hit → move SL to BE)
      2. Syncs MT5 positions to Supabase every 60s
      3. Reports account equity to Supabase equity_snapshots every 5 min

    Start once in main.py after MT5Executor is initialized:
        monitor = MT5PositionMonitor(executor, memory_manager)
        monitor.start()
    """

    def __init__(
        self,
        executor:       MT5Executor,
        memory_manager,             # MemoryManager instance
        scale_out_interval_s: int = 30,
        sync_interval_s:      int = 60,
        equity_interval_s:    int = 300,
    ) -> None:
        self._exec     = executor
        self._memory   = memory_manager
        self._scale_s  = scale_out_interval_s
        self._sync_s   = sync_interval_s
        self._equity_s = equity_interval_s
        self._stop     = threading.Event()
        self._thread   = threading.Thread(
            target   = self._run,
            daemon   = True,
            name     = "mt5-monitor",
        )

    def start(self) -> None:
        self._thread.start()
        log.info("mt5_monitor_started")

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=10)
        log.info("mt5_monitor_stopped")

    def _run(self) -> None:
        last_sync   = 0.0
        last_equity = 0.0

        while not self._stop.is_set():
            now = time.monotonic()
            try:
                # Scale-out BE transitions (every 30s)
                moved = self._exec.check_scale_out_transitions()
                if moved:
                    log.info("be_transitions_done", symbols=moved)

                # Position sync (every 60s)
                if now - last_sync >= self._sync_s:
                    self._exec.sync_positions_to_supabase()
                    last_sync = now

                # Equity snapshot (every 5 min)
                if now - last_equity >= self._equity_s:
                    acct = self._exec.get_account_info()
                    if acct:
                        positions = self._exec.get_positions()
                        self._memory.take_equity_snapshot(
                            account       = {
                                "balance":      acct.get("balance", 0),
                                "equity":       acct.get("equity",  0),
                                "daily_pnl_usd": acct.get("profit", 0),
                            },
                            open_positions = [p.to_dict() for p in positions],
                        )
                    last_equity = now

            except Exception as e:
                log.error("mt5_monitor_error", error=str(e))

            self._stop.wait(timeout=self._scale_s)
