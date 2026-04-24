import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWELVE_DATA_KEY = Deno.env.get('TWELVE_DATA_KEY') || '';

const sb = createClient(SB_URL, SB_SERVICE_KEY, {
  auth: { persistSession: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,apikey',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

type SignalRow = {
  id: number;
  created_at: string;
  symbol: string;
  timeframe: string | null;
  signal_state: string;
  direction: 'LONG' | 'SHORT' | null;
  confidence: number | string | null;
  price: number | string | null;
  entry_lo: number | string | null;
  entry_hi: number | string | null;
  sl: number | string | null;
  tp1: number | string | null;
  tp2: number | string | null;
  rr_tp1: number | string | null;
  rr_tp2: number | string | null;
  outcome: string;
  check_count: number | null;
};

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type OutcomeResult = {
  outcome: 'TP1_HIT' | 'TP2_HIT' | 'SL_HIT' | 'EXPIRED';
  price: number | null;
  pnlR: number | null;
  at: string;
  mfeR: number | null;
  maeR: number | null;
};

const TD_SYMBOL: Record<string, string> = {
  XAUUSD: 'XAU/USD',
  'XAU/USD': 'XAU/USD',
  GOLD: 'XAU/USD',
  EURUSD: 'EUR/USD',
  'EUR/USD': 'EUR/USD',
  GBPUSD: 'GBP/USD',
  'GBP/USD': 'GBP/USD',
  USDJPY: 'USD/JPY',
  'USD/JPY': 'USD/JPY',
  GBPJPY: 'GBP/JPY',
  'GBP/JPY': 'GBP/JPY',
  BTCUSDT: 'BTC/USD',
  BTCUSD: 'BTC/USD',
  'BTC/USD': 'BTC/USD',
  ETHUSDT: 'ETH/USD',
  ETHUSD: 'ETH/USD',
  'ETH/USD': 'ETH/USD',
  NAS100: 'QQQ',
  US100: 'QQQ',
  NDX: 'QQQ',
  QQQ: 'QQQ',
  SPY: 'SPY',
  AAPL: 'AAPL',
  NVDA: 'NVDA',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function n(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferDirection(signal: SignalRow): 'LONG' | 'SHORT' | null {
  if (signal.direction === 'LONG' || signal.direction === 'SHORT') return signal.direction;
  if (signal.signal_state === 'LONG_NOW' || signal.signal_state === 'WAIT_LONG') return 'LONG';
  if (signal.signal_state === 'SHORT_NOW' || signal.signal_state === 'WAIT_SHORT') return 'SHORT';
  return null;
}

function entryPrice(signal: SignalRow): number | null {
  const lo = n(signal.entry_lo);
  const hi = n(signal.entry_hi);
  if (lo !== null && hi !== null) return (lo + hi) / 2;
  return n(signal.price);
}

function needsMarketData(signal: SignalRow): boolean {
  return Boolean(
    inferDirection(signal) &&
    entryPrice(signal) !== null &&
    n(signal.sl) !== null &&
    (n(signal.tp1) !== null || n(signal.tp2) !== null)
  );
}

function tdSymbol(symbol: string): string {
  const key = symbol.toUpperCase().replace(/\s/g, '');
  return TD_SYMBOL[key] || TD_SYMBOL[symbol] || symbol;
}

function intervalForAge(hours: number): string {
  if (hours <= 96) return '15min';
  if (hours <= 24 * 21) return '1h';
  return '4h';
}

function outputSizeFor(hours: number, interval: string): number {
  const candlesPerHour = interval === '15min' ? 4 : interval === '1h' ? 1 : 0.25;
  return Math.min(5000, Math.max(80, Math.ceil(hours * candlesPerHour) + 24));
}

async function fetchCandles(symbol: string, hours: number): Promise<Candle[]> {
  if (!TWELVE_DATA_KEY) {
    throw new Error('TWELVE_DATA_KEY is not configured');
  }

  const interval = intervalForAge(hours);
  const outputsize = outputSizeFor(hours, interval);
  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', tdSymbol(symbol));
  url.searchParams.set('interval', interval);
  url.searchParams.set('outputsize', String(outputsize));
  url.searchParams.set('apikey', TWELVE_DATA_KEY);
  url.searchParams.set('format', 'JSON');

  const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
  const data = await res.json();
  if (!res.ok || data.status === 'error') {
    throw new Error(data.message || `Twelve Data error for ${symbol}`);
  }
  if (!Array.isArray(data.values)) {
    throw new Error(`No candles returned for ${symbol}`);
  }

  return data.values
    .map((v: Record<string, string>) => ({
      time: Date.parse(`${v.datetime}Z`),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
    }))
    .filter((c: Candle) =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .sort((a: Candle, b: Candle) => a.time - b.time);
}

function pnlR(direction: 'LONG' | 'SHORT', entry: number, sl: number, price: number): number | null {
  const risk = Math.abs(entry - sl);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const signedMove = direction === 'LONG' ? price - entry : entry - price;
  return Number((signedMove / risk).toFixed(3));
}

function scanOutcome(signal: SignalRow, candles: Candle[], maxAgeHours: number): OutcomeResult | null {
  const direction = inferDirection(signal);
  const entry = entryPrice(signal);
  const sl = n(signal.sl);
  const tp1 = n(signal.tp1);
  const tp2 = n(signal.tp2);
  const createdMs = Date.parse(signal.created_at);
  const nowMs = Date.now();
  const ageHours = (nowMs - createdMs) / 36e5;

  if (!direction || entry === null || sl === null || (tp1 === null && tp2 === null)) {
    if (ageHours >= maxAgeHours) {
      return {
        outcome: 'EXPIRED',
        price: entry,
        pnlR: null,
        at: new Date().toISOString(),
        mfeR: null,
        maeR: null,
      };
    }
    return null;
  }

  let maxFav = 0;
  let maxAdv = 0;
  let lastClose = entry;

  for (const candle of candles.filter((c) => c.time >= createdMs)) {
    lastClose = candle.close;
    const favPrice = direction === 'LONG' ? candle.high : candle.low;
    const advPrice = direction === 'LONG' ? candle.low : candle.high;
    const favR = pnlR(direction, entry, sl, favPrice) ?? 0;
    const advR = pnlR(direction, entry, sl, advPrice) ?? 0;
    maxFav = Math.max(maxFav, favR);
    maxAdv = Math.min(maxAdv, advR);

    const slHit = direction === 'LONG' ? candle.low <= sl : candle.high >= sl;
    const tp2Hit = tp2 !== null && (direction === 'LONG' ? candle.high >= tp2 : candle.low <= tp2);
    const tp1Hit = tp1 !== null && (direction === 'LONG' ? candle.high >= tp1 : candle.low <= tp1);

    let outcome: OutcomeResult['outcome'] | null = null;
    let price: number | null = null;

    if (slHit && (tp1Hit || tp2Hit)) {
      outcome = 'SL_HIT';
      price = sl;
    } else if (tp2Hit) {
      outcome = 'TP2_HIT';
      price = tp2;
    } else if (tp1Hit) {
      outcome = 'TP1_HIT';
      price = tp1;
    } else if (slHit) {
      outcome = 'SL_HIT';
      price = sl;
    }

    if (outcome && price !== null) {
      return {
        outcome,
        price,
        pnlR: pnlR(direction, entry, sl, price),
        at: new Date(candle.time).toISOString(),
        mfeR: Number(maxFav.toFixed(3)),
        maeR: Number(maxAdv.toFixed(3)),
      };
    }
  }

  if (ageHours >= maxAgeHours) {
    return {
      outcome: 'EXPIRED',
      price: lastClose,
      pnlR: pnlR(direction, entry, sl, lastClose),
      at: new Date().toISOString(),
      mfeR: Number(maxFav.toFixed(3)),
      maeR: Number(maxAdv.toFixed(3)),
    };
  }

  return null;
}

async function syncSmcSignals(): Promise<number> {
  const { data, error } = await sb
    .from('smc_signals')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error || !data?.length) return 0;

  const rows = data.map((s: any) => ({
    created_at: s.created_at,
    updated_at: s.outcome_at || s.created_at,
    symbol: s.symbol,
    timeframe: s.timeframe || 'm15',
    signal_state: s.verdict,
    direction: ['LONG_NOW', 'WAIT_LONG'].includes(s.verdict)
      ? 'LONG'
      : ['SHORT_NOW', 'WAIT_SHORT'].includes(s.verdict)
        ? 'SHORT'
        : null,
    confidence: s.confidence || 0,
    price: s.entry_price,
    atr: s.atr,
    session_name: s.session_name || s.session_ctx,
    entry_lo: s.ote_zone_lo,
    entry_hi: s.ote_zone_hi,
    sl: s.sl_price,
    tp1: s.tp1_price,
    tp2: s.tp2_price,
    rr_tp1: s.risk_reward,
    rr_tp2: s.risk_reward,
    rationale: s.ai_narrative,
    invalidation: s.invalidation,
    raw_signal: s.signal_json,
    outcome: s.outcome === 'tp1_hit'
      ? 'TP1_HIT'
      : s.outcome === 'tp2_hit'
        ? 'TP2_HIT'
        : s.outcome === 'sl_hit'
          ? 'SL_HIT'
          : s.outcome === 'expired'
            ? 'EXPIRED'
            : s.outcome === 'cancelled'
              ? 'CANCELLED'
              : 'OPEN',
    outcome_price: s.outcome_price,
    pnl_r: s.outcome_pnl_r,
    outcome_at: s.outcome_at,
    outcome_source: 'smc_signals_sync',
  }));

  const { error: insertError } = await sb
    .from('signal_analyses')
    .upsert(rows, {
      onConflict: 'created_at,symbol,timeframe,signal_state',
      ignoreDuplicates: true,
    });

  if (insertError) {
    console.warn('[update-outcomes] smc sync skipped:', insertError.message);
    return 0;
  }
  return rows.length;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const started = Date.now();
  const body = req.method === 'POST'
    ? await req.json().catch(() => ({}))
    : {};
  const url = new URL(req.url);
  const limit = Math.min(500, Number(body.limit || url.searchParams.get('limit') || 250));
  const maxAgeHours = Math.max(1, Number(body.maxAgeHours || url.searchParams.get('maxAgeHours') || 120));
  const dryRun = Boolean(body.dryRun || url.searchParams.get('dryRun') === 'true');

  try {
    const syncedFromSmc = await syncSmcSignals();

    const { data: signals, error } = await sb
      .from('signal_analyses')
      .select('*')
      .eq('outcome', 'OPEN')
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) throw new Error(error.message);
    if (!signals?.length) {
      return json({
        ok: true,
        checked: 0,
        updated: 0,
        expired: 0,
        syncedFromSmc,
        message: 'No open signal_analyses rows',
      });
    }

    const candleCache = new Map<string, Candle[]>();
    const results: Array<Record<string, unknown>> = [];
    let updated = 0;
    let expired = 0;
    let errors = 0;

    for (const signal of signals as SignalRow[]) {
      const ageHours = Math.max(1, (Date.now() - Date.parse(signal.created_at)) / 36e5);
      const cacheKey = `${signal.symbol}:${intervalForAge(ageHours)}:${Math.ceil(ageHours)}`;

      try {
        if (!needsMarketData(signal)) {
          const outcome = scanOutcome(signal, [], maxAgeHours);
          const basePatch = {
            checked_at: new Date().toISOString(),
            check_count: (signal.check_count || 0) + 1,
            error_log: null,
          };
          if (outcome) {
            const patch = {
              ...basePatch,
              outcome: outcome.outcome,
              outcome_price: outcome.price,
              pnl_r: outcome.pnlR,
              mfe_r: outcome.mfeR,
              mae_r: outcome.maeR,
              outcome_at: outcome.at,
              outcome_source: 'update-outcomes',
            };
            if (!dryRun) {
              const { error: updateError } = await sb
                .from('signal_analyses')
                .update(patch)
                .eq('id', signal.id);
              if (updateError) throw new Error(updateError.message);
            }
            updated++;
            if (outcome.outcome === 'EXPIRED') expired++;
            results.push({ id: signal.id, symbol: signal.symbol, outcome: outcome.outcome });
          } else {
            if (!dryRun) {
              await sb.from('signal_analyses').update(basePatch).eq('id', signal.id);
            }
            results.push({ id: signal.id, symbol: signal.symbol, outcome: 'OPEN', skipped: 'not_actionable' });
          }
          continue;
        }

        if (!candleCache.has(cacheKey)) {
          candleCache.set(cacheKey, await fetchCandles(signal.symbol, ageHours + 2));
        }

        const outcome = scanOutcome(signal, candleCache.get(cacheKey) || [], maxAgeHours);
        const basePatch = {
          checked_at: new Date().toISOString(),
          check_count: (signal.check_count || 0) + 1,
          error_log: null,
        };

        if (!outcome) {
          if (!dryRun) {
            await sb.from('signal_analyses').update(basePatch).eq('id', signal.id);
          }
          results.push({ id: signal.id, symbol: signal.symbol, outcome: 'OPEN' });
          continue;
        }

        const patch = {
          ...basePatch,
          outcome: outcome.outcome,
          outcome_price: outcome.price,
          pnl_r: outcome.pnlR,
          mfe_r: outcome.mfeR,
          mae_r: outcome.maeR,
          outcome_at: outcome.at,
          outcome_source: 'update-outcomes',
        };

        if (!dryRun) {
          const { error: updateError } = await sb
            .from('signal_analyses')
            .update(patch)
            .eq('id', signal.id);
          if (updateError) throw new Error(updateError.message);
        }

        updated++;
        if (outcome.outcome === 'EXPIRED') expired++;
        results.push({
          id: signal.id,
          symbol: signal.symbol,
          outcome: outcome.outcome,
          pnl_r: outcome.pnlR,
          price: outcome.price,
        });

        // ── Telegram push for TP/SL outcomes (fire-and-forget) ─────────────
        if (!dryRun && outcome.outcome !== 'EXPIRED') {
          fetch(`${SB_URL}/functions/v1/telegram-bot`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${SB_SERVICE_KEY}`,
            },
            body: JSON.stringify({
              mode: 'outcome',
              signal: {
                symbol:    signal.symbol,
                outcome:   outcome.outcome,
                direction: signal.direction,
                pnl_r:     outcome.pnlR,
                pnl_usd:   signal.risk_usd != null && outcome.pnlR != null
                             ? signal.risk_usd * outcome.pnlR : null,
              },
            }),
          }).catch(e => console.warn('[telegram-push] failed:', e.message));
        }
      } catch (err) {
        errors++;
        const message = err instanceof Error ? err.message : String(err);
        if (!dryRun) {
          await sb
            .from('signal_analyses')
            .update({
              checked_at: new Date().toISOString(),
              check_count: (signal.check_count || 0) + 1,
              error_log: message,
            })
            .eq('id', signal.id);
        }
        results.push({ id: signal.id, symbol: signal.symbol, error: message });
      }
    }

    return json({
      ok: true,
      dryRun,
      checked: signals.length,
      updated,
      expired,
      errors,
      syncedFromSmc,
      durationMs: Date.now() - started,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[update-outcomes]', message);
    return json({ ok: false, error: message }, 500);
  }
});
