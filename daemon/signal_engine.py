"""
PropPilot AI — Deterministic SMC/ICT Signal Engine (Python)
Port of signalEngine.js with full Python typing.

Entry point:  analyze(symbol, stores) → SignalResult
All functions are pure (no I/O). The engine operates on lists of Candle objects.

Confidence scoring (100 pts max):
  HTF trend alignment    25 pts
  LTF alignment          10 pts
  Session quality        15 pts
  Asia range context      5 pts
  Liquidity sweep        20 pts
  MSS / CHoCH            15 pts
  Displacement candle     8 pts
  FVG nearby              7 pts
  OTE zone entry          5 pts (bonus — can exceed 100, capped)

Verdict logic:
  ≥ 65 + MSS + (sweep OR displacement) → LONG_NOW / SHORT_NOW
  40–64                                 → WAIT_LONG / WAIT_SHORT
  < 40                                  → NO_TRADE
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import structlog

from data_feed import Candle, CandleStore

log = structlog.get_logger("signal_engine")

# ─── Result Types ──────────────────────────────────────────────────────────────

@dataclass
class SwingPoint:
    ts:    int
    price: float
    kind:  str   # "high" | "low"

@dataclass
class FVG:
    ts:        int
    direction: str   # "bull" | "bear"
    top:       float
    bottom:    float
    filled:    bool

@dataclass
class LiqLevel:
    price:      float
    label:      str   # PDH, PDL, EQH, EQL, PWH, PWL, ASIA_H, ASIA_L, CDH, CDL
    is_swept:   bool = False

@dataclass
class SweepEvent:
    ts:        int
    price:     float
    direction: str   # "high" | "low"
    level:     LiqLevel

@dataclass
class MSSEvent:
    ts:    int
    price: float
    kind:  str   # "MSS" | "CHoCH"

@dataclass
class OTEZone:
    entry_low:  float
    entry_high: float
    midpoint:   float

@dataclass
class SignalResult:
    symbol:     str
    timeframe:  int
    ts:         int
    verdict:    str   # LONG_NOW | SHORT_NOW | WAIT_LONG | WAIT_SHORT | NO_TRADE
    confidence: int   # 0-100+
    direction:  Optional[str]   # LONG | SHORT | None

    # Entry levels (None if no signal)
    entry_price: Optional[float]
    sl_price:    Optional[float]
    tp1_price:   Optional[float]
    tp2_price:   Optional[float]
    risk_reward: Optional[float]
    atr:         Optional[float]

    # Context
    htf_trend:         str    # bullish | bearish | ranging
    ltf_trend:         str
    session_name:      str
    reasoning_codes:   list[str]
    sweep:             Optional[SweepEvent]
    mss:               Optional[MSSEvent]
    fvg:               Optional[FVG]
    ote_zone:          Optional[OTEZone]
    liquidity_levels:  list[LiqLevel]
    displacement:      bool
    invalidation:      str

    def is_actionable(self) -> bool:
        return self.verdict in ("LONG_NOW", "SHORT_NOW")

    def to_db_dict(self) -> dict:
        return {
            "symbol":         self.symbol,
            "timeframe":      f"m{self.timeframe}",
            "verdict":        self.verdict,
            "confidence":     self.confidence,
            "reasoning_codes": self.reasoning_codes,
            "entry_price":    self.entry_price,
            "sl_price":       self.sl_price,
            "tp1_price":      self.tp1_price,
            "tp2_price":      self.tp2_price,
            "risk_reward":    self.risk_reward,
            "atr":            self.atr,
            "htf_trend":      self.htf_trend,
            "ltf_trend":      self.ltf_trend,
            "session_name":   self.session_name,
            "sweep_occurred": self.sweep is not None,
            "mss_occurred":   self.mss is not None,
            "displacement":   self.displacement,
            "fvg_nearby":     self.fvg is not None,
            "invalidation":   self.invalidation,
        }


# ─── Session detection ────────────────────────────────────────────────────────

def detect_session(utc_dt: datetime) -> str:
    h = utc_dt.hour + utc_dt.minute / 60
    dow = utc_dt.weekday()   # 0=Mon, 6=Sun
    if dow >= 5:
        return "Weekend"
    if 0 <= h < 7:
        return "Asia"
    if 7 <= h < 9.5:
        return "London"
    if 9.5 <= h < 13:
        return "Frankfurt"
    if 13 <= h < 17:
        return "Overlap"   # London + NY
    if 17 <= h < 22:
        return "NewYork"
    return "Dead"


def session_score(session: str) -> int:
    return {"Overlap": 15, "London": 12, "NewYork": 12,
            "Frankfurt": 8, "Asia": 5, "Dead": 0, "Weekend": 0}.get(session, 0)


# ─── ATR ──────────────────────────────────────────────────────────────────────

def calc_atr(candles: list[Candle], period: int = 14) -> float:
    if len(candles) < 2:
        return 0.0
    trs = []
    for i in range(1, len(candles)):
        c, p = candles[i], candles[i - 1]
        trs.append(max(c.high - c.low, abs(c.high - p.close), abs(c.low - p.close)))
    if not trs:
        return 0.0
    recent = trs[-period:]
    return sum(recent) / len(recent)


# ─── Swing detection ──────────────────────────────────────────────────────────

def detect_swings(candles: list[Candle], lookback: int = 5) -> list[SwingPoint]:
    swings: list[SwingPoint] = []
    for i in range(lookback, len(candles) - lookback):
        c = candles[i]
        left_h  = [candles[j].high  for j in range(i - lookback, i)]
        right_h = [candles[j].high  for j in range(i + 1, i + lookback + 1)]
        left_l  = [candles[j].low   for j in range(i - lookback, i)]
        right_l = [candles[j].low   for j in range(i + 1, i + lookback + 1)]
        if c.high > max(left_h) and c.high > max(right_h):
            swings.append(SwingPoint(ts=c.ts, price=c.high, kind="high"))
        if c.low < min(left_l) and c.low < min(right_l):
            swings.append(SwingPoint(ts=c.ts, price=c.low, kind="low"))
    return swings


def detect_trend(candles: list[Candle], lookback: int = 10) -> str:
    """Higher-High/Higher-Low = bullish, Lower-High/Lower-Low = bearish."""
    swings = detect_swings(candles[-lookback * 3:], lookback=3)
    highs  = [s.price for s in swings if s.kind == "high"]
    lows   = [s.price for s in swings if s.kind == "low"]
    if len(highs) >= 2 and len(lows) >= 2:
        hh = highs[-1] > highs[-2]
        hl = lows[-1]  > lows[-2]
        lh = highs[-1] < highs[-2]
        ll = lows[-1]  < lows[-2]
        if hh and hl:
            return "bullish"
        if lh and ll:
            return "bearish"
    # EMA fallback
    if len(candles) >= 20:
        closes = [c.close for c in candles]
        ema20 = _ema(closes, 20)
        if closes[-1] > ema20:
            return "bullish"
        if closes[-1] < ema20:
            return "bearish"
    return "ranging"


def _ema(values: list[float], period: int) -> float:
    if len(values) < period:
        return sum(values) / len(values)
    k = 2 / (period + 1)
    ema = sum(values[:period]) / period
    for v in values[period:]:
        ema = v * k + ema * (1 - k)
    return ema


# ─── FVG detection ───────────────────────────────────────────────────────────

def detect_fvg(candles: list[Candle], max_lookback: int = 30) -> list[FVG]:
    fvgs: list[FVG] = []
    recent = candles[-max_lookback:] if len(candles) > max_lookback else candles
    for i in range(1, len(recent) - 1):
        a, b, c_ = recent[i - 1], recent[i], recent[i + 1]
        # Bullish FVG: gap between candle[i-1].high and candle[i+1].low
        if a.high < c_.low:
            fvg = FVG(ts=b.ts, direction="bull", top=c_.low, bottom=a.high, filled=False)
            # Check if subsequent candles filled it
            for j in range(i + 2, len(recent)):
                if recent[j].low <= fvg.top and recent[j].high >= fvg.bottom:
                    fvg.filled = True
                    break
            fvgs.append(fvg)
        # Bearish FVG: gap between candle[i+1].high and candle[i-1].low
        if a.low > c_.high:
            fvg = FVG(ts=b.ts, direction="bear", top=a.low, bottom=c_.high, filled=False)
            for j in range(i + 2, len(recent)):
                if recent[j].high >= fvg.bottom and recent[j].low <= fvg.top:
                    fvg.filled = True
                    break
            fvgs.append(fvg)
    return fvgs


def nearest_unfilled_fvg(fvgs: list[FVG], price: float, direction: str) -> Optional[FVG]:
    """Find the most recent unfilled FVG aligned with direction."""
    candidates = [f for f in fvgs if not f.filled and f.direction == direction]
    if not candidates:
        return None
    # Closest to current price
    return min(candidates, key=lambda f: abs((f.top + f.bottom) / 2 - price))


# ─── Liquidity zones ─────────────────────────────────────────────────────────

def detect_liquidity_zones(d1_candles: list[Candle], current_price: float,
                            atr: float) -> list[LiqLevel]:
    levels: list[LiqLevel] = []
    if not d1_candles:
        return levels

    # Previous Day High/Low
    if len(d1_candles) >= 2:
        prev = d1_candles[-2]
        levels.append(LiqLevel(price=prev.high, label="PDH"))
        levels.append(LiqLevel(price=prev.low,  label="PDL"))

    # Previous Week High/Low (approx last 5 D1 bars)
    if len(d1_candles) >= 6:
        week = d1_candles[-6:-1]
        levels.append(LiqLevel(price=max(c.high for c in week), label="PWH"))
        levels.append(LiqLevel(price=min(c.low  for c in week), label="PWL"))

    # Current Day so far
    today = d1_candles[-1]
    levels.append(LiqLevel(price=today.high, label="CDH"))
    levels.append(LiqLevel(price=today.low,  label="CDL"))

    # Equal Highs/Lows (within 0.3 ATR = "equal")
    tolerance = atr * 0.3
    highs = [c.high for c in d1_candles[-10:]]
    lows  = [c.low  for c in d1_candles[-10:]]
    for i, h in enumerate(highs[:-1]):
        for j in range(i + 1, len(highs)):
            if abs(h - highs[j]) <= tolerance:
                levels.append(LiqLevel(price=(h + highs[j]) / 2, label="EQH"))
                break
    for i, l in enumerate(lows[:-1]):
        for j in range(i + 1, len(lows)):
            if abs(l - lows[j]) <= tolerance:
                levels.append(LiqLevel(price=(l + lows[j]) / 2, label="EQL"))
                break

    return levels


# ─── Asia range ──────────────────────────────────────────────────────────────

def get_asia_range(h1_candles: list[Candle]) -> Optional[dict]:
    """Extract today's Asia session (00:00–07:00 UTC) range."""
    today_utc = datetime.now(tz=timezone.utc).date()
    asia = [
        c for c in h1_candles
        if datetime.fromtimestamp(c.ts, tz=timezone.utc).date() == today_utc
        and 0 <= datetime.fromtimestamp(c.ts, tz=timezone.utc).hour < 7
    ]
    if not asia:
        return None
    return {
        "high":  max(c.high  for c in asia),
        "low":   min(c.low   for c in asia),
        "open":  asia[0].open,
        "close": asia[-1].close,
    }


# ─── Liquidity sweep ─────────────────────────────────────────────────────────

def detect_sweep(candles: list[Candle], levels: list[LiqLevel],
                 atr: float) -> Optional[SweepEvent]:
    """
    Sweep = wick beyond a key level + close back inside.
    Looks at last 5 candles.
    """
    recent = candles[-5:]
    tolerance = atr * 0.15
    for c in reversed(recent):
        for lv in levels:
            # Sweep high (stop hunt above)
            if c.high > lv.price - tolerance and c.close < lv.price:
                return SweepEvent(ts=c.ts, price=c.high, direction="high", level=lv)
            # Sweep low (stop hunt below)
            if c.low < lv.price + tolerance and c.close > lv.price:
                return SweepEvent(ts=c.ts, price=c.low, direction="low", level=lv)
    return None


# ─── MSS / CHoCH ─────────────────────────────────────────────────────────────

def detect_mss(candles: list[Candle], htf_trend: str,
               sweep: Optional[SweepEvent]) -> Optional[MSSEvent]:
    """
    Market Structure Shift: after a sweep, price breaks the most recent
    structural high (for long setup) or low (for short setup).
    CHoCH = against trend. MSS = with trend resumption.
    """
    if not sweep:
        return None

    swings = detect_swings(candles[-30:], lookback=3)
    highs  = [s for s in swings if s.kind == "high"]
    lows   = [s for s in swings if s.kind == "low"]
    last   = candles[-1]

    # Looking for long: swept low → break above recent swing high
    if sweep.direction == "low" and highs:
        recent_high = highs[-1].price
        if last.close > recent_high:
            kind = "MSS" if htf_trend == "bullish" else "CHoCH"
            return MSSEvent(ts=last.ts, price=recent_high, kind=kind)

    # Looking for short: swept high → break below recent swing low
    if sweep.direction == "high" and lows:
        recent_low = lows[-1].price
        if last.close < recent_low:
            kind = "MSS" if htf_trend == "bearish" else "CHoCH"
            return MSSEvent(ts=last.ts, price=recent_low, kind=kind)

    return None


# ─── Displacement ─────────────────────────────────────────────────────────────

def detect_displacement(candles: list[Candle]) -> bool:
    """
    Displacement = large impulsive candle:
      body > 1.5× avg body, body/range > 60%.
    """
    if len(candles) < 5:
        return False
    recent = candles[-10:]
    avg_body = sum(abs(c.close - c.open) for c in recent[:-1]) / max(len(recent) - 1, 1)
    last = candles[-1]
    body  = abs(last.close - last.open)
    rng   = last.high - last.low or 1e-9
    return body > avg_body * 1.5 and (body / rng) > 0.60


# ─── OTE zone ────────────────────────────────────────────────────────────────

def calc_ote(swing_low: float, swing_high: float, direction: str) -> OTEZone:
    """Optimal Trade Entry zone: 61.8%–79% Fibonacci retracement."""
    diff = swing_high - swing_low
    if direction == "LONG":
        # Pullback INTO the range from top
        return OTEZone(
            entry_low  = swing_high - diff * 0.79,
            entry_high = swing_high - diff * 0.618,
            midpoint   = swing_high - diff * 0.705,
        )
    else:
        # Pullback INTO the range from bottom
        return OTEZone(
            entry_low  = swing_low + diff * 0.618,
            entry_high = swing_low + diff * 0.79,
            midpoint   = swing_low + diff * 0.705,
        )


# ─── Main Analysis ────────────────────────────────────────────────────────────

def analyze(symbol: str, store: CandleStore, session_name: str = "") -> SignalResult:
    """
    Full SMC analysis for a symbol.
    Returns a SignalResult with verdict and all context.
    """
    # Gather bars
    m5  = store.bars(5)
    m15 = store.bars(15)
    h1  = store.bars(60)
    h4  = store.bars(240)
    d1  = store.bars(1440)

    if len(m15) < 20:
        return _no_trade(symbol, "Insufficient data", 0)

    now_utc = datetime.now(tz=timezone.utc)
    if not session_name:
        session_name = detect_session(now_utc)

    atr = calc_atr(m15, 14)
    if atr == 0:
        atr = calc_atr(m5, 14)

    current_price = store.current_price() or m15[-1].close

    # ── Trend detection ───────────────────────────────────────────────────────
    htf_trend = detect_trend(h4 or h1, lookback=8) if (h4 or h1) else "ranging"
    ltf_trend = detect_trend(m15, lookback=6)

    # ── Liquidity zones ───────────────────────────────────────────────────────
    liq_levels = detect_liquidity_zones(d1, current_price, atr)
    asia_range = get_asia_range(h1)

    # ── FVG ───────────────────────────────────────────────────────────────────
    fvgs = detect_fvg(m15, max_lookback=50)

    # ── Sweep ─────────────────────────────────────────────────────────────────
    sweep = detect_sweep(m15, liq_levels, atr)

    # ── MSS ───────────────────────────────────────────────────────────────────
    mss = detect_mss(m15, htf_trend, sweep)

    # ── Displacement ──────────────────────────────────────────────────────────
    displacement = detect_displacement(m15)

    # ─── Confidence Scoring ───────────────────────────────────────────────────
    confidence    = 0
    reasons: list[str] = []
    direction: Optional[str] = None

    # Determine directional bias from HTF trend
    if htf_trend == "bullish":
        direction = "LONG"
    elif htf_trend == "bearish":
        direction = "SHORT"
    else:
        direction = None

    # Override direction from sweep if contradicts — sweep direction guides trade
    if sweep:
        sweep_dir = "LONG" if sweep.direction == "low" else "SHORT"
        if direction is None:
            direction = sweep_dir
        elif direction != sweep_dir:
            direction = sweep_dir   # sweep overrides ranging HTF bias

    # 1. HTF trend (25 pts)
    if htf_trend != "ranging":
        confidence += 25
        reasons.append(f"HTF_{htf_trend.upper()}")
    else:
        reasons.append("HTF_RANGING")

    # 2. LTF alignment (10 pts)
    if ltf_trend == htf_trend and htf_trend != "ranging":
        confidence += 10
        reasons.append("LTF_ALIGNED")
    elif ltf_trend != "ranging":
        reasons.append("LTF_DIVERGENT")

    # 3. Session score (15 pts max)
    sess_pts = session_score(session_name)
    confidence += sess_pts
    if sess_pts >= 12:
        reasons.append(f"SESSION_{session_name.upper().replace(' ', '_')}")

    # 4. Asia range context (5 pts)
    if asia_range and direction:
        if direction == "LONG" and current_price > asia_range["high"]:
            confidence += 5
            reasons.append("ABOVE_ASIA_HIGH")
        elif direction == "SHORT" and current_price < asia_range["low"]:
            confidence += 5
            reasons.append("BELOW_ASIA_LOW")

    # 5. Sweep (20 pts)
    if sweep:
        confidence += 20
        reasons.append(f"SWEEP_{sweep.direction.upper()}")

    # 6. MSS/CHoCH (15 pts)
    if mss:
        pts = 15 if mss.kind == "MSS" else 10
        confidence += pts
        reasons.append(mss.kind)

    # 7. Displacement (8 pts)
    if displacement:
        confidence += 8
        reasons.append("DISPLACEMENT")

    # 8. FVG nearby (7 pts)
    fvg_dir = "bull" if direction == "LONG" else "bear"
    active_fvg = nearest_unfilled_fvg(fvgs, current_price, fvg_dir) if direction else None
    if active_fvg:
        confidence += 7
        reasons.append("FVG_NEARBY")

    confidence = min(confidence, 100)

    # ─── Entry levels ─────────────────────────────────────────────────────────
    entry_price: Optional[float] = None
    sl_price:    Optional[float] = None
    tp1_price:   Optional[float] = None
    tp2_price:   Optional[float] = None
    risk_reward: Optional[float] = None
    ote_zone:    Optional[OTEZone] = None

    if direction and confidence >= 40 and sweep and mss:
        swings = detect_swings(m15[-30:], lookback=3)
        sh = [s.price for s in swings if s.kind == "high"]
        sl_list = [s.price for s in swings if s.kind == "low"]

        if direction == "LONG" and sh and sl_list:
            swing_low  = sl_list[-1]
            swing_high = sh[-1]
            ote_zone   = calc_ote(swing_low, swing_high, "LONG")
            entry_price = ote_zone.midpoint
            sl_price    = swing_low - atr * 0.3
            tp1_price   = entry_price + atr * 2.2
            tp2_price   = entry_price + atr * 3.6
            # OTE bonus
            if ote_zone.entry_low <= current_price <= ote_zone.entry_high:
                confidence = min(confidence + 5, 100)
                reasons.append("OTE_ENTRY")

        elif direction == "SHORT" and sh and sl_list:
            swing_low  = sl_list[-1]
            swing_high = sh[-1]
            ote_zone   = calc_ote(swing_low, swing_high, "SHORT")
            entry_price = ote_zone.midpoint
            sl_price    = swing_high + atr * 0.3
            tp1_price   = entry_price - atr * 2.2
            tp2_price   = entry_price - atr * 3.6

        if entry_price and sl_price and tp1_price:
            sl_dist = abs(entry_price - sl_price)
            tp1_dist = abs(tp1_price - entry_price)
            risk_reward = round(tp1_dist / sl_dist, 2) if sl_dist > 0 else None

    # ─── Verdict ──────────────────────────────────────────────────────────────
    verdict = _verdict(confidence, direction, sweep, mss, displacement)

    # Override: bad session / no direction
    if session_name in ("Dead", "Weekend"):
        verdict = "NO_TRADE"
        reasons.append("BAD_SESSION")
    if direction is None and verdict in ("LONG_NOW", "SHORT_NOW"):
        verdict = "NO_TRADE"

    # ─── Invalidation text ────────────────────────────────────────────────────
    invalidation = _build_invalidation(verdict, direction, sweep, liq_levels, atr)

    log.info("analysis_complete", symbol=symbol, verdict=verdict,
             confidence=confidence, direction=direction, session=session_name)

    return SignalResult(
        symbol=symbol, timeframe=15, ts=int(now_utc.timestamp()),
        verdict=verdict, confidence=confidence, direction=direction,
        entry_price=round(entry_price, 5) if entry_price else None,
        sl_price=round(sl_price, 5) if sl_price else None,
        tp1_price=round(tp1_price, 5) if tp1_price else None,
        tp2_price=round(tp2_price, 5) if tp2_price else None,
        risk_reward=risk_reward,
        atr=round(atr, 6),
        htf_trend=htf_trend, ltf_trend=ltf_trend,
        session_name=session_name,
        reasoning_codes=reasons,
        sweep=sweep, mss=mss, fvg=active_fvg,
        ote_zone=ote_zone, liquidity_levels=liq_levels,
        displacement=displacement,
        invalidation=invalidation,
    )


def _verdict(confidence: int, direction: Optional[str],
             sweep: Optional[SweepEvent], mss: Optional[MSSEvent],
             displacement: bool) -> str:
    if direction is None:
        return "NO_TRADE"
    strong = mss is not None and (sweep is not None or displacement)
    if confidence >= 65 and strong:
        return f"{direction}_NOW".replace("LONG_NOW", "LONG_NOW").replace("SHORT_NOW", "SHORT_NOW")
    if 40 <= confidence < 65:
        return f"WAIT_{direction}"
    return "NO_TRADE"


def _no_trade(symbol: str, reason: str, confidence: int) -> SignalResult:
    now = int(datetime.now(tz=timezone.utc).timestamp())
    return SignalResult(
        symbol=symbol, timeframe=15, ts=now,
        verdict="NO_TRADE", confidence=confidence, direction=None,
        entry_price=None, sl_price=None, tp1_price=None, tp2_price=None,
        risk_reward=None, atr=None,
        htf_trend="ranging", ltf_trend="ranging",
        session_name="Unknown",
        reasoning_codes=[reason],
        sweep=None, mss=None, fvg=None, ote_zone=None,
        liquidity_levels=[], displacement=False,
        invalidation=reason,
    )


def _build_invalidation(verdict: str, direction: Optional[str],
                         sweep: Optional[SweepEvent],
                         levels: list[LiqLevel], atr: float) -> str:
    if verdict == "NO_TRADE":
        return "No clear structure — stay flat"
    if direction == "LONG":
        sl_lv = next((l for l in levels if l.label == "PDL"), None)
        return (f"Invalidated on close below {sl_lv.price:.4f} (PDL)"
                if sl_lv else "Invalidated on structural low break")
    if direction == "SHORT":
        sl_lv = next((l for l in levels if l.label == "PDH"), None)
        return (f"Invalidated on close above {sl_lv.price:.4f} (PDH)"
                if sl_lv else "Invalidated on structural high break")
    return "Monitor for confirmation"
