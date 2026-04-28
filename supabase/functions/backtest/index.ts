// PropPilot AI — backtest Edge Function
//
// GET  /backtest?action=list
// GET  /backtest?action=run&id=123
// POST /backtest { symbol, interval, bars, initialBalance, riskPct, minConfidence }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_SKEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb = createClient(SB_URL, SB_SKEY, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,apikey',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json',
};

const YF_SYM: Record<string, string> = {
  'XAU/USD': 'GC=F',
  'EUR/USD': 'EURUSD=X',
  'GBP/USD': 'GBPUSD=X',
  'USD/JPY': 'USDJPY=X',
  'GBP/JPY': 'GBPJPY=X',
  'NAS100': '^NDX',
  'BTC/USD': 'BTC-USD',
  'ETH/USD': 'ETH-USD',
};

const YF_INTERVAL: Record<string, { interval: string; range: string; minutes: number }> = {
  '15min': { interval: '15m', range: '5d', minutes: 15 },
  '1h': { interval: '1h', range: '60d', minutes: 60 },
  '1d': { interval: '1d', range: '2y', minutes: 1440 },
};

type Candle = {
  ts: number;
  t: string;
  o: number;
  h: number;
  l: number;
  v: number;
};

type SimTrade = {
  trade_id: number;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  open_ts: number;
  close_ts: number;
  entry_price: number;
  sl_price: number;
  tp1_price: number;
  tp2_price: number;
  exit_price: number;
  exit_reason: string;
  pnl_r: number;
  pnl_usd: number;
  risk_usd: number;
  confidence: number;
  session: string;
  regime: string;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function err(message: string, status = 400) {
  return json({ error: message }, status);
}

async function fetchCandles(symbol: string, interval: string, bars: number): Promise<Candle[]> {
  const yfSym = YF_SYM[symbol];
  if (!yfSym) throw new Error(`Unknown symbol: ${symbol}`);
  const iv = YF_INTERVAL[interval] || YF_INTERVAL['1h'];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=${iv.interval}&range=${iv.range}&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  const timestamps: number[] = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};

  const candles = timestamps
    .map((ts, i) => ({
      ts,
      t: new Date(ts * 1000).toISOString(),
      o: Number(quote.open?.[i]),
      h: Number(quote.high?.[i]),
      l: Number(quote.low?.[i]),
      v: Number(quote.close?.[i]),
    }))
    .filter(c => Number.isFinite(c.o) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.v))
    .slice(-Math.max(80, Math.min(1200, bars || 400)));

  if (candles.length < 80) throw new Error('Insufficient candle history for backtest');
  return candles;
}

function ema(values: number[], period: number) {
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev = values[0];
  for (const v of values) {
    prev = out.length === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function atr(candles: Candle[], period = 14) {
  const tr = candles.map((c, i) => {
    const prevClose = i === 0 ? c.v : candles[i - 1].v;
    return Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
  });
  return ema(tr, period);
}

function sessionFromTs(ts: number) {
  const h = new Date(ts * 1000).getUTCHours();
  if (h < 7) return 'Asia';
  if (h < 12) return 'London';
  if (h < 17) return 'Overlap';
  if (h < 21) return 'NewYork';
  return 'Dead';
}

function round(n: number, digits = 4) {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function summarizeTrades(trades: SimTrade[], equity: Array<{ ts: number; balance: number; equity: number }>, initialBalance: number) {
  const wins = trades.filter(t => t.pnl_r > 0);
  const losses = trades.filter(t => t.pnl_r <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl_usd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl_usd, 0));
  const totalR = trades.reduce((s, t) => s + t.pnl_r, 0);
  const finalBalance = equity.at(-1)?.balance || initialBalance;
  let peak = initialBalance;
  let maxDdUsd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.balance);
    maxDdUsd = Math.max(maxDdUsd, peak - p.balance);
  }
  const bySession: Record<string, { trades: number; wins: number; losses: number; total_r: number; avg_r?: number; win_rate?: number }> = {};
  for (const t of trades) {
    const s = bySession[t.session] || { trades: 0, wins: 0, losses: 0, total_r: 0 };
    s.trades += 1;
    s.total_r += t.pnl_r;
    if (t.pnl_r > 0) s.wins += 1;
    else s.losses += 1;
    bySession[t.session] = s;
  }
  for (const s of Object.values(bySession)) {
    s.avg_r = round(s.total_r / Math.max(1, s.trades), 3);
    s.win_rate = round(s.wins / Math.max(1, s.trades) * 100, 1);
  }
  return {
    total_trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    win_rate_pct: trades.length ? round(wins.length / trades.length * 100, 3) : 0,
    total_r: round(totalR, 4),
    avg_win_r: wins.length ? round(wins.reduce((s, t) => s + t.pnl_r, 0) / wins.length, 4) : 0,
    avg_loss_r: losses.length ? round(losses.reduce((s, t) => s + t.pnl_r, 0) / losses.length, 4) : 0,
    expectancy_r: trades.length ? round(totalR / trades.length, 5) : 0,
    profit_factor: grossLoss ? round(grossProfit / grossLoss, 3) : (grossProfit > 0 ? 9.99 : 0),
    final_balance: round(finalBalance, 2),
    total_return_pct: round((finalBalance - initialBalance) / initialBalance * 100, 3),
    max_drawdown_pct: peak ? round(maxDdUsd / peak * 100, 3) : 0,
    max_drawdown_usd: round(maxDdUsd, 2),
    sharpe: 0,
    sortino: 0,
    session_stats: bySession,
  };
}

function runSimulation(symbol: string, candles: Candle[], opts: Record<string, number | string>) {
  const initialBalance = Number(opts.initialBalance || 100000);
  const riskPct = Number(opts.riskPct || 1);
  const minConfidence = Number(opts.minConfidence || 60);
  const rrTarget = Number(opts.rrTarget || 2);
  const closes = candles.map(c => c.v);
  const fast = ema(closes, 20);
  const slow = ema(closes, 50);
  const atrs = atr(candles, 14);
  let balance = initialBalance;
  let tradeId = 0;
  let position: null | {
    direction: 'LONG' | 'SHORT';
    open_ts: number;
    entry: number;
    sl: number;
    tp: number;
    risk_usd: number;
    confidence: number;
    session: string;
    regime: string;
  } = null;
  const trades: SimTrade[] = [];
  const equity: Array<{ ts: number; balance: number; equity: number }> = [];
  const dailyCounts: Record<string, number> = {};
  let skipped = 0;

  const closePosition = (bar: Candle, exitPrice: number, reason: string, pnlR: number) => {
    if (!position) return;
    const pnlUsd = pnlR * position.risk_usd;
    balance += pnlUsd;
    tradeId += 1;
    trades.push({
      trade_id: tradeId,
      symbol,
      direction: position.direction,
      open_ts: position.open_ts,
      close_ts: bar.ts,
      entry_price: round(position.entry, 5),
      sl_price: round(position.sl, 5),
      tp1_price: round((position.entry + (position.tp - position.entry) * 0.5), 5),
      tp2_price: round(position.tp, 5),
      exit_price: round(exitPrice, 5),
      exit_reason: reason,
      pnl_r: round(pnlR, 4),
      pnl_usd: round(pnlUsd, 2),
      risk_usd: round(position.risk_usd, 2),
      confidence: position.confidence,
      session: position.session,
      regime: position.regime,
    });
    position = null;
  };

  for (let i = 60; i < candles.length - 1; i += 1) {
    const bar = candles[i];
    const day = new Date(bar.ts * 1000).toISOString().slice(0, 10);

    if (position) {
      if (position.direction === 'LONG') {
        if (bar.l <= position.sl) closePosition(bar, position.sl, 'SL', -1);
        else if (bar.h >= position.tp) closePosition(bar, position.tp, 'TP2', rrTarget);
      } else {
        if (bar.h >= position.sl) closePosition(bar, position.sl, 'SL', -1);
        else if (bar.l <= position.tp) closePosition(bar, position.tp, 'TP2', rrTarget);
      }
    }

    equity.push({ ts: bar.ts, balance: round(balance, 4), equity: round(balance, 4) });
    if (position) continue;
    if ((dailyCounts[day] || 0) >= 3) { skipped += 1; continue; }

    const trendGap = Math.abs(fast[i] - slow[i]) / Math.max(atrs[i] || 1e-9, 1e-9);
    const confidence = Math.min(95, Math.round(52 + trendGap * 18));
    if (confidence < minConfidence) { skipped += 1; continue; }

    const prev = candles[i - 1];
    const next = candles[i + 1];
    const isLong = fast[i] > slow[i] && prev.v < fast[i - 1] && bar.v > fast[i];
    const isShort = fast[i] < slow[i] && prev.v > fast[i - 1] && bar.v < fast[i];
    if (!isLong && !isShort) continue;

    const entry = next.o;
    const slDist = Math.max((atrs[i] || entry * 0.002) * 1.2, entry * 0.0005);
    const direction = isLong ? 'LONG' : 'SHORT';
    const sl = direction === 'LONG' ? entry - slDist : entry + slDist;
    const tp = direction === 'LONG' ? entry + slDist * rrTarget : entry - slDist * rrTarget;
    dailyCounts[day] = (dailyCounts[day] || 0) + 1;
    position = {
      direction,
      open_ts: next.ts,
      entry,
      sl,
      tp,
      risk_usd: balance * riskPct / 100,
      confidence,
      session: sessionFromTs(bar.ts),
      regime: fast[i] > slow[i] ? 'TREND_BULL' : 'TREND_BEAR',
    };
  }

  if (position) {
    const last = candles[candles.length - 1];
    const dist = Math.abs(position.entry - position.sl);
    const pnlR = position.direction === 'LONG'
      ? (last.v - position.entry) / dist
      : (position.entry - last.v) / dist;
    closePosition(last, last.v, 'EXPIRED', Math.max(-1, Math.min(rrTarget, pnlR)));
  }

  const stats = summarizeTrades(trades, equity, initialBalance);
  return { trades, equity, stats, trades_skipped: skipped };
}

async function saveRun(symbol: string, interval: string, candles: Candle[], simulation: ReturnType<typeof runSimulation>, config: Record<string, unknown>) {
  const iv = YF_INTERVAL[interval] || YF_INTERVAL['1h'];
  const stats = simulation.stats;
  const startDate = candles[0].t.slice(0, 10);
  const endDate = candles[candles.length - 1].t.slice(0, 10);
  const { data: run, error } = await sb.from('backtest_runs').insert({
    symbol,
    start_date: startDate,
    end_date: endDate,
    bars_analyzed: candles.length,
    timeframe_minutes: iv.minutes,
    config,
    total_trades: stats.total_trades,
    wins: stats.wins,
    losses: stats.losses,
    win_rate_pct: stats.win_rate_pct,
    total_r: stats.total_r,
    avg_win_r: stats.avg_win_r,
    avg_loss_r: stats.avg_loss_r,
    expectancy_r: stats.expectancy_r,
    profit_factor: stats.profit_factor,
    initial_balance: Number(config.initialBalance || 100000),
    final_balance: stats.final_balance,
    total_return_pct: stats.total_return_pct,
    max_drawdown_pct: stats.max_drawdown_pct,
    max_drawdown_usd: stats.max_drawdown_usd,
    sharpe: stats.sharpe,
    sortino: stats.sortino,
    session_stats: stats.session_stats,
    notes: 'Quick EMA/ATR smoke backtest from Edge Function',
    tags: ['quick', 'edge'],
    trades_skipped: simulation.trades_skipped,
  }).select('*').single();
  if (error) throw error;

  if (simulation.trades.length) {
    const { error: tradesErr } = await sb.from('backtest_trades').insert(
      simulation.trades.map(t => ({ ...t, run_id: run.id })),
    );
    if (tradesErr) throw tradesErr;
  }

  const step = Math.max(1, Math.ceil(simulation.equity.length / 300));
  const sampled = simulation.equity.filter((_, i) => i % step === 0 || i === simulation.equity.length - 1);
  if (sampled.length) {
    const { error: equityErr } = await sb.from('backtest_equity_curve').insert(
      sampled.map(p => ({ ...p, run_id: run.id })),
    );
    if (equityErr) throw equityErr;
  }

  return run;
}

async function handleGet(url: URL) {
  const action = url.searchParams.get('action') || 'list';
  if (action === 'list') {
    const limit = Number(url.searchParams.get('limit') || 20);
    const { data, error } = await sb
      .from('v_backtest_summary')
      .select('*')
      .limit(Math.max(1, Math.min(100, limit)));
    if (error) return err(error.message);
    return json({ runs: data || [] });
  }

  if (action === 'run') {
    const id = Number(url.searchParams.get('id'));
    if (!id) return err('id required');
    const [runRes, tradesRes, equityRes] = await Promise.all([
      sb.from('backtest_runs').select('*').eq('id', id).single(),
      sb.from('backtest_trades').select('*').eq('run_id', id).order('trade_id', { ascending: true }),
      sb.from('backtest_equity_curve').select('*').eq('run_id', id).order('ts', { ascending: true }),
    ]);
    if (runRes.error) return err(runRes.error.message);
    if (tradesRes.error) return err(tradesRes.error.message);
    if (equityRes.error) return err(equityRes.error.message);
    return json({ run: runRes.data, trades: tradesRes.data || [], equity: equityRes.data || [] });
  }

  if (action === 'session-edge') {
    const { data, error } = await sb.from('v_backtest_session_edge').select('*').limit(100);
    if (error) return err(error.message);
    return json({ sessions: data || [] });
  }

  return err(`Unknown action: ${action}`);
}

async function handlePost(req: Request) {
  const body = await req.json().catch(() => ({}));
  const symbol = String(body.symbol || 'XAU/USD');
  const interval = String(body.interval || '1h');
  const bars = Number(body.bars || 500);
  const config = {
    symbol,
    interval,
    bars,
    initialBalance: Number(body.initialBalance || 100000),
    riskPct: Number(body.riskPct || 1),
    minConfidence: Number(body.minConfidence || 60),
    rrTarget: Number(body.rrTarget || 2),
    engine: 'edge_ema_atr_quick',
  };
  const candles = await fetchCandles(symbol, interval, bars);
  const simulation = runSimulation(symbol, candles, config);
  const run = await saveRun(symbol, interval, candles, simulation, config);
  return json({ run, stats: simulation.stats, trades: simulation.trades.slice(0, 50) }, 201);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const url = new URL(req.url);
    if (req.method === 'GET') return await handleGet(url);
    if (req.method === 'POST') return await handlePost(req);
    return err('Method not allowed', 405);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[backtest]', message);
    return err(message, 500);
  }
});
