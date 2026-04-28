"""
PropPilot AI — Market Regime Classifier

Pure market-state classifier used by the Python daemon.
Classifies the latest candle context into:
  TREND_STRONG, TREND_WEAK, RANGE, HIGH_VOL, LOW_VOL

Inputs are derived from candles only, so the module works in paper trading,
backtests, and live modes without broker-specific dependencies.
"""

from __future__ import annotations

from dataclasses import dataclass

from data_feed import Candle
from indicators import bollinger, ema


@dataclass(frozen=True)
class MarketRegime:
    """Current market regime and its supporting metrics."""

    name: str
    adx: float
    atr_pct: float
    bollinger_width: float
    volume_ratio: float
    trend_direction: str
    reasons: list[str]

    def to_dict(self) -> dict:
        """Serialize regime for logs/database metadata."""
        return {
            "name": self.name,
            "adx": self.adx,
            "atr_pct": self.atr_pct,
            "bollinger_width": self.bollinger_width,
            "volume_ratio": self.volume_ratio,
            "trend_direction": self.trend_direction,
            "reasons": self.reasons,
        }


def classify_market_regime(candles: list[Candle]) -> MarketRegime:
    """
    Classify the latest market regime using ADX, ATR%, Bollinger width and volume.

    Thresholds follow the project spec:
      ADX > 40: strong trend, 20-40: trend, <20: range
      ATR% > 0.8: high volatility, <0.2: low volatility
      Bollinger width < 1.5%: compressed/range context
    """
    if len(candles) < 30:
        return MarketRegime(
            name="LOW_VOL",
            adx=0.0,
            atr_pct=0.0,
            bollinger_width=0.0,
            volume_ratio=1.0,
            trend_direction="ranging",
            reasons=["INSUFFICIENT_REGIME_DATA"],
        )

    closes = [c.close for c in candles]
    price = closes[-1] or 1.0
    atr = _atr(candles, 14)
    atr_pct = (atr / price) * 100 if price else 0.0
    adx_value = _adx(candles, 14)
    bb = bollinger(closes, 20, 2.0)
    bb_width_pct = bb.width * 100
    volume_ratio = _volume_ratio(candles, 20)
    trend_direction = _trend_direction(closes)

    reasons: list[str] = []
    if adx_value > 40:
        reasons.append("ADX_STRONG")
    elif adx_value >= 20:
        reasons.append("ADX_TREND")
    else:
        reasons.append("ADX_RANGE")

    if atr_pct > 0.8:
        reasons.append("ATR_HIGH")
    elif atr_pct < 0.2:
        reasons.append("ATR_LOW")

    if bb_width_pct < 1.5:
        reasons.append("BB_COMPRESSION")
    if volume_ratio >= 1.5:
        reasons.append("VOLUME_EXPANSION")

    if atr_pct > 0.8:
        name = "HIGH_VOL"
    elif atr_pct < 0.2:
        name = "LOW_VOL"
    elif adx_value > 40 and trend_direction != "ranging":
        name = "TREND_STRONG"
    elif adx_value >= 20 and trend_direction != "ranging":
        name = "TREND_WEAK"
    elif adx_value < 20 or bb_width_pct < 1.5:
        name = "RANGE"
    else:
        name = "TREND_WEAK"

    return MarketRegime(
        name=name,
        adx=round(adx_value, 2),
        atr_pct=round(atr_pct, 4),
        bollinger_width=round(bb_width_pct, 4),
        volume_ratio=round(volume_ratio, 3),
        trend_direction=trend_direction,
        reasons=reasons,
    )


def _adx(candles: list[Candle], period: int = 14) -> float:
    """Calculate the latest Wilder ADX value."""
    if len(candles) < period * 2 + 1:
        return 0.0

    trs: list[float] = []
    plus_dm: list[float] = []
    minus_dm: list[float] = []

    for i in range(1, len(candles)):
        cur = candles[i]
        prev = candles[i - 1]
        up_move = cur.high - prev.high
        down_move = prev.low - cur.low
        plus_dm.append(up_move if up_move > down_move and up_move > 0 else 0.0)
        minus_dm.append(down_move if down_move > up_move and down_move > 0 else 0.0)
        trs.append(max(cur.high - cur.low, abs(cur.high - prev.close), abs(cur.low - prev.close)))

    if len(trs) < period:
        return 0.0

    atr = sum(trs[:period])
    plus = sum(plus_dm[:period])
    minus = sum(minus_dm[:period])
    dx_values: list[float] = []

    for i in range(period, len(trs)):
        atr = atr - (atr / period) + trs[i]
        plus = plus - (plus / period) + plus_dm[i]
        minus = minus - (minus / period) + minus_dm[i]
        if atr <= 0:
            continue
        plus_di = 100 * (plus / atr)
        minus_di = 100 * (minus / atr)
        denom = plus_di + minus_di
        if denom <= 0:
            continue
        dx_values.append(100 * abs(plus_di - minus_di) / denom)

    if not dx_values:
        return 0.0
    recent = dx_values[-period:]
    return sum(recent) / len(recent)


def _atr(candles: list[Candle], period: int = 14) -> float:
    """Average True Range helper local to avoid signal_engine import cycles."""
    if len(candles) < 2:
        return 0.0
    trs = []
    for i in range(1, len(candles)):
        cur = candles[i]
        prev = candles[i - 1]
        trs.append(max(cur.high - cur.low, abs(cur.high - prev.close), abs(cur.low - prev.close)))
    recent = trs[-period:]
    return sum(recent) / len(recent) if recent else 0.0


def _volume_ratio(candles: list[Candle], period: int = 20) -> float:
    """Latest candle volume divided by average recent volume."""
    recent = candles[-period:]
    avg = sum(c.volume for c in recent) / len(recent) if recent else 0.0
    if avg <= 0:
        return 1.0
    return candles[-1].volume / avg


def _trend_direction(closes: list[float]) -> str:
    """EMA20/EMA50 directional trend helper."""
    if len(closes) < 55:
        return "ranging"
    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)
    if closes[-1] > ema20 > ema50:
        return "bullish"
    if closes[-1] < ema20 < ema50:
        return "bearish"
    return "ranging"
