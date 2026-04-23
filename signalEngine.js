/**
 * signalEngine.js — PropPilot AI Deterministic SMC/ICT Signal Engine
 * ─────────────────────────────────────────────────────────────────────
 * PURE FUNCTIONS — zero external dependencies, zero LLM calls.
 * All signal logic is deterministic and rule-based (Smart Money Concepts / ICT).
 *
 * Signal Grammar (3-layer):
 *   LAYER 1 — CONTEXT (HTF):  H4/D1 trend, key liquidity zones, FVG imbalances
 *   LAYER 2 — NARRATIVE:      Session detection, Asia range, London break logic
 *   LAYER 3 — TRIGGER (LTF):  Liquidity sweep → MSS/CHoCH → Displacement → OTE entry
 *
 * Main entry point:
 *   PropPilot.analyzeMarketStructure(candles, symbol, time?, options?)
 *
 * Returns:
 * {
 *   verdict:         "LONG_NOW"|"SHORT_NOW"|"WAIT_LONG"|"WAIT_SHORT"|"NO_TRADE"
 *   confidence:      0–100
 *   reasoning_codes: string[]
 *   levels:          { entry, sl, tp1, tp2, ote_zone, risk_reward }
 *   invalidation:    string
 *   session_context: string
 *   structure:       { trend_htf, trend_ltf, atr, swing_high, swing_low, liquidity_zones, fvg_zones, session, asia_range, london_break, current_price }
 *   triggers:        { sweep, mss, displacement }
 *   meta:            { symbol, timestamp, candle_counts }
 * }
 *
 * @version 2.0.0
 */
(function (global) {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────────

  var VERDICTS = {
    LONG_NOW:   'LONG_NOW',
    SHORT_NOW:  'SHORT_NOW',
    WAIT_LONG:  'WAIT_LONG',
    WAIT_SHORT: 'WAIT_SHORT',
    NO_TRADE:   'NO_TRADE',
  };

  var SESSIONS = {
    ASIA:     { start: 0,  end: 9  },  // UTC hours
    LONDON:   { start: 8,  end: 17 },
    NEW_YORK: { start: 13, end: 22 },
    OVERLAP:  { start: 13, end: 17 },
  };

  var DEFAULT_SWING_LOOKBACK = 5;

  // ─── Micro-utilities ────────────────────────────────────────────────────────

  function last(arr, n) { n = n || 1; return arr[arr.length - n]; }

  function mean(arr) {
    if (!arr.length) return 0;
    var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function round5(n) { return Math.round(n * 100000) / 100000; }

  /**
   * Average True Range
   * @param {Array} candles — OHLCV array
   * @param {number} period — default 14
   */
  function calcATR(candles, period) {
    period = period || 14;
    if (candles.length < period + 1) {
      // Fallback: average range of available candles
      var ranges = candles.map(function (c) { return c.high - c.low; });
      return mean(ranges) || 0;
    }
    var slice = candles.slice(-(period + 1));
    var trs   = slice.map(function (c, i, a) {
      if (i === 0) return c.high - c.low;
      var prev = a[i - 1];
      return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    });
    return mean(trs.slice(1));
  }

  // ─── Layer 1-A: Swing High / Low Detection ─────────────────────────────────

  /**
   * Identify pivot highs and lows using a symmetrical lookback window.
   * A pivot high at index i: candle[i].high > all candles within [i-lb, i+lb].
   *
   * @param {Array}  candles   OHLCV array
   * @param {number} lookback  bars on each side (default 5)
   * @returns {{ highs: Array<{time,price,index}>, lows: Array<{time,price,index}> }}
   */
  function detectSwings(candles, lookback) {
    lookback = lookback || DEFAULT_SWING_LOOKBACK;
    var highs = [], lows = [];
    var n = candles.length;
    for (var i = lookback; i < n - lookback; i++) {
      var isHigh = true, isLow = true;
      for (var j = 1; j <= lookback; j++) {
        if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
        if (candles[i].low  >= candles[i - j].low  || candles[i].low  >= candles[i + j].low ) isLow  = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) highs.push({ time: candles[i].time, price: candles[i].high, index: i });
      if (isLow)  lows.push ({ time: candles[i].time, price: candles[i].low,  index: i });
    }
    return { highs: highs, lows: lows };
  }

  // ─── Layer 1-B: Trend Detection ───────────────────────────────────────────

  /**
   * Determine macro market structure from swing points.
   * Bullish:  Last swing high HIGHER than previous AND last swing low HIGHER than previous (HH + HL)
   * Bearish:  Last swing high LOWER than previous AND last swing low LOWER than previous (LH + LL)
   * Ranging:  Mixed / insufficient data
   *
   * @returns {'bullish'|'bearish'|'ranging'}
   */
  function detectTrend(candles, lookback) {
    var swings = detectSwings(candles, lookback || DEFAULT_SWING_LOOKBACK);
    var highs  = swings.highs, lows = swings.lows;
    if (highs.length < 2 || lows.length < 2) return 'ranging';

    var lastH = highs[highs.length - 1].price;
    var prevH = highs[highs.length - 2].price;
    var lastL = lows[lows.length - 1].price;
    var prevL = lows[lows.length - 2].price;

    if (lastH > prevH && lastL > prevL) return 'bullish';  // HH + HL
    if (lastH < prevH && lastL < prevL) return 'bearish';  // LH + LL
    return 'ranging';
  }

  // ─── Layer 1-C: Fair Value Gaps (FVG / Imbalance Zones) ───────────────────

  /**
   * Detect 3-candle Fair Value Gaps (price imbalances not yet revisited).
   *
   * Bullish FVG: candle[i-1].low > candle[i+1].high  → gap above candle[i+1]
   *              The middle candle (i) is the impulse; FVG = [candle[i+1].high, candle[i-1].low]
   *
   * Bearish FVG: candle[i-1].high < candle[i+1].low  → gap below candle[i-1]
   *              FVG = [candle[i-1].high, candle[i+1].low]
   *
   * @param {Array} candles — OHLCV slice (typically H1 or H4)
   * @returns {Array<{ type, top, bottom, midpoint, time, filled, size }>}
   */
  function detectFVG(candles) {
    var fvgs = [];
    for (var i = 1; i < candles.length - 1; i++) {
      var prev = candles[i - 1];
      var curr = candles[i];
      var next = candles[i + 1];

      // Bullish FVG
      if (prev.low > next.high) {
        var top    = prev.low;
        var bottom = next.high;
        var mid    = (top + bottom) / 2;
        var size   = top - bottom;
        var filled = false;
        for (var k = i + 2; k < candles.length; k++) {
          if (candles[k].low <= mid) { filled = true; break; }
        }
        fvgs.push({ type: 'bullish', top: top, bottom: bottom, midpoint: mid, time: curr.time, filled: filled, size: size });
      }

      // Bearish FVG
      if (prev.high < next.low) {
        var topB    = next.low;
        var bottomB = prev.high;
        var midB    = (topB + bottomB) / 2;
        var sizeB   = topB - bottomB;
        var filledB = false;
        for (var k2 = i + 2; k2 < candles.length; k2++) {
          if (candles[k2].high >= midB) { filledB = true; break; }
        }
        fvgs.push({ type: 'bearish', top: topB, bottom: bottomB, midpoint: midB, time: curr.time, filled: filledB, size: sizeB });
      }
    }
    return fvgs;
  }

  // ─── Layer 1-D: Liquidity Zones ───────────────────────────────────────────

  /**
   * Identify key liquidity pools (engineered liquidity where stops cluster).
   * Sources: Previous Day H/L, Previous Week H/L, Equal Highs/Lows (EQH/EQL).
   *
   * @param {Array}  htfCandles   Daily or H4 candles
   * @param {number} currentPrice Current market price
   * @param {number} atrValue     ATR for context (equal H/L tolerance)
   * @returns {Array<{ type, price, label, distancePct, abovePrice }>}
   */
  function detectLiquidityZones(htfCandles, currentPrice, atrValue) {
    var zones = [];
    if (!htfCandles || htfCandles.length < 2) return zones;

    atrValue = atrValue || currentPrice * 0.005;
    var eqTolerance = Math.min(atrValue * 0.3, currentPrice * 0.001); // 0.1% or 30% ATR

    // Previous Day H/L
    var prev = htfCandles[htfCandles.length - 2];
    var curr = htfCandles[htfCandles.length - 1];
    zones.push({ type: 'PDH', price: prev.high, label: 'Prev Day High', abovePrice: prev.high > currentPrice });
    zones.push({ type: 'PDL', price: prev.low,  label: 'Prev Day Low',  abovePrice: prev.low  > currentPrice });

    // Current Day H/L (intraday reference)
    zones.push({ type: 'CDH', price: curr.high, label: 'Curr Day High', abovePrice: curr.high > currentPrice });
    zones.push({ type: 'CDL', price: curr.low,  label: 'Curr Day Low',  abovePrice: curr.low  > currentPrice });

    // Previous Week H/L (last 5 D1 candles)
    if (htfCandles.length >= 7) {
      var week = htfCandles.slice(-7, -1);
      var wH   = Math.max.apply(null, week.map(function (c) { return c.high; }));
      var wL   = Math.min.apply(null, week.map(function (c) { return c.low; }));
      zones.push({ type: 'PWH', price: wH, label: 'Prev Week High', abovePrice: wH > currentPrice });
      zones.push({ type: 'PWL', price: wL, label: 'Prev Week Low',  abovePrice: wL > currentPrice });
    }

    // Equal Highs / Equal Lows (resting buy-side / sell-side liquidity)
    var swings = detectSwings(htfCandles, 2);

    // Equal Highs  (stops above)
    var addedEQH = {};
    for (var i = 0; i < swings.highs.length - 1; i++) {
      for (var j = i + 1; j < swings.highs.length; j++) {
        var diff = Math.abs(swings.highs[i].price - swings.highs[j].price);
        if (diff < eqTolerance) {
          var avgP = (swings.highs[i].price + swings.highs[j].price) / 2;
          var key  = Math.round(avgP * 10000);
          if (!addedEQH[key]) {
            zones.push({ type: 'EQH', price: avgP, label: 'Equal Highs (Buy-side Liquidity)', abovePrice: avgP > currentPrice });
            addedEQH[key] = true;
          }
        }
      }
    }

    // Equal Lows  (stops below)
    var addedEQL = {};
    for (var a = 0; a < swings.lows.length - 1; a++) {
      for (var b = a + 1; b < swings.lows.length; b++) {
        var diffL = Math.abs(swings.lows[a].price - swings.lows[b].price);
        if (diffL < eqTolerance) {
          var avgL = (swings.lows[a].price + swings.lows[b].price) / 2;
          var keyL = Math.round(avgL * 10000);
          if (!addedEQL[keyL]) {
            zones.push({ type: 'EQL', price: avgL, label: 'Equal Lows (Sell-side Liquidity)', abovePrice: avgL > currentPrice });
            addedEQL[keyL] = true;
          }
        }
      }
    }

    // Annotate distance %
    zones.forEach(function (z) {
      z.distancePct = ((z.price - currentPrice) / currentPrice) * 100;
    });

    // Sort by proximity
    zones.sort(function (a, b) { return Math.abs(a.distancePct) - Math.abs(b.distancePct); });
    return zones;
  }

  // ─── Layer 2-A: Session Detection ─────────────────────────────────────────

  /**
   * Identify the current trading session from UTC time.
   * @param {Date|number} utcTime  — Date object or ms timestamp
   * @returns {{ session: string, hour: number, isWeekend: boolean }}
   */
  function detectSession(utcTime) {
    var d   = utcTime instanceof Date ? utcTime : new Date(utcTime || Date.now());
    var h   = d.getUTCHours() + d.getUTCMinutes() / 60;
    var dow = d.getUTCDay(); // 0 = Sun, 6 = Sat
    if (dow === 0 || dow === 6) return { session: 'Closed', hour: h, isWeekend: true };
    var session;
    if      (h >= 13 && h < 17) session = 'Overlap';    // London + NY
    else if (h >= 8  && h < 17) session = 'London';
    else if (h >= 13 && h < 22) session = 'NewYork';
    else if (h >= 0  && h < 9 ) session = 'Asia';
    else                         session = 'PreMarket';  // 22:00–00:00 UTC
    return { session: session, hour: h, isWeekend: false };
  }

  /**
   * Extract the most recent Asia session range from M15/M30 candles.
   * Asia session: 00:00 – 09:00 UTC
   */
  function getAsiaRange(candles) {
    var today     = new Date();
    var todayDate = today.toISOString().slice(0, 10);
    var asiaCands = candles.filter(function (c) {
      var d = new Date(c.time * 1000);
      // Same date and within Asia hours
      return d.toISOString().slice(0, 10) === todayDate && d.getUTCHours() >= 0 && d.getUTCHours() < 9;
    });
    // Fallback: last 36 M15 candles that fall within UTC 00-09
    if (asiaCands.length === 0) {
      asiaCands = candles.filter(function (c) {
        var h = new Date(c.time * 1000).getUTCHours();
        return h >= 0 && h < 9;
      }).slice(-36);
    }
    if (asiaCands.length === 0) return null;
    return {
      high:  Math.max.apply(null, asiaCands.map(function (c) { return c.high; })),
      low:   Math.min.apply(null, asiaCands.map(function (c) { return c.low; })),
      open:  asiaCands[0].open,
      close: last(asiaCands).close,
      count: asiaCands.length,
    };
  }

  // ─── Layer 3-A: Liquidity Sweep Detection ──────────────────────────────────

  /**
   * Detect a liquidity sweep: price extends BEYOND a key level (takes out stops)
   * then CLOSES back inside — the classic "stop hunt" / "liquidity grab".
   *
   * @param {Array}  candles   Recent M5/M15 candles (last 20–50)
   * @param {Array}  levels    Liquidity zones (from detectLiquidityZones)
   * @param {number} atrValue  ATR for threshold (sweep must extend > 10% ATR)
   * @returns {{ swept, direction, level, levelType, sweepCandle, barsAgo } | null}
   */
  function detectLiquiditySweep(candles, levels, atrValue) {
    if (!candles.length || !levels.length) return null;
    var threshold = atrValue * 0.08;  // Minimum extension beyond level

    // Scan last 15 candles for the most recent sweep
    var recent = candles.slice(-15);
    for (var i = recent.length - 1; i >= 1; i--) {
      var c = recent[i];
      for (var j = 0; j < levels.length; j++) {
        var lv = levels[j];
        var p  = lv.price;

        // ── Bullish sweep: wick below a support level, closes ABOVE it ──
        if (c.low < p - threshold && c.close > p) {
          return {
            swept:       true,
            direction:   'low',             // Swept lows (bullish reversal signal)
            level:       p,
            levelType:   lv.type,
            levelLabel:  lv.label,
            sweepCandle: c,
            barsAgo:     recent.length - 1 - i,
            sweepDepth:  p - c.low,         // How far below the level the wick went
          };
        }

        // ── Bearish sweep: wick above a resistance level, closes BELOW it ──
        if (c.high > p + threshold && c.close < p) {
          return {
            swept:       true,
            direction:   'high',            // Swept highs (bearish reversal signal)
            level:       p,
            levelType:   lv.type,
            levelLabel:  lv.label,
            sweepCandle: c,
            barsAgo:     recent.length - 1 - i,
            sweepDepth:  c.high - p,
          };
        }
      }
    }
    return null;
  }

  // ─── Layer 3-B: Market Structure Shift / CHoCH ────────────────────────────

  /**
   * Detect a Market Structure Shift (MSS) or Change of Character (CHoCH).
   *
   * Bullish MSS: After sweeping lows (or in downtrend), price closes ABOVE
   *              the most recent Lower High → structure flips bullish.
   * Bearish MSS: After sweeping highs (or in uptrend), price closes BELOW
   *              the most recent Higher Low → structure flips bearish.
   *
   * @param {Array}   candles   Recent M5/M15 candles
   * @param {string}  htfTrend  'bullish'|'bearish'|'ranging'
   * @param {Object}  sweep     Result from detectLiquiditySweep (or null)
   * @returns {{ mss, direction, level, type, candle } | null}
   */
  function detectMSS(candles, htfTrend, sweep) {
    if (candles.length < 10) return null;
    var swings = detectSwings(candles, 3);
    var highs  = swings.highs;
    var lows   = swings.lows;
    var cur    = last(candles);
    if (!cur) return null;
    var cp = cur.close;

    // ── Check for Bullish MSS ───────────────────────────────────────────────
    // Condition: looking for longs — sweep of lows occurred, OR HTF is bullish
    var lookBullish = (sweep && sweep.direction === 'low') || htfTrend === 'bullish';
    if (lookBullish && highs.length >= 2) {
      var lastH = highs[highs.length - 1];
      var prevH = highs[highs.length - 2];
      // The last high was lower than the one before → downtrend structure
      // A close above the last high = CHoCH
      if (prevH.price > lastH.price && cp > lastH.price) {
        return { mss: true, direction: 'bullish', level: lastH.price, type: 'CHoCH', candle: cur };
      }
      // Simple upside break of last swing high in a bullish HTF environment = MSS
      if (htfTrend === 'bullish' && cp > lastH.price) {
        return { mss: true, direction: 'bullish', level: lastH.price, type: 'MSS', candle: cur };
      }
    }

    // ── Check for Bearish MSS ───────────────────────────────────────────────
    var lookBearish = (sweep && sweep.direction === 'high') || htfTrend === 'bearish';
    if (lookBearish && lows.length >= 2) {
      var lastL = lows[lows.length - 1];
      var prevL = lows[lows.length - 2];
      // The last low was higher than the one before → uptrend structure
      // A close below the last low = CHoCH
      if (prevL.price < lastL.price && cp < lastL.price) {
        return { mss: true, direction: 'bearish', level: lastL.price, type: 'CHoCH', candle: cur };
      }
      if (htfTrend === 'bearish' && cp < lastL.price) {
        return { mss: true, direction: 'bearish', level: lastL.price, type: 'MSS', candle: cur };
      }
    }

    return null;
  }

  // ─── Layer 3-C: Displacement Detection ────────────────────────────────────

  /**
   * Detect a displacement candle (strong institutional impulse).
   * Criteria:
   *   • Body > 1.5× average body of prior 10 candles
   *   • Body-to-range ratio > 60% (closes near the extreme)
   *   • Optionally engulfs the previous candle's body
   *
   * @param {Array} candles  Recent LTF candles (M5/M15)
   * @returns {{ displacement, direction, candle, bodyRatio, relativeSize } | null}
   */
  function detectDisplacement(candles) {
    if (candles.length < 12) return null;
    var recent   = candles.slice(-12);
    var lookback = recent.slice(0, 10);
    var avgBody  = mean(lookback.map(function (c) { return Math.abs(c.close - c.open); })) || 0.0001;
    var cur      = last(recent);
    var body     = Math.abs(cur.close - cur.open);
    var range    = (cur.high - cur.low) || 0.0001;
    var bodyRatio = body / range;

    if (body > avgBody * 1.5 && bodyRatio > 0.6) {
      var prev    = recent[recent.length - 2];
      var engulfs = body > Math.abs(prev.close - prev.open) * 1.2;
      return {
        displacement: true,
        direction:    cur.close > cur.open ? 'bullish' : 'bearish',
        candle:       cur,
        bodyRatio:    bodyRatio,
        relativeSize: body / avgBody,
        engulfs:      engulfs,
      };
    }
    return null;
  }

  // ─── Fibonacci OTE (Optimal Trade Entry) Zone ─────────────────────────────

  /**
   * Calculate the ICT Optimal Trade Entry zone.
   * OTE = 61.8% – 79.0% Fibonacci retracement of the displacement move.
   * For longs:  measured from swing low to swing high; OTE is the retracement zone.
   * For shorts: measured from swing high to swing low; OTE is the bounce zone.
   *
   * @param {number} swingLow
   * @param {number} swingHigh
   * @param {string} direction  'bullish' | 'bearish'
   * @returns {{ ote_high, ote_low, equilibrium, fib_50, fib_618, fib_79 }}
   */
  function calcOTE(swingLow, swingHigh, direction) {
    var range = swingHigh - swingLow;
    if (direction === 'bullish') {
      return {
        ote_high:     round5(swingHigh - range * 0.618),
        ote_low:      round5(swingHigh - range * 0.79),
        equilibrium:  round5(swingHigh - range * 0.50),
        fib_618:      round5(swingHigh - range * 0.618),
        fib_79:       round5(swingHigh - range * 0.79),
      };
    } else {
      return {
        ote_high:     round5(swingLow + range * 0.79),
        ote_low:      round5(swingLow + range * 0.618),
        equilibrium:  round5(swingLow + range * 0.50),
        fib_618:      round5(swingLow + range * 0.618),
        fib_79:       round5(swingLow + range * 0.79),
      };
    }
  }

  // ─── Confidence Scoring Engine ─────────────────────────────────────────────

  /**
   * Score a signal 0–100 based on confluence of factors.
   * Higher scores = more aligned with the full SMC setup grammar.
   */
  function scoreSignal(factors) {
    var score = 0;
    var codes = [];

    // HTF trend (+25)
    if (factors.htfTrend === 'bullish') { score += 25; codes.push('HTF_BULLISH'); }
    else if (factors.htfTrend === 'bearish') { score += 25; codes.push('HTF_BEARISH'); }

    // LTF trend aligned with HTF (+10)
    if (factors.ltfTrend && factors.ltfTrend === factors.htfTrend) { score += 10; codes.push('LTF_ALIGNED'); }

    // Session quality (+15 premium, +10 NY, +5 Asia)
    if (factors.session === 'Overlap' || factors.session === 'London') {
      score += 15; codes.push('PREMIUM_SESSION');
    } else if (factors.session === 'NewYork') {
      score += 10; codes.push('NY_SESSION');
    } else if (factors.session === 'Asia') {
      score += 5;  codes.push('ASIA_SESSION');
    }

    // Asia range formed (range-break plays) (+5)
    if (factors.asiaRangeFormed) { score += 5; codes.push('ASIA_RANGE_FORMED'); }

    // London broke Asia range (+5)
    if (factors.londonBreak) { score += 5; codes.push('LONDON_RANGE_BREAK'); }

    // Liquidity sweep (+20)
    if (factors.sweep && factors.sweep.swept) {
      score += 20;
      codes.push('LIQUIDITY_SWEEP_' + (factors.sweep.direction === 'low' ? 'LOW' : 'HIGH'));
    }

    // MSS / CHoCH (+15)
    if (factors.mss && factors.mss.mss) {
      score += 15;
      codes.push(factors.mss.type + '_' + factors.mss.direction.toUpperCase()); // e.g. CHoCH_BULLISH
    }

    // Displacement candle (+8)
    if (factors.displacement && factors.displacement.displacement) {
      score += 8;
      codes.push('DISPLACEMENT_' + factors.displacement.direction.toUpperCase());
    }

    // Unfilled FVG nearby (+7)
    if (factors.fvgNearby) { score += 7; codes.push('FVG_MAGNET'); }

    return { score: Math.min(100, score), codes: codes };
  }

  // ─── Main Entry: analyzeMarketStructure ────────────────────────────────────

  /**
   * Full SMC/ICT market analysis across all layers.
   *
   * @param {Object} candles    — { m5:[], m15:[], h1:[], h4:[], d1:[] }
   * @param {string} symbol     — e.g. "BTCUSDT", "XAUUSD", "NAS100"
   * @param {Date|number} [time]— UTC time (defaults to Date.now())
   * @param {Object} [options]  — { newsRisk: bool, accountBalance, dailyLoss, dailyDDLimit }
   *
   * @returns {SignalResult}
   */
  function analyzeMarketStructure(candles, symbol, time, options) {
    options = options || {};
    var now = time instanceof Date ? time : new Date(time || Date.now());

    // ── Resolve best available candle source ─────────────────────────────────
    var m5  = (candles.m5  || []).slice();
    var m15 = (candles.m15 || []).slice();
    var h1  = (candles.h1  || []).slice();
    var h4  = (candles.h4  || []).slice();
    var d1  = (candles.d1  || []).slice();

    var ltfCandles = m5.length >= 20 ? m5 : (m15.length >= 20 ? m15 : []);

    if (ltfCandles.length === 0) {
      return {
        verdict: VERDICTS.NO_TRADE, confidence: 0,
        reasoning_codes: ['INSUFFICIENT_DATA'],
        levels: null, invalidation: 'Waiting for data',
        session_context: 'Loading…',
        structure: null, triggers: null, meta: { symbol: symbol, timestamp: now.toISOString() },
      };
    }

    var currentCandle = last(ltfCandles);
    var currentPrice  = currentCandle.close;

    // ── LAYER 1: CONTEXT (HTF) ───────────────────────────────────────────────

    // Trend on H4 (fallback to H1, then M15)
    var htfTrend = 'ranging';
    if (h4.length >= 20)       htfTrend = detectTrend(h4, 3);
    else if (h1.length >= 20)  htfTrend = detectTrend(h1, 4);
    else if (m15.length >= 30) htfTrend = detectTrend(m15, 5);

    var ltfTrend = m15.length >= 20 ? detectTrend(m15, 4) : detectTrend(m5, 4);

    // ATR — prefer H1, fall back to LTF
    var atrH1  = h1.length  > 15 ? calcATR(h1,  14) : 0;
    var atrM5  = m5.length  > 15 ? calcATR(m5,  14) : 0;
    var atrH4  = h4.length  > 15 ? calcATR(h4,  14) : 0;
    var useAtr = atrH1 || (atrM5 * 12) || (currentPrice * 0.005);  // H1 ATR or approx

    // Liquidity zones from D1 or H4
    var htfCtx   = d1.length >= 3 ? d1 : (h4.length >= 6 ? h4 : []);
    var liquidity = detectLiquidityZones(htfCtx, currentPrice, useAtr);

    // FVGs on H4 and H1 (unfilled ones only)
    var fvgsH4   = h4.length > 3 ? detectFVG(h4.slice(-60)).filter(function (f) { return !f.filled; }) : [];
    var fvgsH1   = h1.length > 3 ? detectFVG(h1.slice(-80)).filter(function (f) { return !f.filled; }) : [];
    var allFVGs  = fvgsH4.concat(fvgsH1);

    // FVGs within 2× ATR of current price
    var nearbyFVGs = allFVGs.filter(function (f) {
      return Math.abs(f.midpoint - currentPrice) < useAtr * 2;
    });

    // ── LAYER 2: NARRATIVE (Session) ─────────────────────────────────────────

    var sessionData        = detectSession(now);
    var session            = sessionData.session;
    var asiaRange          = getAsiaRange(m15.length >= 10 ? m15 : m5);
    var asiaFormed         = asiaRange && asiaRange.count >= 4;
    var londonBreakDir     = null;

    if (asiaRange && (session === 'London' || session === 'Overlap' || session === 'NewYork')) {
      if (currentPrice > asiaRange.high * 1.0001) londonBreakDir = 'bullish';
      else if (currentPrice < asiaRange.low * 0.9999) londonBreakDir = 'bearish';
    }

    // ── LAYER 3: TRIGGER (LTF) ───────────────────────────────────────────────

    var ltfRecent = ltfCandles.slice(-50);

    // Build level list for sweep detection: key zones + Asia H/L
    var sweepLevels = liquidity.slice(0, 8);
    if (asiaRange) {
      sweepLevels.push({ type: 'ASIA_HIGH', price: asiaRange.high, label: 'Asia High' });
      sweepLevels.push({ type: 'ASIA_LOW',  price: asiaRange.low,  label: 'Asia Low'  });
    }

    var sweep       = detectLiquiditySweep(ltfRecent, sweepLevels, atrM5 || useAtr * 0.25);
    var mss         = detectMSS(ltfRecent, htfTrend, sweep);
    var disp        = detectDisplacement(ltfRecent);

    // ── SCORING ──────────────────────────────────────────────────────────────

    var scored = scoreSignal({
      htfTrend:       htfTrend,
      ltfTrend:       ltfTrend,
      session:        session,
      asiaRangeFormed:asiaFormed,
      londonBreak:    londonBreakDir !== null,
      sweep:          sweep,
      mss:            mss,
      displacement:   disp,
      fvgNearby:      nearbyFVGs.length > 0,
    });
    var confidence = scored.score;
    var codes      = scored.codes;

    // ── VERDICT LOGIC ─────────────────────────────────────────────────────────

    var verdict      = VERDICTS.NO_TRADE;
    var newsBlocked  = options.newsRisk === true;
    if (newsBlocked) codes.push('NEWS_RISK_BLOCKED');

    // Overall directional bias
    var bullBias = (htfTrend === 'bullish') || (londonBreakDir === 'bullish' && htfTrend !== 'bearish');
    var bearBias = (htfTrend === 'bearish') || (londonBreakDir === 'bearish' && htfTrend !== 'bullish');

    if (!newsBlocked) {
      var hasTrigger = mss && mss.mss && (disp && disp.displacement || sweep && sweep.swept);

      if (hasTrigger && confidence >= 65) {
        if (mss.direction === 'bullish' && (bullBias || htfTrend === 'ranging')) {
          verdict = VERDICTS.LONG_NOW;
        } else if (mss.direction === 'bearish' && (bearBias || htfTrend === 'ranging')) {
          verdict = VERDICTS.SHORT_NOW;
        }
      } else if (confidence >= 40) {
        // Setup building — wait for trigger
        var mssDir = mss && mss.mss ? mss.direction : null;
        if      (bullBias || mssDir === 'bullish') verdict = VERDICTS.WAIT_LONG;
        else if (bearBias || mssDir === 'bearish') verdict = VERDICTS.WAIT_SHORT;
      }
    }

    // ── ENTRY LEVELS ─────────────────────────────────────────────────────────

    var ltfSwings = detectSwings(ltfRecent, 3);
    var levels    = null;

    if (verdict !== VERDICTS.NO_TRADE) {
      var swH  = ltfSwings.highs.length ? last(ltfSwings.highs).price : currentPrice + useAtr;
      var swL  = ltfSwings.lows.length  ? last(ltfSwings.lows).price  : currentPrice - useAtr;
      var rrTarget = 2.5;

      if (verdict === VERDICTS.LONG_NOW || verdict === VERDICTS.WAIT_LONG) {
        var ote  = calcOTE(swL, swH, 'bullish');
        var entr = ote.ote_high;           // Conservative entry (top of OTE zone)
        var sl   = swL - (atrM5 || useAtr * 0.2) * 0.5;
        var rng  = entr - sl;
        levels   = {
          entry:       round5(entr),
          sl:          round5(sl),
          tp1:         round5(entr + rng * 1.5),
          tp2:         round5(entr + rng * rrTarget),
          ote_zone:    [round5(ote.ote_low), round5(ote.ote_high)],
          risk_reward: rrTarget,
          direction:   'long',
        };
      } else if (verdict === VERDICTS.SHORT_NOW || verdict === VERDICTS.WAIT_SHORT) {
        var oteS = calcOTE(swL, swH, 'bearish');
        var entrS = oteS.ote_low;          // Conservative entry (bottom of OTE zone)
        var slS   = swH + (atrM5 || useAtr * 0.2) * 0.5;
        var rngS  = slS - entrS;
        levels    = {
          entry:       round5(entrS),
          sl:          round5(slS),
          tp1:         round5(entrS - rngS * 1.5),
          tp2:         round5(entrS - rngS * rrTarget),
          ote_zone:    [round5(oteS.ote_low), round5(oteS.ote_high)],
          risk_reward: rrTarget,
          direction:   'short',
        };
      }
    }

    // ── INVALIDATION ─────────────────────────────────────────────────────────

    var invalidation = 'No active setup — watching for trigger conditions.';
    if (levels) {
      var dir     = levels.direction;
      var sweepLbl = sweep && sweep.swept ? ' or price reclaims sweep at ' + round5(sweep.level) : '';
      invalidation = (dir === 'long' ? 'LONG' : 'SHORT') + ' invalidated on M5 close ' +
        (dir === 'long' ? 'below ' : 'above ') + round5(levels.sl) + sweepLbl + '.';
    } else if (verdict === VERDICTS.WAIT_LONG) {
      invalidation = 'Waiting for bullish MSS on M5/M15 after a sweep of sell-side liquidity.';
    } else if (verdict === VERDICTS.WAIT_SHORT) {
      invalidation = 'Waiting for bearish MSS on M5/M15 after a sweep of buy-side liquidity.';
    }

    // ── SESSION CONTEXT STRING ────────────────────────────────────────────────

    var sMap = {
      Asia: '🌏 Asia', London: '🇬🇧 London', Overlap: '🔄 London/NY Overlap',
      NewYork: '🗽 New York', Closed: '🔒 Closed', PreMarket: '⏳ Pre-Market',
    };
    var sessionCtx = sMap[session] || session;
    if (londonBreakDir) sessionCtx += ', Asia ' + (londonBreakDir === 'bullish' ? 'High Broken ↑' : 'Low Broken ↓');
    if (htfTrend !== 'ranging') sessionCtx += ', HTF ' + htfTrend.charAt(0).toUpperCase() + htfTrend.slice(1);

    // ── RESULT ────────────────────────────────────────────────────────────────

    return {
      verdict:         verdict,
      confidence:      confidence,
      reasoning_codes: codes,
      levels:          levels,
      invalidation:    invalidation,
      session_context: sessionCtx,

      structure: {
        trend_htf:       htfTrend,
        trend_ltf:       ltfTrend,
        atr:             round5(useAtr),
        atr_m5:          round5(atrM5),
        atr_h1:          round5(atrH1),
        swing_high:      ltfSwings.highs.length ? last(ltfSwings.highs).price : null,
        swing_low:       ltfSwings.lows.length  ? last(ltfSwings.lows).price  : null,
        htf_swings:      detectSwings(h4.length >= 10 ? h4.slice(-30) : m15.slice(-40), 3),
        liquidity_zones: liquidity.slice(0, 10),
        fvg_zones:       nearbyFVGs,
        all_fvgs:        allFVGs.slice(-30),
        session:         session,
        session_hour:    sessionData.hour,
        asia_range:      asiaRange,
        london_break:    londonBreakDir,
        current_price:   currentPrice,
      },

      triggers: {
        sweep:        sweep,
        mss:          mss,
        displacement: disp,
      },

      meta: {
        symbol:   symbol,
        timestamp: now.toISOString(),
        candle_counts: { m5: m5.length, m15: m15.length, h1: h1.length, h4: h4.length, d1: d1.length },
      },
    };
  }

  // ─── Prop Firm Compliance Check ────────────────────────────────────────────

  /**
   * Validate a signal against FTMO / FundedNext prop firm rules.
   * @param {Object} signal  — Output of analyzeMarketStructure
   * @param {Object} account — { balance, dailyLoss, dailyDDPct, maxDDPct, riskPct }
   * @returns {{ compliant, checks, blockedReason }}
   */
  function checkPropCompliance(signal, account) {
    account = account || {};
    var balance    = account.balance    || 100000;
    var dailyLoss  = Math.abs(account.dailyLoss || 0);
    var dailyDDPct = account.dailyDDPct  || 0.05;
    var maxDDPct   = account.maxDDPct    || 0.10;
    var riskPct    = account.riskPct     || 0.01;
    var checks     = [];
    var blocked    = null;

    // Daily loss limit
    var dailyLossPct = dailyLoss / balance;
    var ddStatus     = dailyLossPct >= dailyDDPct ? 'blocked' : (dailyLossPct >= dailyDDPct * 0.8 ? 'warning' : 'ok');
    checks.push({ id: 'daily_dd', status: ddStatus, label: 'Daily DD: ' + (dailyLossPct * 100).toFixed(2) + '% / ' + (dailyDDPct * 100).toFixed(0) + '%' });
    if (ddStatus === 'blocked') blocked = 'Daily drawdown limit reached (' + (dailyLossPct * 100).toFixed(1) + '%)';

    // Position risk
    var capitalAtRisk = balance * riskPct;
    checks.push({ id: 'position_risk', status: 'ok', label: 'Position risk: $' + capitalAtRisk.toFixed(0) + ' (' + (riskPct * 100).toFixed(1) + '%)' });

    // News block
    if (signal.reasoning_codes && signal.reasoning_codes.indexOf('NEWS_RISK_BLOCKED') !== -1) {
      checks.push({ id: 'news', status: 'blocked', label: 'High-impact news window active' });
      if (!blocked) blocked = 'High-impact news event — no new positions';
    } else {
      checks.push({ id: 'news', status: 'ok', label: 'News: clear' });
    }

    // Session / market hours
    var sess = signal.structure && signal.structure.session;
    if (sess === 'Closed') {
      checks.push({ id: 'session', status: 'blocked', label: 'Market closed (weekend)' });
      if (!blocked) blocked = 'Market is closed';
    } else {
      checks.push({ id: 'session', status: 'ok', label: 'Session: ' + (sess || 'Unknown') });
    }

    // Confidence gate
    var confStatus = signal.confidence >= 65 ? 'ok' : (signal.confidence >= 40 ? 'warning' : 'blocked');
    checks.push({ id: 'confidence', status: confStatus, label: 'Setup confidence: ' + signal.confidence + '%' });
    if (confStatus === 'blocked' && !blocked) blocked = 'Confidence too low (' + signal.confidence + '% < 40% minimum)';

    // RR gate
    if (signal.levels && signal.levels.risk_reward < 2) {
      checks.push({ id: 'rr', status: 'warning', label: 'R:R ' + (signal.levels.risk_reward || 0).toFixed(1) + ' (target ≥2.0)' });
    } else if (signal.levels) {
      checks.push({ id: 'rr', status: 'ok', label: 'R:R ' + (signal.levels.risk_reward || 0).toFixed(1) });
    }

    return { compliant: !blocked, checks: checks, blockedReason: blocked };
  }

  // ─── AI Narrative Prompt Builder ──────────────────────────────────────────

  /**
   * Build the LLM prompt for narrative generation.
   * Send this to Claude / GPT — the engine itself is deterministic.
   *
   * @param {Object} signal       — Output of analyzeMarketStructure
   * @param {Array}  recentNews   — [{ headline, time, impact }]
   * @returns {string}            — Formatted prompt
   */
  function buildAINarrativePrompt(signal, recentNews) {
    recentNews = recentNews || [];
    var newsBlock = recentNews.length > 0
      ? recentNews.slice(0, 3).map(function (n, i) {
          return (i + 1) + '. ' + (n.headline || n.title || String(n)) + (n.time ? ' (' + n.time + ')' : '');
        }).join('\n')
      : 'No recent high-impact news events.';

    var sweepNote = '';
    if (signal.triggers && signal.triggers.sweep && signal.triggers.sweep.swept) {
      var sw = signal.triggers.sweep;
      sweepNote = '- Sweep: ' + sw.levelLabel + ' at ' + round5(sw.level) + ' was swept ' + sw.barsAgo + ' bar(s) ago. Body closed back ' + (sw.direction === 'low' ? 'above' : 'below') + ' the level.';
    }
    var mssNote = '';
    if (signal.triggers && signal.triggers.mss && signal.triggers.mss.mss) {
      var m = signal.triggers.mss;
      mssNote = '- MSS: ' + m.type + ' confirmed ' + m.direction + ' at ' + round5(m.level) + '.';
    }

    return 'You are a Senior Proprietary Trading Coach with 15+ years in SMC/ICT methodology.\n\n' +
      'A student has submitted this algorithmic trade analysis from PropPilot AI. ' +
      'Explain it in plain English as if briefing them before a live session. ' +
      'Be specific — reference actual price levels, the session context, and any timing constraints. ' +
      'Keep it under 100 words. Do not use bullet points. Write as flowing prose.\n\n' +
      '## Signal Data\n' +
      '- Symbol:       ' + (signal.meta && signal.meta.symbol || 'Unknown') + '\n' +
      '- Verdict:      ' + signal.verdict + '\n' +
      '- Confidence:   ' + signal.confidence + '%\n' +
      '- Session:      ' + signal.session_context + '\n' +
      '- HTF Trend:    ' + (signal.structure && signal.structure.trend_htf || 'N/A') + '\n' +
      '- Reasoning:    ' + (signal.reasoning_codes || []).join(', ') + '\n' +
      '- Entry:        ' + (signal.levels ? signal.levels.entry : 'N/A') + '\n' +
      '- Stop Loss:    ' + (signal.levels ? signal.levels.sl    : 'N/A') + '\n' +
      '- TP1:          ' + (signal.levels ? signal.levels.tp1   : 'N/A') + '\n' +
      '- TP2:          ' + (signal.levels ? signal.levels.tp2   : 'N/A') + '\n' +
      '- Invalidation: ' + signal.invalidation + '\n' +
      sweepNote + '\n' + mssNote + '\n\n' +
      '## Recent Economic News\n' + newsBlock + '\n\n' +
      'Write the coaching narrative now:';
  }

  // ─── Export to global ──────────────────────────────────────────────────────
  global.PropPilot = global.PropPilot || {};

  global.PropPilot.VERDICTS                 = VERDICTS;
  global.PropPilot.SESSIONS                 = SESSIONS;
  global.PropPilot.analyzeMarketStructure   = analyzeMarketStructure;
  global.PropPilot.detectSwings             = detectSwings;
  global.PropPilot.detectTrend              = detectTrend;
  global.PropPilot.detectFVG                = detectFVG;
  global.PropPilot.detectLiquidityZones     = detectLiquidityZones;
  global.PropPilot.detectSession            = detectSession;
  global.PropPilot.getAsiaRange             = getAsiaRange;
  global.PropPilot.detectLiquiditySweep     = detectLiquiditySweep;
  global.PropPilot.detectMSS                = detectMSS;
  global.PropPilot.detectDisplacement       = detectDisplacement;
  global.PropPilot.calcOTE                  = calcOTE;
  global.PropPilot.calcATR                  = calcATR;
  global.PropPilot.checkPropCompliance      = checkPropCompliance;
  global.PropPilot.buildAINarrativePrompt   = buildAINarrativePrompt;

})(typeof window !== 'undefined' ? window : this);
