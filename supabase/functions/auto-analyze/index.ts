// ═══════════════════════════════════════════════════════════════════════════
// PropPilot AI — auto-analyze Edge Function
// Fetches OHLCV from Yahoo Finance, runs SMC/ICT analysis, saves to smc_signals,
// generates AI narrative via Groq, persists to bot_memory.
// Triggered by pg_cron 5×/day (session opens) or manually via GET/POST.
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2';

const SB_URL     = Deno.env.get('SUPABASE_URL')!;
const SB_SKEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROQ_KEY   = Deno.env.get('GROQ_API_KEY')   || '';

const sb = createClient(SB_URL, SB_SKEY, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,apikey',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

// ── Symbols to analyze ───────────────────────────────────────────────────────
const SYMBOLS = [
<<<<<<< HEAD
  { symbol: 'XAU/USD', yf: 'GC=F',     type: 'commodity', pip: 0.01,   currencies: ['USD', 'XAU'] },
  { symbol: 'EUR/USD', yf: 'EURUSD=X', type: 'forex',     pip: 0.0001, currencies: ['EUR', 'USD'] },
  { symbol: 'GBP/USD', yf: 'GBPUSD=X', type: 'forex',     pip: 0.0001, currencies: ['GBP', 'USD'] },
  { symbol: 'USD/JPY', yf: 'USDJPY=X', type: 'forex',     pip: 0.01,   currencies: ['USD', 'JPY'] },
  { symbol: 'NAS100',  yf: '^NDX',     type: 'index',     pip: 1.0,    currencies: ['USD'] },
  { symbol: 'BTC/USD', yf: 'BTC-USD',  type: 'crypto',    pip: 1.0,    currencies: [] }, // crypto ignores forex news
=======
  { symbol: 'XAU/USD', yf: 'GC=F',     type: 'commodity', pip: 0.01  },
  { symbol: 'EUR/USD', yf: 'EURUSD=X', type: 'forex',     pip: 0.0001 },
  { symbol: 'GBP/USD', yf: 'GBPUSD=X', type: 'forex',     pip: 0.0001 },
  { symbol: 'USD/JPY', yf: 'USDJPY=X', type: 'forex',     pip: 0.01  },
  { symbol: 'NAS100',  yf: '^NDX',     type: 'index',     pip: 1.0   },
  { symbol: 'BTC/USD', yf: 'BTC-USD',  type: 'crypto',    pip: 1.0   },
>>>>>>> f7cbe8bfd1ca4fad161eb5ac89b7a3d1431f50e0
];

// ── News: fetch upcoming events from calendar function ───────────────────────
interface NewsEvent {
  currency:     string;
  impact:       string;
  minutes_until: number | null;
  title:        string;
  is_imminent:  boolean;
  is_upcoming:  boolean;
}

async function fetchUpcomingNews(windowMin = 60): Promise<NewsEvent[]> {
  try {
    const url = `${SB_URL}/functions/v1/calendar?window=${windowMin}`;
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'x-proppilot-cron-secret': Deno.env.get('PROPILOT_CRON_SECRET') || '',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.events || []) as NewsEvent[];
  } catch {
    return [];
  }
}

function getNewsRiskForSymbol(
  symbol: string,
  currencies: string[],
  newsEvents: NewsEvent[]
): { hasHighNews: boolean; hasMedNews: boolean; isImminent: boolean; minutesUntil: number | null; newsTitle: string } {
  if (!currencies.length) return { hasHighNews: false, hasMedNews: false, isImminent: false, minutesUntil: null, newsTitle: '' };

  const relevant = newsEvents.filter(e =>
    currencies.includes(e.currency.toUpperCase())
  );

  const highEvents  = relevant.filter(e => e.impact === 'High');
  const medEvents   = relevant.filter(e => e.impact === 'Medium');
  const imminentHigh = highEvents.filter(e => e.is_imminent);
  const upcomingHigh = highEvents.filter(e => e.is_upcoming);

  const hasHighNews = highEvents.length > 0;
  const hasMedNews  = medEvents.length > 0;
  const isImminent  = imminentHigh.length > 0;

  const nearest = [...highEvents, ...medEvents].sort((a, b) =>
    (a.minutes_until ?? 9999) - (b.minutes_until ?? 9999)
  )[0];

  return {
    hasHighNews,
    hasMedNews,
    isImminent,
    minutesUntil: nearest?.minutes_until ?? null,
    newsTitle: nearest?.title || '',
  };
}

// ── Types ────────────────────────────────────────────────────────────────────
type Candle = { time: number; open: number; high: number; low: number; close: number; volume?: number };

interface SignalResult {
  symbol:         string;
  verdict:        'LONG_NOW' | 'SHORT_NOW' | 'WAIT_LONG' | 'WAIT_SHORT' | 'NO_TRADE' | 'AVOID_NEWS';
  confidence:     number;
  direction:      'LONG' | 'SHORT' | null;
  entry_price:    number | null;
  sl_price:       number | null;
  tp1_price:      number | null;
  tp2_price:      number | null;
  risk_reward:    number | null;
  atr:            number | null;
  session_name:   string;
  htf_trend:      'BULLISH' | 'BEARISH' | 'NEUTRAL';
  sweep_occurred: boolean;
  mss_occurred:   boolean;
  displacement:   boolean;
  reasoning_codes: string[];
  signal_json:    Record<string, unknown>;
  ai_narrative:   string;
  invalidation:   string;
  data_status:    'live' | 'demo' | 'error';
  has_high_news:  boolean;
  has_med_news:   boolean;
  news_minutes:   number | null;
  news_title:     string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function authorizeAction(req: Request): Promise<Response | null> {
  const cronSecret = Deno.env.get('PROPILOT_CRON_SECRET') || Deno.env.get('APP_CRON_SECRET') || '';
  if (cronSecret && req.headers.get('x-proppilot-cron-secret') === cronSecret) return null;

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'Unauthorized' }, 401);
  if (token === SB_SKEY) return null;

  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return json({ error: 'Unauthorized' }, 401);
  return null;
}

function detectSession(): string {
  const h = new Date().getUTCHours();
  if (h < 7)          return 'Asia';
  if (h === 7)        return 'Frankfurt';
  if (h >= 8  && h < 12) return 'London';
  if (h >= 12 && h < 17) return 'Overlap';
  if (h >= 17 && h < 21) return 'NewYork';
  return 'Dead';
}

const YF_INTERVAL: Record<string, { interval: string; range: string }> = {
  '15min': { interval: '15m', range: '5d' },
  '1h':    { interval: '1h',  range: '30d' },
};

// ── Fetch OHLCV from Yahoo Finance ──────────────────────────────────────────
async function fetchCandles(yfSymbol: string, interval = '15min', outputsize = 200): Promise<Candle[]> {
  const iv = YF_INTERVAL[interval] || YF_INTERVAL['15min'];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSymbol)}?interval=${iv.interval}&range=${iv.range}&includePrePost=false`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`);

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No candles for ${yfSymbol}`);

  const timestamps: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const opens: number[] = quote.open || [];
  const highs: number[] = quote.high || [];
  const lows: number[] = quote.low || [];
  const closes: number[] = quote.close || [];
  const volumes: number[] = quote.volume || [];

  const candles = timestamps
    .map((ts, i) => ({
      time: ts * 1000,
      open: Number(opens[i]),
      high: Number(highs[i]),
      low: Number(lows[i]),
      close: Number(closes[i]),
      volume: volumes[i] != null ? Number(volumes[i]) : undefined,
    }))
    .filter(c => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close))
    .slice(-outputsize)
    .sort((a, b) => a.time - b.time);

  if (candles.length < 20) throw new Error(`Insufficient candles for ${yfSymbol}`);
  return candles;
}

// ── ATR calculation ──────────────────────────────────────────────────────────
function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  return trs.slice(-period).reduce((s, x) => s + x, 0) / period;
}

// ── EMA ──────────────────────────────────────────────────────────────────────
function calcEMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

// ── RSI ──────────────────────────────────────────────────────────────────────
function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = losses === 0 ? 100 : gains / losses;
  return 100 - 100 / (1 + rs);
}

// ── Swing High/Low detection ─────────────────────────────────────────────────
function swingHighs(candles: Candle[], lookback = 5): number[] {
  const highs: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i].high;
    const isHigh = candles.slice(i - lookback, i).every(c => c.high < h) &&
                   candles.slice(i + 1, i + lookback + 1).every(c => c.high < h);
    if (isHigh) highs.push(h);
  }
  return highs;
}

function swingLows(candles: Candle[], lookback = 5): number[] {
  const lows: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const l = candles[i].low;
    const isLow = candles.slice(i - lookback, i).every(c => c.low > l) &&
                  candles.slice(i + 1, i + lookback + 1).every(c => c.low > l);
    if (isLow) lows.push(l);
  }
  return lows;
}

// ── Liquidity sweep detection ────────────────────────────────────────────────
function detectSweep(candles: Candle[], highs: number[], lows: number[], atr: number): {
  bullSweep: boolean; bearSweep: boolean; lastSweptHigh: number | null; lastSweptLow: number | null;
} {
  const last5 = candles.slice(-5);
  const threshold = atr * 0.3;
  let bullSweep = false, bearSweep = false;
  let lastSweptHigh: number | null = null, lastSweptLow: number | null = null;

  for (const candle of last5) {
    for (const h of highs.slice(-8)) {
      if (candle.high > h && candle.close < h + threshold) {
        bearSweep = true; lastSweptHigh = h;
      }
    }
    for (const l of lows.slice(-8)) {
      if (candle.low < l && candle.close > l - threshold) {
        bullSweep = true; lastSweptLow = l;
      }
    }
  }
  return { bullSweep, bearSweep, lastSweptHigh, lastSweptLow };
}

// ── Market Structure Shift ───────────────────────────────────────────────────
function detectMSS(candles: Candle[], direction: 'BULL' | 'BEAR', lastSwing: number | null): boolean {
  if (!lastSwing || candles.length < 10) return false;
  const last3 = candles.slice(-3);
  if (direction === 'BULL') {
    // Bullish MSS: price breaks above last swing high after sweeping a low
    return last3.some(c => c.close > lastSwing);
  } else {
    // Bearish MSS: price breaks below last swing low after sweeping a high
    return last3.some(c => c.close < lastSwing);
  }
}

// ── OTE (Optimal Trade Entry) zone — 61.8-79% Fibonacci retracement ─────────
function calcOTE(swingStart: number, swingEnd: number, direction: 'BULL' | 'BEAR'): { lo: number; hi: number } {
  const range = Math.abs(swingEnd - swingStart);
  if (direction === 'BULL') {
    return { lo: swingEnd - range * 0.79, hi: swingEnd - range * 0.618 };
  } else {
    return { lo: swingEnd + range * 0.618, hi: swingEnd + range * 0.79 };
  }
}

// ── Core SMC Analysis ────────────────────────────────────────────────────────
function analyzeSMC(
  symbol: string,
  candles15m: Candle[],
  candles1h: Candle[],
  pip: number,
  session: string,
): Omit<SignalResult, 'ai_narrative'> {

  const closes15m = candles15m.map(c => c.close);
  const closes1h  = candles1h.map(c => c.close);
  const last = candles15m[candles15m.length - 1];
  const price = last.close;
  const atr = calcATR(candles15m);

  // Indicators
  const ema20  = calcEMA(closes15m, 20);
  const ema50  = calcEMA(closes15m, 50);
  const ema200 = calcEMA(closes15m, 200);
  const ema50h = calcEMA(closes1h, 50);
  const rsi    = calcRSI(closes15m);

  // HTF trend from 1h
  const htfTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
    closes1h[closes1h.length - 1] > ema50h * 1.001 ? 'BULLISH' :
    closes1h[closes1h.length - 1] < ema50h * 0.999 ? 'BEARISH' : 'NEUTRAL';

  // Swing levels
  const sh15 = swingHighs(candles15m, 5);
  const sl15 = swingLows(candles15m, 5);
  const sh1h = swingHighs(candles1h, 5);
  const sl1h = swingLows(candles1h, 5);

  // Sweep detection on 15m
  const sweep = detectSweep(candles15m, sh15, sl15, atr);
  const sweep1h = detectSweep(candles1h, sh1h, sl1h, atr);
  const sweepOccurred = sweep.bullSweep || sweep.bearSweep || sweep1h.bullSweep || sweep1h.bearSweep;

  // MSS detection
  const mssBull = detectMSS(candles15m, 'BULL', sweep.lastSweptLow);
  const mssBear = detectMSS(candles15m, 'BEAR', sweep.lastSweptHigh);
  const mssOccurred = mssBull || mssBear;

  // Displacement candle check (strong momentum candle)
  const last3 = candles15m.slice(-3);
  const displacement = last3.some(c => Math.abs(c.close - c.open) > atr * 0.8);

  // Scoring
  const reasons: string[] = [];
  let bullScore = 0, bearScore = 0;

  // HTF alignment
  if (htfTrend === 'BULLISH') { bullScore += 25; reasons.push('HTF_BULL'); }
  if (htfTrend === 'BEARISH') { bearScore += 25; reasons.push('HTF_BEAR'); }

  // EMA structure
  if (ema20 > ema50 && ema50 > ema200) { bullScore += 15; reasons.push('EMA_BULL_STACK'); }
  if (ema20 < ema50 && ema50 < ema200) { bearScore += 15; reasons.push('EMA_BEAR_STACK'); }
  if (price > ema200) { bullScore += 10; reasons.push('PRICE_ABOVE_EMA200'); }
  if (price < ema200) { bearScore += 10; reasons.push('PRICE_BELOW_EMA200'); }

  // Sweep + MSS (core SMC setup)
  if (sweep.bullSweep && mssBull) { bullScore += 30; reasons.push('BULL_SWEEP_MSS'); }
  if (sweep.bearSweep && mssBear) { bearScore += 30; reasons.push('BEAR_SWEEP_MSS'); }
  if (sweep1h.bullSweep) { bullScore += 10; reasons.push('HTF_BULL_SWEEP'); }
  if (sweep1h.bearSweep) { bearScore += 10; reasons.push('HTF_BEAR_SWEEP'); }

  // RSI
  if (rsi < 35 && htfTrend === 'BULLISH') { bullScore += 10; reasons.push('RSI_OVERSOLD_BULL'); }
  if (rsi > 65 && htfTrend === 'BEARISH') { bearScore += 10; reasons.push('RSI_OVERBOUGHT_BEAR'); }
  if (rsi > 60) { bullScore += 5;  reasons.push('RSI_BULLISH'); }
  if (rsi < 40) { bearScore += 5;  reasons.push('RSI_BEARISH'); }

  // Displacement
  if (displacement && mssBull) { bullScore += 10; reasons.push('DISPLACEMENT_BULL'); }
  if (displacement && mssBear) { bearScore += 10; reasons.push('DISPLACEMENT_BEAR'); }

  // Session bonus (best sessions for clean setups)
  if (['London', 'Overlap', 'NewYork'].includes(session)) {
    bullScore += 5; bearScore += 5; reasons.push(`SESSION_${session.toUpperCase()}`);
  }

  const netScore = bullScore - bearScore;
  const totalScore = Math.max(bullScore, bearScore);
  const confidence = Math.min(95, Math.round(totalScore * 0.9));

  // Verdict
  let verdict: SignalResult['verdict'] = 'NO_TRADE';
  let direction: 'LONG' | 'SHORT' | null = null;

  if (bullScore >= 60 && netScore >= 15) {
    verdict = (bullScore >= 75 && mssOccurred) ? 'LONG_NOW' : 'WAIT_LONG';
    direction = 'LONG';
  } else if (bearScore >= 60 && netScore <= -15) {
    verdict = (bearScore >= 75 && mssOccurred) ? 'SHORT_NOW' : 'WAIT_SHORT';
    direction = 'SHORT';
  }

  // Trade levels
  let entryPrice: number | null = null;
  let slPrice: number | null = null;
  let tp1Price: number | null = null;
  let tp2Price: number | null = null;
  let riskReward: number | null = null;

  if (direction && atr > 0) {
    if (direction === 'LONG' && sweep.lastSweptLow) {
      const ote = calcOTE(sweep.lastSweptLow, price, 'BULL');
      entryPrice = ote.hi;
      slPrice    = sweep.lastSweptLow - atr * 0.3;
      const risk = entryPrice - slPrice;
      tp1Price   = entryPrice + risk * 2.2;
      tp2Price   = entryPrice + risk * 3.6;
      riskReward = risk > 0 ? parseFloat((risk * 2.2 / risk).toFixed(2)) : null;
    } else if (direction === 'SHORT' && sweep.lastSweptHigh) {
      const ote = calcOTE(price, sweep.lastSweptHigh, 'BEAR');
      entryPrice = ote.lo;
      slPrice    = sweep.lastSweptHigh + atr * 0.3;
      const risk = slPrice - entryPrice;
      tp1Price   = entryPrice - risk * 2.2;
      tp2Price   = entryPrice - risk * 3.6;
      riskReward = risk > 0 ? parseFloat((risk * 2.2 / risk).toFixed(2)) : null;
    } else {
      // Fallback levels if no sweep point found
      entryPrice = price;
      slPrice    = direction === 'LONG' ? price - atr * 1.4 : price + atr * 1.4;
      const risk = Math.abs(entryPrice - slPrice);
      tp1Price   = direction === 'LONG' ? price + risk * 2.2 : price - risk * 2.2;
      tp2Price   = direction === 'LONG' ? price + risk * 3.6 : price - risk * 3.6;
      riskReward = 2.2;
    }
  }

  const invalidation = direction === 'LONG'
    ? `Invalidated if price closes below ${slPrice?.toFixed(4) || 'SL'}`
    : direction === 'SHORT'
    ? `Invalidated if price closes above ${slPrice?.toFixed(4) || 'SL'}`
    : 'No active setup';

  return {
    symbol,
    verdict,
    confidence,
    direction,
    entry_price: entryPrice ? parseFloat(entryPrice.toFixed(5)) : null,
    sl_price:    slPrice    ? parseFloat(slPrice.toFixed(5))    : null,
    tp1_price:   tp1Price   ? parseFloat(tp1Price.toFixed(5))   : null,
    tp2_price:   tp2Price   ? parseFloat(tp2Price.toFixed(5))   : null,
    risk_reward: riskReward,
    atr:         parseFloat(atr.toFixed(6)),
    session_name: session,
    htf_trend:   htfTrend,
    sweep_occurred: sweepOccurred,
    mss_occurred:   mssOccurred,
    displacement,
    reasoning_codes: reasons,
    invalidation,
    data_status: 'live',
    signal_json: {
      price, ema20, ema50, ema200, rsi,
      bullScore, bearScore, netScore,
      atr, session,
    },
  };
}

// ── Groq AI narrative ────────────────────────────────────────────────────────
async function generateNarrative(sig: Omit<SignalResult, 'ai_narrative'>, sessionSignals: Omit<SignalResult, 'ai_narrative'>[]): Promise<string> {
  if (!GROQ_KEY) return '';

  const actionable = sessionSignals.filter(s => s.verdict === 'LONG_NOW' || s.verdict === 'SHORT_NOW');

  const prompt = `You are a professional prop trader AI. Analyze these signals and provide a brief market read (max 150 words):

Session: ${sig.session_name} | Time: ${new Date().toUTCString()}
Actionable signals this cycle: ${actionable.length}/${sessionSignals.length}

${sig.symbol}: ${sig.verdict} | ${sig.direction || 'NEUTRAL'} | ${sig.confidence}% confidence
HTF: ${sig.htf_trend} | Sweep: ${sig.sweep_occurred} | MSS: ${sig.mss_occurred}
${sig.entry_price ? `Entry: ${sig.entry_price} | SL: ${sig.sl_price} | TP1: ${sig.tp1_price} | TP2: ${sig.tp2_price}` : 'No trade levels'}
Reasons: ${sig.reasoning_codes.join(', ')}

All signals summary:
${sessionSignals.map(s => `${s.symbol}: ${s.verdict} (${s.confidence}%)`).join('\n')}

Write 2-3 sentences: market context, what the structure shows, and key risk. Be direct and specific.`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  } catch {
    return '';
  }
}

// ── Generate session summary for bot_memory ──────────────────────────────────
async function generateSessionSummary(signals: Omit<SignalResult, 'ai_narrative'>[]): Promise<string> {
  if (!GROQ_KEY || !signals.length) return '';

  const actionable = signals.filter(s => s.verdict === 'LONG_NOW' || s.verdict === 'SHORT_NOW');

  const prompt = `You are a professional prop trading AI. Summarize this ${signals[0].session_name} session analysis (max 200 words):

Signals analyzed: ${signals.length}
Actionable (LONG_NOW/SHORT_NOW): ${actionable.length}

${signals.map(s => `${s.symbol}: ${s.verdict} | ${s.confidence}% | HTF:${s.htf_trend} | Sweep:${s.sweep_occurred} | MSS:${s.mss_occurred}`).join('\n')}

Provide:
1. Overall market bias for this session
2. Best opportunities (if any)
3. Key risks/what to watch
4. One lesson for the next cycle

Be specific, max 150 words.`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 250,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  } catch {
    return '';
  }
}

function paperPayloadFromSignal(sig: SignalResult, session: string, demoTest: boolean): Record<string, unknown> | null {
  if (!sig.direction) return null;

  const price = Number((sig.signal_json as { price?: unknown })?.price);
  const atr = Number(sig.atr || (sig.signal_json as { atr?: unknown })?.atr);
  let entry = sig.entry_price;
  let sl = sig.sl_price;
  let tp1 = sig.tp1_price;
  let tp2 = sig.tp2_price;

  if ((!entry || !sl || !tp1 || !tp2) && demoTest && Number.isFinite(price) && Number.isFinite(atr) && atr > 0) {
    entry = price;
    const risk = atr * 1.4;
    if (sig.direction === 'LONG') {
      sl = price - risk;
      tp1 = price + risk * 2.2;
      tp2 = price + risk * 3.6;
    } else {
      sl = price + risk;
      tp1 = price - risk * 2.2;
      tp2 = price - risk * 3.6;
    }
  }

  if (!entry || !sl || !tp1 || !tp2) return null;

  return {
    symbol: sig.symbol,
    direction: sig.direction,
    entry_price: Number(entry),
    sl_price: Number(sl),
    tp1_price: Number(tp1),
    tp2_price: Number(tp2),
    confidence: demoTest ? Math.max(sig.confidence, 70) : sig.confidence,
    session_type: session,
    atr: sig.atr,
    notes: demoTest
      ? `DEMO_TEST paper trade from ${sig.verdict}. Real market data, synthetic paper fill.`
      : `AUTO_PAPER_TRADE from ${sig.verdict}`,
  };
}

async function openPaperTradeFromSignal(sig: SignalResult, session: string, demoTest: boolean): Promise<Record<string, unknown>> {
  const payload = paperPayloadFromSignal(sig, session, demoTest);
  if (!payload) {
    return { success: false, symbol: sig.symbol, error: 'Signal has no executable trade levels' };
  }

  try {
    const res = await fetch(`${SB_URL}/functions/v1/execute-paper-trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SB_SKEY}` },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    return { ...json, success: res.ok && json.success !== false, httpStatus: res.status, symbol: sig.symbol };
  } catch (err) {
    return { success: false, symbol: sig.symbol, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const authError = await authorizeAction(req);
  if (authError) return authError;

  const started = Date.now();
  const session = detectSession();
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const symbolFilter: string | null = body.symbol || new URL(req.url).searchParams.get('symbol') || null;
  const dryRun = body.dryRun === true || new URL(req.url).searchParams.get('dryRun') === 'true';
  const autoTrade = body.autoTrade === true || new URL(req.url).searchParams.get('autoTrade') === 'true';
  const demoTest = body.demoTest === true || new URL(req.url).searchParams.get('demoTest') === 'true';

  const toAnalyze = symbolFilter
    ? SYMBOLS.filter(s => s.symbol === symbolFilter || s.yf === symbolFilter)
    : SYMBOLS;

  const results: SignalResult[] = [];
  const errors: { symbol: string; error: string }[] = [];

<<<<<<< HEAD
  // ── Fetch upcoming news events once for all symbols ──────────────────────
  const newsEvents = await fetchUpcomingNews(60);
  console.log(`[auto-analyze] fetched ${newsEvents.length} upcoming news events`);

=======
>>>>>>> f7cbe8bfd1ca4fad161eb5ac89b7a3d1431f50e0
  for (const sym of toAnalyze) {
    try {
      // ── Check news risk BEFORE fetching candles ─────────────────────────
      const newsRisk = getNewsRiskForSymbol(sym.symbol, sym.currencies, newsEvents);

      // HIGH impact news imminent (< 15 min) → AVOID_NEWS immediately
      if (newsRisk.isImminent && newsRisk.hasHighNews) {
        console.log(`[auto-analyze] ${sym.symbol}: AVOID_NEWS — ${newsRisk.newsTitle} in ${newsRisk.minutesUntil}min`);
        results.push({
          symbol:          sym.symbol,
          verdict:         'AVOID_NEWS',
          confidence:      0,
          direction:       null,
          entry_price:     null,
          sl_price:        null,
          tp1_price:       null,
          tp2_price:       null,
          risk_reward:     null,
          atr:             null,
          session_name:    session,
          htf_trend:       'NEUTRAL',
          sweep_occurred:  false,
          mss_occurred:    false,
          displacement:    false,
          reasoning_codes: ['AVOID_NEWS', 'HIGH_IMPACT_IMMINENT'],
          signal_json:     { news_title: newsRisk.newsTitle, minutes: newsRisk.minutesUntil },
          ai_narrative:    `⚠️ High-impact news imminent: ${newsRisk.newsTitle}. Avoid trading ${sym.symbol} for the next 30 minutes.`,
          invalidation:    `News event: ${newsRisk.newsTitle}`,
          data_status:     'live',
          has_high_news:   true,
          has_med_news:    false,
          news_minutes:    newsRisk.minutesUntil,
          news_title:      newsRisk.newsTitle,
        });
        continue;
      }

      const [candles15m, candles1h] = await Promise.all([
        fetchCandles(sym.yf, '15min', 200),
        fetchCandles(sym.yf, '1h', 100),
      ]);

      let sig = analyzeSMC(sym.symbol, candles15m, candles1h, sym.pip, session);

      // ── Apply news penalty to confidence ────────────────────────────────
      if (newsRisk.hasHighNews) {
        sig = {
          ...sig,
          confidence: Math.max(0, sig.confidence - 25),
          reasoning_codes: [...sig.reasoning_codes, 'NEWS_RISK_HIGH'],
        };
        // Downgrade LONG_NOW/SHORT_NOW to WAIT if confidence drops below threshold
        if (sig.confidence < 60 && (sig.verdict === 'LONG_NOW' || sig.verdict === 'SHORT_NOW')) {
          sig = { ...sig, verdict: 'WAIT_LONG' in sig.verdict ? 'WAIT_LONG' : 'WAIT_SHORT' };
        }
      } else if (newsRisk.hasMedNews) {
        sig = {
          ...sig,
          confidence: Math.max(0, sig.confidence - 10),
          reasoning_codes: [...sig.reasoning_codes, 'NEWS_RISK_MED'],
        };
      }

      const narrative = await generateNarrative(sig, results.map(r => ({ ...r })));

<<<<<<< HEAD
      results.push({
        ...sig,
        ai_narrative:  narrative,
        has_high_news: newsRisk.hasHighNews,
        has_med_news:  newsRisk.hasMedNews,
        news_minutes:  newsRisk.minutesUntil,
        news_title:    newsRisk.newsTitle,
      });
=======
      results.push({ ...sig, ai_narrative: narrative });
>>>>>>> f7cbe8bfd1ca4fad161eb5ac89b7a3d1431f50e0

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[auto-analyze] ${sym.symbol}:`, message);
      errors.push({ symbol: sym.symbol, error: message });

      // Still create a NO_TRADE signal so we have a record
      results.push({
        symbol: sym.symbol,
        verdict: 'NO_TRADE',
        confidence: 0,
        direction: null,
        entry_price: null, sl_price: null, tp1_price: null, tp2_price: null,
        risk_reward: null, atr: null,
        session_name: session,
        htf_trend: 'NEUTRAL',
        sweep_occurred: false, mss_occurred: false, displacement: false,
        reasoning_codes: ['DATA_ERROR'],
        signal_json: { error: message },
        ai_narrative: '',
        invalidation: 'Data unavailable',
        data_status: 'error',
        has_high_news: false,
        has_med_news:  false,
        news_minutes:  null,
        news_title:    '',
      });
    }
  }

  const actionableSignals = results.filter(r => r.verdict === 'LONG_NOW' || r.verdict === 'SHORT_NOW');
  const tradeResults: Record<string, unknown>[] = [];

  // ── Persist to smc_signals ────────────────────────────────────────────────
  if (!dryRun && results.length > 0) {
    const rows = results.map(sig => ({
      symbol:          sig.symbol,
      timeframe:       'm15',
      verdict:         sig.verdict,
      confidence:      sig.confidence,
      // direction is not a column in smc_signals — derived from verdict
      entry_price:     sig.entry_price,
      sl_price:        sig.sl_price,
      tp1_price:       sig.tp1_price,
      tp2_price:       sig.tp2_price,
      risk_reward:     sig.risk_reward,
      atr:             sig.atr,
      session_name:    sig.session_name,
      htf_trend:       sig.htf_trend?.toLowerCase().replace('neutral','ranging') as 'bullish'|'bearish'|'ranging'|null,
      sweep_occurred:  sig.sweep_occurred,
      mss_occurred:    sig.mss_occurred,
      displacement:    sig.displacement,
      reasoning_codes: sig.reasoning_codes,
      signal_json:     sig.signal_json,
      ai_narrative:    sig.ai_narrative,
      invalidation:    sig.invalidation,
      data_status:     sig.data_status,
      outcome:         null,
    }));

    const { error: insertErr } = await sb.from('smc_signals').insert(rows);
    if (insertErr) {
      console.error('[auto-analyze] insert error:', insertErr.message);
    }

    // ── Persist session summary to bot_memory ─────────────────────────────
    const summary = await generateSessionSummary(results.map(r => ({ ...r })));

    await sb.from('bot_memory').insert({
      session_type:      session,
      signals_found:     results.map(r => ({
        symbol: r.symbol, verdict: r.verdict, confidence: r.confidence,
        entry: r.entry_price, sl: r.sl_price, tp1: r.tp1_price,
      })),
      trades_placed:     [],
      market_notes:      summary,
      lessons_learned:   '',
      next_watch_levels: Object.fromEntries(
        actionableSignals.map(s => [s.symbol, { entry: s.entry_price, sl: s.sl_price, tp1: s.tp1_price }])
      ),
      signals_saved:     results.length,
      duration_ms:       Date.now() - started,
    });
  }

  if (!dryRun && autoTrade) {
    let tradeCandidates = actionableSignals.filter(sig => paperPayloadFromSignal(sig, session, false));

    if (tradeCandidates.length === 0 && demoTest) {
      tradeCandidates = results
        .filter(sig => sig.direction && sig.confidence >= 50)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 1);
    }

    for (const sig of tradeCandidates.slice(0, 1)) {
      tradeResults.push(await openPaperTradeFromSignal(sig, session, demoTest && actionableSignals.length === 0));
    }
  }

  // ── Telegram push for actionable signals (fire-and-forget) ───────────────
  if (!dryRun && actionableSignals.length > 0) {
    const tgUrl = `${SB_URL}/functions/v1/telegram-bot`;
    const tgKey = SB_SKEY;
    Promise.all(
      actionableSignals.slice(0, 3).map(sig =>
        fetch(tgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tgKey}` },
          body: JSON.stringify({
            mode: 'signal',
            signal: {
              symbol:       sig.symbol,
              signal_state: sig.verdict,
              direction:    sig.direction,
              confidence:   sig.confidence,
              price:        sig.entry_price,
              tp1:          sig.tp1_price,
              tp2:          sig.tp2_price,
              sl:           sig.sl_price,
              timeframe:    '15m',
              session_name: session,
            },
          }),
        }).catch(e => console.warn('[telegram-push] failed:', e.message))
      )
    );
  }

  return json({
    ok:         true,
    dryRun,
    session,
    analyzed:   results.length,
    actionable: results.filter(r => r.verdict === 'LONG_NOW' || r.verdict === 'SHORT_NOW').length,
    autoTrade,
    demoTest,
    tradesOpened: tradeResults.filter(r => r.success).length,
    tradeResults,
    durationMs: Date.now() - started,
    errors:     errors.length,
    signals:    results.map(r => ({
      symbol:     r.symbol,
      verdict:    r.verdict,
      confidence: r.confidence,
      direction:  r.direction,
      entry:      r.entry_price,
      sl:         r.sl_price,
      htf_trend:  r.htf_trend,
      sweep:      r.sweep_occurred,
      mss:        r.mss_occurred,
    })),
  });
});
