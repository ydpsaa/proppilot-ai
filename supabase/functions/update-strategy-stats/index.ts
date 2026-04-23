import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const sb = createClient(SB_URL, SB_SERVICE_KEY, {
  auth: { persistSession: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,apikey',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

type Signal = {
  created_at: string;
  symbol: string | null;
  timeframe: string | null;
  signal_state: string | null;
  session_name: string | null;
  confidence: number | string | null;
  outcome: 'OPEN' | 'TP1_HIT' | 'TP2_HIT' | 'SL_HIT' | 'EXPIRED' | 'CANCELLED';
  pnl_r: number | string | null;
  mfe_r: number | string | null;
  mae_r: number | string | null;
};

type Group = {
  symbol: string;
  signal_state: string;
  session_name: string;
  timeframe: string;
  signals: Signal[];
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

function valueR(signal: Signal): number | null {
  const explicit = n(signal.pnl_r);
  if (explicit !== null) return explicit;
  if (signal.outcome === 'TP2_HIT') return 2;
  if (signal.outcome === 'TP1_HIT') return 1;
  if (signal.outcome === 'SL_HIT') return -1;
  if (signal.outcome === 'EXPIRED') return 0;
  return null;
}

function avg(values: number[]): number | null {
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
}

function bestHour(signals: Signal[]): number | null {
  const buckets = new Map<number, { wins: number; losses: number }>();
  for (const signal of signals) {
    if (!['TP1_HIT', 'TP2_HIT', 'SL_HIT'].includes(signal.outcome)) continue;
    const hour = new Date(signal.created_at).getUTCHours();
    const bucket = buckets.get(hour) || { wins: 0, losses: 0 };
    if (signal.outcome === 'TP1_HIT' || signal.outcome === 'TP2_HIT') bucket.wins++;
    if (signal.outcome === 'SL_HIT') bucket.losses++;
    buckets.set(hour, bucket);
  }

  let best: { hour: number; winRate: number; decided: number } | null = null;
  for (const [hour, bucket] of buckets) {
    const decided = bucket.wins + bucket.losses;
    if (decided === 0) continue;
    const winRate = bucket.wins / decided;
    if (
      !best ||
      winRate > best.winRate ||
      (winRate === best.winRate && decided > best.decided)
    ) {
      best = { hour, winRate, decided };
    }
  }
  return best?.hour ?? null;
}

async function fetchAllSignals(): Promise<Signal[]> {
  const out: Signal[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await sb
      .from('signal_analyses')
      .select('created_at,symbol,timeframe,signal_state,session_name,confidence,outcome,pnl_r,mfe_r,mae_r')
      .order('created_at', { ascending: true })
      .range(from, to);

    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out.push(...(data as Signal[]));
    if (data.length < pageSize) break;
  }
  return out;
}

function groupSignals(signals: Signal[]): Group[] {
  const groups = new Map<string, Group>();
  for (const signal of signals) {
    const symbol = signal.symbol || 'UNKNOWN';
    const signalState = signal.signal_state || 'UNKNOWN';
    const sessionName = signal.session_name || 'Unknown';
    const timeframe = signal.timeframe || 'unknown';
    const key = `${symbol}|${signalState}|${sessionName}|${timeframe}`;
    if (!groups.has(key)) {
      groups.set(key, {
        symbol,
        signal_state: signalState,
        session_name: sessionName,
        timeframe,
        signals: [],
      });
    }
    groups.get(key)!.signals.push(signal);
  }
  return [...groups.values()];
}

function buildStatRows(groups: Group[], calculatedAt: string) {
  return groups.map((group) => {
    const signals = group.signals;
    const wins = signals.filter((s) => s.outcome === 'TP1_HIT' || s.outcome === 'TP2_HIT');
    const losses = signals.filter((s) => s.outcome === 'SL_HIT');
    const expired = signals.filter((s) => s.outcome === 'EXPIRED');
    const open = signals.filter((s) => s.outcome === 'OPEN');
    const decided = wins.length + losses.length;

    const winR = wins.map(valueR).filter((v): v is number => v !== null);
    const lossR = losses.map(valueR).filter((v): v is number => v !== null);
    const resolvedR = [...wins, ...losses, ...expired]
      .map(valueR)
      .filter((v): v is number => v !== null);
    const mfe = signals.map((s) => n(s.mfe_r)).filter((v): v is number => v !== null);
    const mae = signals.map((s) => n(s.mae_r)).filter((v): v is number => v !== null);
    const confidence = signals.map((s) => n(s.confidence)).filter((v): v is number => v !== null);

    const avgWinR = avg(winR.map(Math.abs));
    const avgLossR = avg(lossR.map((value) => Math.abs(value)));
    const winRate = decided > 0 ? wins.length / decided : 0;
    const expectancy = decided > 0
      ? (winRate * (avgWinR || 0)) - ((1 - winRate) * (avgLossR || 0))
      : 0;
    const grossProfit = winR.reduce((sum, value) => sum + Math.abs(value), 0);
    const grossLoss = lossR.reduce((sum, value) => sum + Math.abs(value), 0);
    const profitFactor = grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? 99
        : 0;

    return {
      calculated_at: calculatedAt,
      symbol: group.symbol,
      signal_state: group.signal_state,
      session_name: group.session_name,
      timeframe: group.timeframe,
      total_signals: signals.length,
      open_signals: open.length,
      wins: wins.length,
      losses: losses.length,
      expired: expired.length,
      win_rate: Number(winRate.toFixed(5)),
      avg_win_r: avgWinR,
      avg_loss_r: avgLossR,
      avg_pnl_r: avg(resolvedR),
      expectancy: Number(expectancy.toFixed(4)),
      profit_factor: Number(profitFactor.toFixed(4)),
      avg_mfe: avg(mfe),
      avg_mae: avg(mae),
      avg_confidence: avg(confidence),
      best_hour: bestHour(signals),
      sample_start: signals[0]?.created_at,
      sample_end: signals[signals.length - 1]?.created_at,
    };
  }).sort((a, b) => b.expectancy - a.expectancy || b.total_signals - a.total_signals);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const started = Date.now();
  try {
    const body = req.method === 'POST'
      ? await req.json().catch(() => ({}))
      : {};
    const minSignals = Math.max(1, Number(body.minSignals || 1));
    const calculatedAt = new Date().toISOString();

    const signals = await fetchAllSignals();
    const rows = buildStatRows(groupSignals(signals), calculatedAt)
      .filter((row) => row.total_signals >= minSignals);

    const { error: deleteError } = await sb
      .from('strategy_stats')
      .delete()
      .gte('id', 0);
    if (deleteError) throw new Error(deleteError.message);

    if (rows.length > 0) {
      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const { error } = await sb
          .from('strategy_stats')
          .insert(rows.slice(i, i + chunkSize));
        if (error) throw new Error(error.message);
      }
    }

    return json({
      ok: true,
      sourceSignals: signals.length,
      statRows: rows.length,
      calculatedAt,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[update-strategy-stats]', message);
    return json({ ok: false, error: message }, 500);
  }
});
