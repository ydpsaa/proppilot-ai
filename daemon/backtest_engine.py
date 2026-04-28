"""
PropPilot AI — Backtest Engine
Walk-forward simulation over historical M5 OHLCV data.

Plugs directly into signal_engine.analyze() — identical logic to live trading,
zero lookahead bias. Every signal decision uses only data available up to that bar.

Features:
  • CSV loader — standard OHLCV or MetaTrader export format
  • Realistic fills — spread, commission per round trip, entry slippage
  • Two TP strategies — tp1_only (simple) or scale_out (50% TP1, 50% TP2)
  • Session breakdown — London / NewYork / Asia / Overlap statistics
  • Equity curve — per-bar balance and equity tracking
  • Full stats — Sharpe, Sortino, Max Drawdown, Profit Factor, Win Rate, expectancy
  • JSON export + equity CSV export

Usage:
    from backtest_engine import BacktestEngine, BacktestConfig

    cfg = BacktestConfig(
        symbol          = "XAU/USD",
        initial_balance = 100_000,
        spread_points   = 0.30,        # $0.30 spread for gold
        commission_usd  = 5.0,         # $5 round-trip commission
        risk_pct        = 1.0,
        tp_strategy     = "scale_out",
        min_confidence  = 65,
        step            = 5,           # analyze every 5 bars (faster)
    )
    engine = BacktestEngine(cfg)
    report = engine.run_from_csv("XAU/USD", "data/XAUUSD_M5.csv", verbose=True)
    print(report.summary())
    report.save_json("results/xauusd_bt.json")

CSV format (auto-detected):
  Standard:   datetime,open,high,low,close,volume
  MT4/MT5:    DATE,TIME,OPEN,HIGH,LOW,CLOSE,TICKVOL
"""

from __future__ import annotations

import csv
import json
import math
import statistics
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, date, timezone
from typing import Optional

import structlog

from data_feed import Candle, CandleStore
import config
from signal_engine import analyze
from strategy_ensemble import DEFAULT_STRATEGY_WEIGHTS

log = structlog.get_logger("backtest")

# ─── Timeframes used by the signal engine ────────────────────────────────────
_TF_ALL = config.TIMEFRAMES   # [1, 5, 15, 60, 240, 1440]

# M5 bars needed per higher-TF bar
_M5_PER_TF = {15: 3, 60: 12, 240: 48, 1440: 288}


# ─── Configuration ────────────────────────────────────────────────────────────

@dataclass
class BacktestConfig:
    """All parameters for a single backtest run."""
    symbol:             str
    initial_balance:    float       = 100_000.0
    risk_pct:           float       = 1.0        # % of balance risked per trade
    spread_points:      float       = 0.0        # spread in price units (e.g. 0.30 for gold)
    commission_usd:     float       = 0.0        # USD commission per round trip
    slippage_points:    float       = 0.0        # extra slippage at entry (per side)
    tp_strategy:        str         = "scale_out" # "tp1_only" | "scale_out"
    min_confidence:     int         = 65
    warmup_bars:        int         = 200         # bars to skip before trading starts
    step:               int         = 1           # analyze every N bars (5+ recommended for speed)
    max_daily_trades:   int         = 5
    allowed_sessions:   list[str]   = field(default_factory=lambda: [
        "London", "Overlap", "NewYork",
    ])

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


# ─── Result types ─────────────────────────────────────────────────────────────

@dataclass
class BacktestTrade:
    """Single completed trade from the backtest."""
    trade_id:       int
    symbol:         str
    direction:      str         # LONG | SHORT
    open_ts:        int         # unix seconds — entry bar timestamp
    close_ts:       int         # unix seconds — exit bar timestamp
    entry_price:    float
    sl_price:       float
    tp1_price:      float
    tp2_price:      float
    exit_price:     float
    exit_reason:    str         # TP1 | TP2 | SL | BE | SCALE_TP2 | EXPIRED
    pnl_r:          float       # R-multiples (positive = profit)
    pnl_usd:        float       # approximate USD P&L using R × risk_usd
    risk_usd:       float
    confidence:     int
    session:        str
    regime:         str

    @property
    def is_win(self) -> bool:
        return self.pnl_r > 0

    def to_dict(self) -> dict:
        return self.__dict__.copy()


@dataclass
class EquityPoint:
    """Balance / equity snapshot at one bar."""
    ts:      int
    balance: float
    equity:  float  # balance + unrealized


@dataclass
class SessionStats:
    """Aggregated stats per trading session."""
    name:    str
    trades:  int   = 0
    wins:    int   = 0
    losses:  int   = 0
    total_r: float = 0.0

    @property
    def win_rate(self) -> float:
        return (self.wins / self.trades * 100) if self.trades else 0.0

    @property
    def avg_r(self) -> float:
        return (self.total_r / self.trades) if self.trades else 0.0

    @property
    def profit_factor(self) -> float:
        wins = self.wins * abs(self.total_r / self.trades) if self.trades else 0
        losses = self.losses * 1.0
        return wins / losses if losses else float("inf")


@dataclass
class BacktestReport:
    """Full results of a backtest run."""
    config:          BacktestConfig
    trades:          list[BacktestTrade]
    equity_curve:    list[EquityPoint]
    start_date:      str
    end_date:        str
    bars_analyzed:   int
    trades_skipped:  int = 0  # filtered by session / daily limit

    # Summary stats (computed in __post_init__)
    total_trades:       int   = field(default=0, init=False)
    wins:               int   = field(default=0, init=False)
    losses:             int   = field(default=0, init=False)
    win_rate_pct:       float = field(default=0.0, init=False)
    total_r:            float = field(default=0.0, init=False)
    avg_win_r:          float = field(default=0.0, init=False)
    avg_loss_r:         float = field(default=0.0, init=False)
    expectancy_r:       float = field(default=0.0, init=False)
    profit_factor:      float = field(default=0.0, init=False)
    max_drawdown_pct:   float = field(default=0.0, init=False)
    max_drawdown_usd:   float = field(default=0.0, init=False)
    sharpe:             float = field(default=0.0, init=False)
    sortino:            float = field(default=0.0, init=False)
    final_balance:      float = field(default=0.0, init=False)
    total_return_pct:   float = field(default=0.0, init=False)
    session_stats:      dict  = field(default_factory=dict, init=False)

    def __post_init__(self) -> None:
        self._compute_stats()

    def _compute_stats(self) -> None:
        if not self.trades:
            self.final_balance = self.config.initial_balance
            return

        self.total_trades = len(self.trades)
        wins   = [t for t in self.trades if t.pnl_r > 0]
        losses = [t for t in self.trades if t.pnl_r <= 0]

        self.wins   = len(wins)
        self.losses = len(losses)
        self.win_rate_pct = self.wins / self.total_trades * 100

        r_values = [t.pnl_r for t in self.trades]
        self.total_r  = sum(r_values)
        self.avg_win_r  = sum(t.pnl_r for t in wins) / len(wins) if wins else 0.0
        self.avg_loss_r = sum(t.pnl_r for t in losses) / len(losses) if losses else 0.0

        gross_profit = sum(t.pnl_usd for t in wins)
        gross_loss   = abs(sum(t.pnl_usd for t in losses))
        self.profit_factor = gross_profit / gross_loss if gross_loss else float("inf")

        wr = self.win_rate_pct / 100
        self.expectancy_r = (wr * self.avg_win_r) + ((1 - wr) * self.avg_loss_r)

        # Equity curve stats
        if self.equity_curve:
            self.final_balance = self.equity_curve[-1].balance
            self.total_return_pct = (
                (self.final_balance - self.config.initial_balance)
                / self.config.initial_balance * 100
            )

            # Max drawdown
            peak = self.config.initial_balance
            max_dd_usd = 0.0
            for ep in self.equity_curve:
                peak = max(peak, ep.balance)
                dd   = peak - ep.balance
                max_dd_usd = max(max_dd_usd, dd)
            self.max_drawdown_usd = max_dd_usd
            self.max_drawdown_pct = (
                max_dd_usd / peak * 100 if peak else 0.0
            )

            # Daily returns for Sharpe/Sortino
            daily_eq = _daily_equity(self.equity_curve)
            if len(daily_eq) > 1:
                daily_rets = [
                    (daily_eq[i] - daily_eq[i - 1]) / daily_eq[i - 1]
                    for i in range(1, len(daily_eq))
                ]
                mean_r = statistics.mean(daily_rets)
                std_r  = statistics.stdev(daily_rets) if len(daily_rets) > 1 else 1e-9
                neg_r  = [r for r in daily_rets if r < 0]
                std_neg = (
                    statistics.stdev(neg_r) if len(neg_r) > 1
                    else (std_r or 1e-9)
                )
                self.sharpe  = mean_r / std_r * math.sqrt(252) if std_r else 0.0
                self.sortino = mean_r / std_neg * math.sqrt(252) if std_neg else 0.0

        # Session breakdown
        by_session: dict[str, SessionStats] = {}
        for t in self.trades:
            s = by_session.setdefault(t.session, SessionStats(name=t.session))
            s.trades += 1
            if t.pnl_r > 0:
                s.wins += 1
            else:
                s.losses += 1
            s.total_r += t.pnl_r
        self.session_stats = by_session

    def summary(self) -> str:
        """Human-readable summary block."""
        ib = self.config.initial_balance
        lines = [
            f"\n{'='*58}",
            f"  BACKTEST REPORT — {self.config.symbol}",
            f"  Period  : {self.start_date} → {self.end_date}",
            f"  Bars    : {self.bars_analyzed:,}  (step={self.config.step})",
            f"{'='*58}",
            f"  Balance : ${ib:>10,.2f} → ${self.final_balance:>10,.2f}",
            f"  Return  : {self.total_return_pct:+.2f}%",
            f"  Max DD  : {self.max_drawdown_pct:.2f}%  (${self.max_drawdown_usd:,.2f})",
            f"{'─'*58}",
            f"  Trades  : {self.total_trades}  |  "
            f"Win {self.win_rate_pct:.1f}%  ({self.wins}W / {self.losses}L)",
            f"  Total R : {self.total_r:+.2f}R  |  "
            f"Expect : {self.expectancy_r:+.3f}R",
            f"  Avg Win : +{self.avg_win_r:.2f}R  |  "
            f"Avg Loss: {self.avg_loss_r:.2f}R",
            f"  PF      : {self.profit_factor:.2f}  |  "
            f"Sharpe: {self.sharpe:.2f}  |  Sortino: {self.sortino:.2f}",
            f"{'─'*58}",
            f"  Session breakdown:",
        ]
        for s in sorted(self.session_stats.values(), key=lambda x: -x.trades):
            lines.append(
                f"    {s.name:<12} "
                f"{s.trades:>3} trades  "
                f"WR {s.win_rate:.1f}%  "
                f"AvgR {s.avg_r:+.2f}"
            )
        lines.append(f"{'='*58}\n")
        return "\n".join(lines)

    def save_json(self, path: str) -> None:
        """Save full report to JSON."""
        data = {
            "config":     self.config.to_dict(),
            "start_date": self.start_date,
            "end_date":   self.end_date,
            "bars_analyzed": self.bars_analyzed,
            "stats": {
                "total_trades":     self.total_trades,
                "wins":             self.wins,
                "losses":           self.losses,
                "win_rate_pct":     round(self.win_rate_pct, 2),
                "total_r":          round(self.total_r, 3),
                "avg_win_r":        round(self.avg_win_r, 3),
                "avg_loss_r":       round(self.avg_loss_r, 3),
                "expectancy_r":     round(self.expectancy_r, 4),
                "profit_factor":    round(self.profit_factor, 3),
                "max_drawdown_pct": round(self.max_drawdown_pct, 2),
                "max_drawdown_usd": round(self.max_drawdown_usd, 2),
                "sharpe":           round(self.sharpe, 3),
                "sortino":          round(self.sortino, 3),
                "final_balance":    round(self.final_balance, 2),
                "total_return_pct": round(self.total_return_pct, 2),
            },
            "session_stats": {
                k: {
                    "trades": v.trades, "wins": v.wins, "losses": v.losses,
                    "win_rate": round(v.win_rate, 1),
                    "total_r": round(v.total_r, 3),
                    "avg_r":   round(v.avg_r, 3),
                }
                for k, v in self.session_stats.items()
            },
            "trades": [t.to_dict() for t in self.trades],
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        log.info("backtest_saved_json", path=path)

    def save_csv_equity(self, path: str) -> None:
        """Save equity curve to CSV."""
        with open(path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh)
            writer.writerow(["ts", "datetime_utc", "balance", "equity"])
            for ep in self.equity_curve:
                dt_str = datetime.fromtimestamp(ep.ts, tz=timezone.utc).strftime(
                    "%Y-%m-%d %H:%M"
                )
                writer.writerow([ep.ts, dt_str, round(ep.balance, 2), round(ep.equity, 2)])
        log.info("equity_curve_saved", path=path)


# ─── Internal trade state ─────────────────────────────────────────────────────

@dataclass
class _OpenTrade:
    """Mutable state for a trade currently open in the simulation."""
    trade_id:    int
    direction:   str
    open_ts:     int
    open_bar_i:  int
    entry_price: float
    sl_price:    float
    tp1_price:   float
    tp2_price:   float
    risk_usd:    float
    confidence:  int
    session:     str
    regime:      str
    phase:       int = 0   # 0 = normal, 1 = after TP1 (SL moved to BE)
    partial_r:   float = 0.0  # R accumulated from TP1 partial close


# ─── BacktestEngine ───────────────────────────────────────────────────────────

class BacktestEngine:
    """
    Walk-forward backtester for PropPilot signal strategy.
    Maintains a rolling CandleStore window and calls signal_engine.analyze()
    at each step interval. Trade simulation includes spread and slippage.
    """

    def __init__(self, cfg: BacktestConfig) -> None:
        self.cfg = cfg

    # ── Public API ────────────────────────────────────────────────────────────

    def run_from_csv(
        self,
        symbol: str,
        csv_path: str,
        verbose: bool = True,
    ) -> BacktestReport:
        """Load M5 OHLCV from CSV and run backtest."""
        m5_bars = load_csv_candles(symbol, csv_path, tf_minutes=5)
        if not m5_bars:
            raise ValueError(f"No candles loaded from {csv_path}")
        if verbose:
            print(f"\nLoaded {len(m5_bars):,} M5 bars from {csv_path}")
        return self.run(symbol, m5_bars, verbose=verbose)

    def run(
        self,
        symbol:   str,
        m5_bars:  list[Candle],
        verbose:  bool = True,
    ) -> BacktestReport:
        """
        Main walk-forward simulation.
        `m5_bars` must be sorted oldest-first.
        Returns BacktestReport with full statistics.
        """
        cfg         = self.cfg
        balance     = cfg.initial_balance
        open_trade: Optional[_OpenTrade] = None
        trades:     list[BacktestTrade]  = []
        equity_curve: list[EquityPoint]  = []
        trade_id    = 0
        skipped     = 0

        # Daily tracking
        current_day:   Optional[date] = None
        daily_count:   int = 0

        total_bars = len(m5_bars)
        start_i    = cfg.warmup_bars
        bars_done  = 0

        for i in range(start_i, total_bars):
            bar = m5_bars[i]
            bar_date = datetime.fromtimestamp(bar.ts, tz=timezone.utc).date()

            # Daily reset
            if bar_date != current_day:
                current_day  = bar_date
                daily_count  = 0

            # ── 1. Check exits for open trade ─────────────────────────────────
            if open_trade is not None:
                closed = _check_exit(open_trade, bar, cfg)
                if closed is not None:
                    balance += closed.pnl_usd
                    trades.append(closed)
                    open_trade = None

            # ── 2. Equity curve snapshot ──────────────────────────────────────
            unrealized = _unrealized_pnl(open_trade, bar)
            equity_curve.append(EquityPoint(
                ts      = bar.ts,
                balance = round(balance, 4),
                equity  = round(balance + unrealized, 4),
            ))

            # ── 3. Skip if step not met ────────────────────────────────────────
            if (i - start_i) % cfg.step != 0:
                continue

            # ── 4. Skip if already in a trade ─────────────────────────────────
            if open_trade is not None:
                continue

            # ── 5. Check daily trade limit ────────────────────────────────────
            if daily_count >= cfg.max_daily_trades:
                skipped += 1
                continue

            # ── 6. Build CandleStore and run signal analysis ───────────────────
            window = m5_bars[max(0, i - CandleStore.MAX_BARS + 1): i + 1]
            store  = _make_store(symbol, window)
            session = _session_from_ts(bar.ts)

            try:
                sig = analyze(symbol, store, session, DEFAULT_STRATEGY_WEIGHTS)
            except Exception as exc:
                log.warning("backtest_analyze_error", bar_i=i, error=str(exc))
                continue

            # ── 7. Filter signal ──────────────────────────────────────────────
            if sig.verdict not in ("LONG_NOW", "SHORT_NOW"):
                continue
            if sig.confidence < cfg.min_confidence:
                skipped += 1
                continue
            if session not in cfg.allowed_sessions:
                skipped += 1
                continue
            if sig.entry_price is None or sig.sl_price is None:
                continue

            # ── 8. Open trade on NEXT bar open ────────────────────────────────
            if i + 1 >= total_bars:
                break

            next_bar = m5_bars[i + 1]
            fill     = _apply_fill(next_bar.open, sig.direction, cfg)
            sl_dist  = abs(fill - sig.sl_price)
            if sl_dist < 1e-8:
                continue  # degenerate signal

            risk_usd = balance * (cfg.risk_pct / 100)
            tp1_price = sig.tp1_price or (
                fill + sl_dist * 1.5 if sig.direction == "LONG"
                else fill - sl_dist * 1.5
            )
            tp2_price = sig.tp2_price or (
                fill + sl_dist * 2.5 if sig.direction == "LONG"
                else fill - sl_dist * 2.5
            )

            trade_id += 1
            daily_count += 1

            open_trade = _OpenTrade(
                trade_id    = trade_id,
                direction   = sig.direction,
                open_ts     = next_bar.ts,
                open_bar_i  = i + 1,
                entry_price = fill,
                sl_price    = sig.sl_price,
                tp1_price   = tp1_price,
                tp2_price   = tp2_price,
                risk_usd    = risk_usd,
                confidence  = sig.confidence,
                session     = session,
                regime      = sig.market_regime.name if sig.market_regime else "UNKNOWN",
            )

            # Progress reporting
            bars_done += 1
            if verbose and bars_done % 50 == 0:
                pct = (i - start_i) / (total_bars - start_i) * 100
                print(f"  [{pct:.0f}%] bar {i:,}/{total_bars:,}  "
                      f"trades={trade_id}  balance=${balance:,.0f}", end="\r")

        # Close any open trade at end of data
        if open_trade is not None:
            last_bar = m5_bars[-1]
            last_price = last_bar.close
            sl_dist = abs(open_trade.entry_price - open_trade.sl_price)
            pnl_r   = _calc_r(open_trade.direction, open_trade.entry_price,
                               last_price, sl_dist)
            total_r = open_trade.partial_r + pnl_r * (
                0.5 if cfg.tp_strategy == "scale_out" and open_trade.phase == 1 else 1.0
            )
            pnl_usd = total_r * open_trade.risk_usd - cfg.commission_usd
            balance += pnl_usd
            trades.append(BacktestTrade(
                trade_id    = open_trade.trade_id,
                symbol      = symbol,
                direction   = open_trade.direction,
                open_ts     = open_trade.open_ts,
                close_ts    = last_bar.ts,
                entry_price = open_trade.entry_price,
                sl_price    = open_trade.sl_price,
                tp1_price   = open_trade.tp1_price,
                tp2_price   = open_trade.tp2_price,
                exit_price  = last_price,
                exit_reason = "EXPIRED",
                pnl_r       = round(total_r, 4),
                pnl_usd     = round(pnl_usd, 2),
                risk_usd    = open_trade.risk_usd,
                confidence  = open_trade.confidence,
                session     = open_trade.session,
                regime      = open_trade.regime,
            ))

        if verbose:
            print()   # newline after progress

        start_dt = datetime.fromtimestamp(m5_bars[start_i].ts, tz=timezone.utc)
        end_dt   = datetime.fromtimestamp(m5_bars[-1].ts, tz=timezone.utc)

        report = BacktestReport(
            config        = cfg,
            trades        = trades,
            equity_curve  = equity_curve,
            start_date    = start_dt.strftime("%Y-%m-%d"),
            end_date      = end_dt.strftime("%Y-%m-%d"),
            bars_analyzed = total_bars - start_i,
            trades_skipped = skipped,
        )
        log.info("backtest_complete",
                 symbol=symbol,
                 trades=len(trades),
                 win_rate=f"{report.win_rate_pct:.1f}%",
                 total_r=f"{report.total_r:+.2f}R",
                 return_pct=f"{report.total_return_pct:+.2f}%")
        return report


# ─── CSV Loader ──────────────────────────────────────────────────────────────

def load_csv_candles(symbol: str, path: str, tf_minutes: int = 5) -> list[Candle]:
    """
    Load OHLCV candles from CSV.

    Supported formats:
      Standard : datetime,open,high,low,close,volume
      MT4/MT5  : DATE,TIME,OPEN,HIGH,LOW,CLOSE,TICKVOL[,VOL,SPREAD]
    """
    candles: list[Candle] = []
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        headers = [h.strip().upper() for h in (reader.fieldnames or [])]
        is_mt4 = "DATE" in headers and "TIME" in headers

        for row in reader:
            try:
                if is_mt4:
                    dt_str = f"{row.get('DATE', row.get('date', '')).strip()} " \
                             f"{row.get('TIME', row.get('time', '')).strip()}"
                    ts = _parse_mt4_dt(dt_str)
                else:
                    raw = (row.get("datetime") or row.get("time") or
                           row.get("timestamp") or "").strip()
                    ts = _parse_iso_dt(raw)

                candles.append(Candle(
                    symbol    = symbol,
                    timeframe = tf_minutes,
                    ts        = ts,
                    open      = float(row.get("open",  row.get("OPEN",  0))),
                    high      = float(row.get("high",  row.get("HIGH",  0))),
                    low       = float(row.get("low",   row.get("LOW",   0))),
                    close     = float(row.get("close", row.get("CLOSE", 0))),
                    volume    = float(row.get("volume", row.get("TICKVOL",
                                row.get("VOL", 1))) or 1),
                    complete  = True,
                ))
            except (ValueError, KeyError) as exc:
                log.debug("csv_row_skip", error=str(exc))
                continue

    candles.sort(key=lambda c: c.ts)
    log.info("csv_loaded", path=path, bars=len(candles), symbol=symbol)
    return candles


# ─── Internal helpers ─────────────────────────────────────────────────────────

def _make_store(symbol: str, m5_bars: list[Candle]) -> CandleStore:
    """
    Build a CandleStore pre-populated from M5 candles.
    Derives M15, H1, H4, D1 by aggregation.
    M1 is set equal to M5 bars (sufficient for signal_engine internals).
    """
    store = CandleStore(symbol)
    cap   = CandleStore.MAX_BARS

    # M5 and M1 (fake M1 = M5)
    m5_slice = m5_bars[-cap:]
    store._bars[5] = deque(m5_slice, maxlen=cap)
    store._bars[1] = deque(m5_slice, maxlen=cap)

    # Higher timeframes via aggregation
    for tf, n in _M5_PER_TF.items():
        agg = _aggregate_candles(symbol, m5_bars, tf, n)
        store._bars[tf] = deque(agg[-cap:], maxlen=cap)

    return store


def _aggregate_candles(
    symbol: str, m5_bars: list[Candle], tf_minutes: int, per_bar: int
) -> list[Candle]:
    """Aggregate M5 bars into a higher timeframe by grouping `per_bar` M5 bars."""
    result: list[Candle] = []
    i = 0
    while i + per_bar <= len(m5_bars):
        group = m5_bars[i: i + per_bar]
        result.append(Candle(
            symbol    = symbol,
            timeframe = tf_minutes,
            ts        = group[0].ts,
            open      = group[0].open,
            high      = max(c.high for c in group),
            low       = min(c.low  for c in group),
            close     = group[-1].close,
            volume    = sum(c.volume for c in group),
            complete  = True,
        ))
        i += per_bar
    return result


def _session_from_ts(ts: int) -> str:
    """Determine trading session from UTC timestamp."""
    hour = datetime.fromtimestamp(ts, tz=timezone.utc).hour
    if 0 <= hour < 7:
        return "Asia"
    if hour == 7:
        return "Frankfurt"
    if 8 <= hour < 12:
        return "London"
    if 12 <= hour < 17:
        return "Overlap"
    if 17 <= hour < 21:
        return "NewYork"
    return "Dead"


def _apply_fill(open_price: float, direction: str, cfg: BacktestConfig) -> float:
    """
    Compute realistic fill price: open + spread + slippage.
    LONG: buy at ask = open + spread + slippage
    SHORT: sell at bid = open - spread - slippage
    """
    extra = cfg.spread_points + cfg.slippage_points
    if direction == "LONG":
        return open_price + extra
    return open_price - extra


def _calc_r(direction: str, entry: float, exit_p: float, sl_dist: float) -> float:
    """Compute R-multiple. Positive = profitable."""
    if sl_dist < 1e-10:
        return 0.0
    if direction == "LONG":
        return (exit_p - entry) / sl_dist
    return (entry - exit_p) / sl_dist


def _check_exit(
    trade: _OpenTrade,
    bar:   Candle,
    cfg:   BacktestConfig,
) -> Optional[BacktestTrade]:
    """
    Check if bar hits SL or TP for the open trade.
    Returns a completed BacktestTrade if the trade closed, else None.
    Pessimistic same-bar rule: if both SL and TP are penetrated in one bar,
    assume SL triggered first UNLESS the bar is strongly directional.
    """
    sl_dist = abs(trade.entry_price - trade.sl_price)
    if sl_dist < 1e-10:
        return None

    direction = trade.direction
    is_long   = direction == "LONG"

    def _close(exit_price: float, reason: str, partial_r: float = 0.0) -> BacktestTrade:
        pnl_r   = partial_r + _calc_r(direction, trade.entry_price, exit_price, sl_dist) * (
            0.5 if cfg.tp_strategy == "scale_out" and trade.phase == 0 and
            reason in ("TP1",) else
            0.5 if cfg.tp_strategy == "scale_out" and trade.phase == 1 and
            reason in ("TP2", "BE") else 1.0
        )
        pnl_usd = pnl_r * trade.risk_usd - cfg.commission_usd
        return BacktestTrade(
            trade_id    = trade.trade_id,
            symbol      = bar.symbol,
            direction   = direction,
            open_ts     = trade.open_ts,
            close_ts    = bar.ts,
            entry_price = trade.entry_price,
            sl_price    = trade.sl_price,
            tp1_price   = trade.tp1_price,
            tp2_price   = trade.tp2_price,
            exit_price  = exit_price,
            exit_reason = reason,
            pnl_r       = round(pnl_r, 4),
            pnl_usd     = round(pnl_usd, 2),
            risk_usd    = trade.risk_usd,
            confidence  = trade.confidence,
            session     = trade.session,
            regime      = trade.regime,
        )

    # ── Phase 1: waiting for TP1 or SL ────────────────────────────────────────
    if trade.phase == 0:
        sl_hit  = (bar.low <= trade.sl_price) if is_long else (bar.high >= trade.sl_price)
        tp1_hit = (bar.high >= trade.tp1_price) if is_long else (bar.low <= trade.tp1_price)

        if sl_hit and tp1_hit:
            # Pessimistic: SL wins unless bar is strongly directional
            bar_range  = bar.high - bar.low
            body_ratio = abs(bar.close - bar.open) / bar_range if bar_range > 1e-10 else 0
            favorable_close = (
                bar.close > (bar.open + bar_range * 0.5) if is_long
                else bar.close < (bar.open - bar_range * 0.5)
            )
            if favorable_close and body_ratio > 0.5:
                tp1_hit = True
                sl_hit  = False
            else:
                sl_hit  = True
                tp1_hit = False

        if sl_hit:
            return _close(trade.sl_price, "SL")

        if tp1_hit:
            if cfg.tp_strategy == "tp1_only":
                return _close(trade.tp1_price, "TP1")
            # scale_out: take 50%, advance phase, move SL to BE
            partial_r = _calc_r(direction, trade.entry_price, trade.tp1_price, sl_dist) * 0.5
            trade.partial_r = partial_r
            trade.phase     = 1
            trade.sl_price  = trade.entry_price   # SL to breakeven
            return None  # Still open with 50%

    # ── Phase 2: after TP1, waiting for TP2 or breakeven SL ──────────────────
    if trade.phase == 1:
        be_hit  = (bar.low <= trade.sl_price) if is_long else (bar.high >= trade.sl_price)
        tp2_hit = (bar.high >= trade.tp2_price) if is_long else (bar.low <= trade.tp2_price)

        if be_hit and tp2_hit:
            # TP2 first if bar moves favorably
            bar_range = bar.high - bar.low
            body_ratio = abs(bar.close - bar.open) / bar_range if bar_range > 1e-10 else 0
            favorable = (
                bar.close > bar.open + bar_range * 0.5 if is_long
                else bar.close < bar.open - bar_range * 0.5
            )
            if favorable and body_ratio > 0.5:
                be_hit = False
            else:
                tp2_hit = False

        if be_hit:
            # Closed at breakeven → only partial_r counts
            pnl_usd = trade.partial_r * trade.risk_usd - cfg.commission_usd
            return BacktestTrade(
                trade_id    = trade.trade_id,
                symbol      = bar.symbol,
                direction   = direction,
                open_ts     = trade.open_ts,
                close_ts    = bar.ts,
                entry_price = trade.entry_price,
                sl_price    = trade.sl_price,
                tp1_price   = trade.tp1_price,
                tp2_price   = trade.tp2_price,
                exit_price  = trade.entry_price,
                exit_reason = "BE",
                pnl_r       = round(trade.partial_r, 4),
                pnl_usd     = round(pnl_usd, 2),
                risk_usd    = trade.risk_usd,
                confidence  = trade.confidence,
                session     = trade.session,
                regime      = trade.regime,
            )

        if tp2_hit:
            tp2_r   = _calc_r(direction, trade.entry_price, trade.tp2_price, sl_dist) * 0.5
            total_r = trade.partial_r + tp2_r
            pnl_usd = total_r * trade.risk_usd - cfg.commission_usd
            return BacktestTrade(
                trade_id    = trade.trade_id,
                symbol      = bar.symbol,
                direction   = direction,
                open_ts     = trade.open_ts,
                close_ts    = bar.ts,
                entry_price = trade.entry_price,
                sl_price    = trade.sl_price,
                tp1_price   = trade.tp1_price,
                tp2_price   = trade.tp2_price,
                exit_price  = trade.tp2_price,
                exit_reason = "TP2",
                pnl_r       = round(total_r, 4),
                pnl_usd     = round(pnl_usd, 2),
                risk_usd    = trade.risk_usd,
                confidence  = trade.confidence,
                session     = trade.session,
                regime      = trade.regime,
            )

    return None  # Still open


def _unrealized_pnl(trade: Optional[_OpenTrade], bar: Candle) -> float:
    """Estimate unrealized P&L for equity curve."""
    if trade is None:
        return 0.0
    sl_dist = abs(trade.entry_price - trade.sl_price)
    if sl_dist < 1e-10:
        return 0.0
    r = _calc_r(trade.direction, trade.entry_price, bar.close, sl_dist)
    return r * trade.risk_usd


def _daily_equity(equity_curve: list[EquityPoint]) -> list[float]:
    """Downsample equity curve to one value per calendar day."""
    if not equity_curve:
        return []
    result: dict[str, float] = {}
    for ep in equity_curve:
        day = datetime.fromtimestamp(ep.ts, tz=timezone.utc).strftime("%Y-%m-%d")
        result[day] = ep.balance  # Last value of the day wins
    return list(result.values())


def _parse_iso_dt(raw: str) -> int:
    """Parse ISO-style datetime string → unix seconds."""
    raw = raw.strip()
    for fmt in (
        "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S%z",
    ):
        try:
            dt = datetime.strptime(raw[:len(fmt)], fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
        except ValueError:
            continue
    raise ValueError(f"Cannot parse datetime: {raw!r}")


def _parse_mt4_dt(raw: str) -> int:
    """Parse MetaTrader 'YYYY.MM.DD HH:MM' format → unix seconds."""
    raw = raw.strip()
    for sep in (".", "-", "/"):
        raw = raw.replace(sep, "-", 2)  # normalize date part
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            dt = datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
        except ValueError:
            continue
    return _parse_iso_dt(raw)
