"""
PropPilot AI — Strategy Ensemble

Combines three deterministic strategy families:
  1. Smart Money (SMC): sweep + MSS/CHoCH + FVG context
  2. Indicator: RSI + EMA + MACD/Bollinger confluence
  3. Breakout: range/level break with volume expansion

The ensemble returns weighted votes and can be fed adaptive strategy weights
from recent trade outcomes. It remains deterministic and safe when ML/adaptive
data is unavailable by falling back to equal weights.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from data_feed import Candle
from indicators import bollinger, ema, macd, rsi
from market_regime import MarketRegime


DEFAULT_STRATEGY_WEIGHTS: dict[str, float] = {
    "smart_money": 1.0,
    "indicator": 1.0,
    "breakout": 1.0,
}


@dataclass(frozen=True)
class StrategyVote:
    """Single strategy vote."""

    strategy: str
    direction: Optional[str]
    confidence: int
    active: bool
    reason: str

    def to_dict(self) -> dict:
        """Serialize vote for persistence."""
        return {
            "strategy": self.strategy,
            "direction": self.direction,
            "confidence": self.confidence,
            "active": self.active,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class EnsembleDecision:
    """Weighted ensemble output."""

    direction: Optional[str]
    confidence: int
    votes: list[StrategyVote]
    weights: dict[str, float]
    score_long: float
    score_short: float
    active_strategies: list[str]

    def reasoning_codes(self) -> list[str]:
        """Reason codes to append to the signal."""
        codes = ["ENSEMBLE_ACTIVE"]
        codes.extend(f"STRAT_{v.strategy.upper()}" for v in self.votes if v.active)
        if self.direction:
            codes.append(f"ENSEMBLE_{self.direction}")
        return codes

    def to_dict(self) -> dict:
        """Serialize decision for logs/database metadata."""
        return {
            "direction": self.direction,
            "confidence": self.confidence,
            "votes": [v.to_dict() for v in self.votes],
            "weights": self.weights,
            "score_long": round(self.score_long, 3),
            "score_short": round(self.score_short, 3),
            "active_strategies": self.active_strategies,
        }


def build_ensemble_decision(
    *,
    candles: list[Candle],
    regime: MarketRegime,
    smc_direction: Optional[str],
    has_sweep: bool,
    has_mss: bool,
    has_fvg: bool,
    displacement: bool,
    weights: Optional[dict[str, float]] = None,
) -> EnsembleDecision:
    """Build weighted ensemble decision for the latest candle context."""
    strategy_weights = _normalize_weights(weights or DEFAULT_STRATEGY_WEIGHTS)
    votes = [
        _smart_money_vote(smc_direction, has_sweep, has_mss, has_fvg, displacement, regime),
        _indicator_vote(candles, regime),
        _breakout_vote(candles, regime),
    ]

    score_long = 0.0
    score_short = 0.0
    active: list[str] = []
    for vote in votes:
        if not vote.active or vote.direction is None:
            continue
        active.append(vote.strategy)
        weight = strategy_weights.get(vote.strategy, 1.0)
        score = weight * (vote.confidence / 100)
        if vote.direction == "LONG":
            score_long += score
        elif vote.direction == "SHORT":
            score_short += score

    direction: Optional[str] = None
    if max(score_long, score_short) >= 0.45 and abs(score_long - score_short) >= 0.15:
        direction = "LONG" if score_long > score_short else "SHORT"

    total_weight = sum(strategy_weights.get(v.strategy, 1.0) for v in votes if v.active) or 1.0
    confidence = round(max(score_long, score_short) / total_weight * 100)

    return EnsembleDecision(
        direction=direction,
        confidence=max(0, min(confidence, 100)),
        votes=votes,
        weights=strategy_weights,
        score_long=score_long,
        score_short=score_short,
        active_strategies=active,
    )


def _smart_money_vote(
    direction: Optional[str],
    has_sweep: bool,
    has_mss: bool,
    has_fvg: bool,
    displacement: bool,
    regime: MarketRegime,
) -> StrategyVote:
    confidence = 0
    if direction:
        confidence += 20
    if has_sweep:
        confidence += 25
    if has_mss:
        confidence += 30
    if has_fvg:
        confidence += 15
    if displacement:
        confidence += 10
    if regime.name == "RANGE":
        confidence -= 10
    active = direction is not None and confidence >= 45 and regime.name != "LOW_VOL"
    return StrategyVote("smart_money", direction, max(0, min(confidence, 100)), active, "SMC_STRUCTURE")


def _indicator_vote(candles: list[Candle], regime: MarketRegime) -> StrategyVote:
    if len(candles) < 55:
        return StrategyVote("indicator", None, 0, False, "INSUFFICIENT_DATA")
    closes = [c.close for c in candles]
    price = closes[-1]
    rsi_val = rsi(closes, 14)
    macd_val = macd(closes, 12, 26, 9)
    bb = bollinger(closes, 20, 2.0)
    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)

    direction: Optional[str] = None
    confidence = 0
    if price > ema20 > ema50 and macd_val.bullish:
        direction = "LONG"
        confidence = 55
        if rsi_val < 70:
            confidence += 10
        if bb.pct_b < 0.85:
            confidence += 10
    elif price < ema20 < ema50 and macd_val.bearish:
        direction = "SHORT"
        confidence = 55
        if rsi_val > 30:
            confidence += 10
        if bb.pct_b > 0.15:
            confidence += 10
    elif regime.name == "RANGE":
        if rsi_val < 35 or bb.pct_b < 0.15:
            direction = "LONG"
            confidence = 55
        elif rsi_val > 65 or bb.pct_b > 0.85:
            direction = "SHORT"
            confidence = 55

    active = direction is not None and regime.name not in ("HIGH_VOL", "LOW_VOL")
    return StrategyVote("indicator", direction, min(confidence, 100), active, "RSI_MA_MACD")


def _breakout_vote(candles: list[Candle], regime: MarketRegime) -> StrategyVote:
    if len(candles) < 30:
        return StrategyVote("breakout", None, 0, False, "INSUFFICIENT_DATA")
    recent = candles[-21:-1]
    last = candles[-1]
    high = max(c.high for c in recent)
    low = min(c.low for c in recent)
    avg_volume = sum(c.volume for c in recent) / len(recent) if recent else 0.0
    volume_ok = avg_volume <= 0 or last.volume >= avg_volume * 1.2

    direction: Optional[str] = None
    confidence = 0
    if last.close > high:
        direction = "LONG"
        confidence = 60
    elif last.close < low:
        direction = "SHORT"
        confidence = 60
    if direction and volume_ok:
        confidence += 15
    if regime.name == "TREND_STRONG":
        confidence += 10
    elif regime.name == "RANGE":
        confidence -= 15

    active = direction is not None and regime.name in ("TREND_STRONG", "TREND_WEAK", "HIGH_VOL")
    return StrategyVote("breakout", direction, max(0, min(confidence, 100)), active, "LEVEL_BREAK_VOLUME")


def _normalize_weights(weights: dict[str, float]) -> dict[str, float]:
    """Clamp strategy weights to a stable 0.25-2.0 range."""
    normalized = DEFAULT_STRATEGY_WEIGHTS.copy()
    normalized.update({k: float(v) for k, v in weights.items() if k in normalized})
    return {k: max(0.25, min(v, 2.0)) for k, v in normalized.items()}
