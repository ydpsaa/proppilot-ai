"""
PropPilot AI — Technical Indicators
Pure functions — no I/O, no side effects. All operate on list[float] or list[Candle].

Available:
  rsi(closes, period)             → float  (0–100)
  ema(values, period)             → float
  sma(values, period)             → float
  macd(closes, fast, slow, sig)   → MACDResult
  bollinger(closes, period, std)  → BollingerResult
  rsi_series(closes, period)      → list[float]
  ema_series(values, period)      → list[float]
  atr_series(candles, period)     → list[float]

  confluence_score(candles, direction) → ConfluenceResult
    Combines RSI alignment, MA trend, BB position into a 0–18 pt score
    for use in signal_engine.analyze().
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

# ── Result types ──────────────────────────────────────────────────────────────

@dataclass
class MACDResult:
    macd:      float   # MACD line (fast EMA − slow EMA)
    signal:    float   # Signal line (EMA of MACD)
    histogram: float   # MACD − Signal
    bullish:   bool    # histogram > 0 and macd > signal
    bearish:   bool    # histogram < 0 and macd < signal


@dataclass
class BollingerResult:
    upper:    float
    middle:   float   # SMA
    lower:    float
    width:    float   # (upper − lower) / middle  — volatility proxy
    pct_b:    float   # where is price in the band: 0=lower, 0.5=mid, 1=upper


@dataclass
class ConfluenceResult:
    """
    Multi-indicator confluence for a given direction (LONG / SHORT).
    score:    0–18 pts  (used as bonus in signal_engine confidence)
    reasons:  list of string codes (e.g. RSI_OVERSOLD, MA_ALIGNED, BB_LOWER)
    """
    score:   int
    reasons: list[str]
    rsi:     Optional[float]
    macd:    Optional[MACDResult]
    bb:      Optional[BollingerResult]


# ── Core functions ─────────────────────────────────────────────────────────────

def ema(values: list[float], period: int) -> float:
    """Exponential Moving Average (last value)."""
    if not values:
        return 0.0
    if len(values) < period:
        return sum(values) / len(values)
    k   = 2.0 / (period + 1)
    val = sum(values[:period]) / period
    for v in values[period:]:
        val = v * k + val * (1 - k)
    return val


def ema_series(values: list[float], period: int) -> list[float]:
    """Returns full EMA series (same length as input, first `period-1` filled with SMA)."""
    if not values:
        return []
    k   = 2.0 / (period + 1)
    out: list[float] = []
    init = sum(values[:period]) / period if len(values) >= period else sum(values) / len(values)
    val = init
    for i, v in enumerate(values):
        if i < period - 1:
            out.append(sum(values[: i + 1]) / (i + 1))
        elif i == period - 1:
            out.append(init)
        else:
            val = v * k + val * (1 - k)
            out.append(val)
    return out


def sma(values: list[float], period: int) -> float:
    """Simple Moving Average (last value)."""
    if not values:
        return 0.0
    recent = values[-period:] if len(values) >= period else values
    return sum(recent) / len(recent)


def rsi(closes: list[float], period: int = 14) -> float:
    """
    Wilder's RSI — returns a single float (0–100).
    Returns 50.0 if insufficient data.
    """
    if len(closes) < period + 1:
        return 50.0

    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains  = [max(d, 0.0) for d in deltas]
    losses = [abs(min(d, 0.0)) for d in deltas]

    # Initial Wilder average
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 2)


def rsi_series(closes: list[float], period: int = 14) -> list[float]:
    """Returns RSI value at every bar (NaN-free — fills with 50 before enough data)."""
    result: list[float] = [50.0] * len(closes)
    if len(closes) < period + 1:
        return result

    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains  = [max(d, 0.0) for d in deltas]
    losses = [abs(min(d, 0.0)) for d in deltas]

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    def _rsi(ag, al):
        if al == 0:
            return 100.0
        return round(100 - (100 / (1 + ag / al)), 2)

    result[period] = _rsi(avg_gain, avg_loss)
    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        result[i + 1] = _rsi(avg_gain, avg_loss)

    return result


def macd(
    closes: list[float],
    fast:   int = 12,
    slow:   int = 26,
    signal: int = 9,
) -> MACDResult:
    """
    Standard MACD.
    Returns a MACDResult with the latest value + directional flags.
    """
    if len(closes) < slow + signal:
        return MACDResult(macd=0.0, signal=0.0, histogram=0.0, bullish=False, bearish=False)

    fast_ema  = ema_series(closes, fast)
    slow_ema  = ema_series(closes, slow)
    macd_line = [f - s for f, s in zip(fast_ema, slow_ema)]
    sig_line  = ema_series(macd_line, signal)

    m   = macd_line[-1]
    s   = sig_line[-1]
    h   = m - s
    return MACDResult(
        macd=round(m, 6),
        signal=round(s, 6),
        histogram=round(h, 6),
        bullish=h > 0 and m > s,
        bearish=h < 0 and m < s,
    )


def bollinger(
    closes: list[float],
    period: int   = 20,
    std_dev: float = 2.0,
) -> BollingerResult:
    """
    Bollinger Bands — returns upper, middle (SMA), lower bands + pct_b.
    """
    if len(closes) < period:
        mid = closes[-1] if closes else 0.0
        return BollingerResult(upper=mid, middle=mid, lower=mid, width=0.0, pct_b=0.5)

    recent = closes[-period:]
    mid    = sum(recent) / period
    var    = sum((x - mid) ** 2 for x in recent) / period
    std    = math.sqrt(var)
    upper  = mid + std_dev * std
    lower  = mid - std_dev * std
    width  = (upper - lower) / mid if mid != 0 else 0.0
    price  = closes[-1]
    pct_b  = (price - lower) / (upper - lower) if (upper - lower) != 0 else 0.5
    return BollingerResult(
        upper=round(upper, 6), middle=round(mid, 6), lower=round(lower, 6),
        width=round(width, 6), pct_b=round(pct_b, 4),
    )


def atr_series(candles, period: int = 14) -> list[float]:
    """Full ATR series (same length as candles)."""
    if len(candles) < 2:
        return [0.0] * len(candles)

    trs: list[float] = [0.0]
    for i in range(1, len(candles)):
        c, p = candles[i], candles[i - 1]
        trs.append(max(c.high - c.low, abs(c.high - p.close), abs(c.low - p.close)))

    result = [0.0] * len(trs)
    if len(trs) < period:
        return result

    result[period - 1] = sum(trs[:period]) / period
    for i in range(period, len(trs)):
        result[i] = (result[i - 1] * (period - 1) + trs[i]) / period
    return result


# ── Multi-indicator confluence ────────────────────────────────────────────────

# RSI thresholds
RSI_OVERSOLD   = 40   # below this = oversold for LONG (generous threshold)
RSI_OVERBOUGHT = 60   # above this = overbought for SHORT

def confluence_score(candles, direction: str) -> ConfluenceResult:
    """
    Combine RSI, MACD, Bollinger Bands into a directional confluence score.

    Scoring (max 18 pts):
      RSI alignment           up to 8 pts
      MACD alignment          up to 5 pts
      Bollinger Band position up to 5 pts

    Args:
        candles:   list[Candle] from M15 or H1
        direction: "LONG" or "SHORT"
    Returns:
        ConfluenceResult with score and reason codes
    """
    if len(candles) < 30:
        return ConfluenceResult(score=0, reasons=[], rsi=None, macd=None, bb=None)

    closes = [c.close for c in candles]
    score  = 0
    reasons: list[str] = []

    # ── RSI (up to 8 pts) ────────────────────────────────────────────────────
    rsi_val = rsi(closes, 14)
    if direction == "LONG":
        if rsi_val < RSI_OVERSOLD:
            score += 8
            reasons.append("RSI_OVERSOLD")
        elif rsi_val < 50:
            score += 4
            reasons.append("RSI_BELOW_50")
    else:  # SHORT
        if rsi_val > RSI_OVERBOUGHT:
            score += 8
            reasons.append("RSI_OVERBOUGHT")
        elif rsi_val > 50:
            score += 4
            reasons.append("RSI_ABOVE_50")

    # ── MACD (up to 5 pts) ───────────────────────────────────────────────────
    macd_result = macd(closes, 12, 26, 9)
    if direction == "LONG" and macd_result.bullish:
        score += 5
        reasons.append("MACD_BULLISH")
    elif direction == "SHORT" and macd_result.bearish:
        score += 5
        reasons.append("MACD_BEARISH")
    elif direction == "LONG" and macd_result.macd > 0:
        score += 2
        reasons.append("MACD_POSITIVE")
    elif direction == "SHORT" and macd_result.macd < 0:
        score += 2
        reasons.append("MACD_NEGATIVE")

    # ── Bollinger Bands (up to 5 pts) ────────────────────────────────────────
    bb = bollinger(closes, 20, 2.0)
    if direction == "LONG":
        if bb.pct_b < 0.20:           # price at or below lower band
            score += 5
            reasons.append("BB_LOWER_BAND")
        elif bb.pct_b < 0.40:
            score += 2
            reasons.append("BB_LOWER_HALF")
    else:  # SHORT
        if bb.pct_b > 0.80:           # price at or above upper band
            score += 5
            reasons.append("BB_UPPER_BAND")
        elif bb.pct_b > 0.60:
            score += 2
            reasons.append("BB_UPPER_HALF")

    return ConfluenceResult(
        score=score,
        reasons=reasons,
        rsi=rsi_val,
        macd=macd_result,
        bb=bb,
    )


# ── MA cross signal helper ────────────────────────────────────────────────────

def ma_cross(closes: list[float], fast: int = 20, slow: int = 50) -> str:
    """
    Returns:
      "bullish"  — fast EMA is above slow EMA and crossing up
      "bearish"  — fast EMA is below slow EMA and crossing down
      "ranging"  — no clear cross
    """
    if len(closes) < slow + 2:
        return "ranging"

    fast_now  = ema(closes, fast)
    slow_now  = ema(closes, slow)
    fast_prev = ema(closes[:-1], fast)
    slow_prev = ema(closes[:-1], slow)

    bullish_cross = fast_prev <= slow_prev and fast_now > slow_now
    bearish_cross = fast_prev >= slow_prev and fast_now < slow_now

    if bullish_cross:
        return "bullish"
    if bearish_cross:
        return "bearish"
    if fast_now > slow_now:
        return "bullish"
    if fast_now < slow_now:
        return "bearish"
    return "ranging"
