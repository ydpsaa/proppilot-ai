// ═══════════════════════════════════════════════════════════════════════════
// PropPilot — execute-paper-trade Edge Function
// Phase 3: Smart trade router with full risk management pipeline.
//
// Pre-flight checklist (in order):
//   1. Bot paused? → 403
//   2. Kill-switch active? → 403
//   3. Confidence < threshold? → 400
//   4. Daily loss > limit? → triggers kill-switch + 403
//   5. Max open positions reached? → 400
//   6. Same symbol already open? → 400
//   7. Correlation guard (same directional bias)? → 400
//
// Lot sizing:
//   risk_usd = balance * risk_pct / 100
//   lot      = risk_usd / (sl_distance * contract_size)
//   (min 0.01, rounded to 2 decimal places)
//
// Contract sizes per instrument:
//   XAU/USD : 100  (1 lot = 100 troy oz)
//   NAS100  : 20   (1 lot = 20 index units, approx)
//   EUR/USD : 100000 (1 standard lot)
//   GBP/USD : 100000
//   USD/JPY : 100000
//   BTC/USD : 1
//   ETH/USD : 1
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2';

const SB_URL  = Deno.env.get('SUPABASE_URL')!;
const SB_SKEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb      = createClient(SB_URL, SB_SKEY);

// ── Constants ────────────────────────────────────────────────────────────────

const CONTRACT_SIZE: Record<string, number> = {
  'XAU/USD': 100,
  'NAS100':  20,
  'EUR/USD': 100000,
  'GBP/USD': 100000,
  'USD/JPY': 100000,
  'GBP/JPY': 100000,
  'EUR/JPY': 100000,
  'BTC/USD': 1,
  'ETH/USD': 1,
};

// Correlation map: pairs grouped by directional bias.
// Pairs within the same group count as "same exposure" —
// we don't want both LONG XAUUSD and LONG EURUSD (both = short USD).
// Structure: { 'symbol' → 'group_id' }
// Same group + same direction = correlation blocked.
const CORRELATION_GROUP: Record<string, string> = {
  'XAU/USD': 'USD_BEAR',   // Long Gold = bearish USD
  'EUR/USD': 'USD_BEAR',   // Long EUR = bearish USD
  'GBP/USD': 'USD_BEAR',   // Long GBP = bearish USD
  'NAS100':  'RISK_ON',    // Long NAS = risk on
  'BTC/USD': 'RISK_ON',    // Long BTC = risk on
  'ETH/USD': 'RISK_ON',
  'USD/JPY': 'USD_BULL',   // Long USD/JPY = bullish USD
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,apikey,x-proppilot-cron-secret',
};

// ── Currency mapping for news checks ────────────────────────────────────────
const SYMBOL_CURRENCIES: Record<string, string[]> = {
  'XAU/USD': ['USD', 'XAU'],
  'EUR/USD': ['EUR', 'USD'],
  'GBP/USD': ['GBP', 'USD'],
  'USD/JPY': ['USD', 'JPY'],
  'NAS100':  ['USD'],
  'BTC/USD': [],  // crypto ignores forex news
  'ETH/USD': [],
};

// ── News check: reject trades within 15 min of high-impact events ────────────
async function checkNewsBlock(symbol: string): Promise<{ blocked: boolean; reason: string }> {
  try {
    const currencies = SYMBOL_CURRENCIES[symbol] || [];
    if (!currencies.length) return { blocked: false, reason: '' };

    const calendarUrl = `${SB_URL}/functions/v1/calendar?window=20&impact=High`;
    const res = await fetch(calendarUrl, {
      headers: { 'x-proppilot-cron-secret': Deno.env.get('PROPILOT_CRON_SECRET') || '' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { blocked: false, reason: '' };

    const data = await res.json();
    const events = (data.events || []) as Array<{
      currency: string; impact: string; title: string; minutes_until: number | null; is_imminent: boolean;
    }>;

    const relevant = events.filter(e =>
      currencies.includes(e.currency.toUpperCase()) &&
      e.impact === 'High' &&
      e.is_imminent
    );

    if (relevant.length > 0) {
      const e = relevant[0];
      return {
        blocked: true,
        reason: `News block: ${e.title} (${e.currency}) in ${Math.max(0, e.minutes_until ?? 0)}min`,
      };
    }
    return { blocked: false, reason: '' };
  } catch {
    return { blocked: false, reason: '' }; // Don't block on calendar fetch failure
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function logExecution(
  symbol: string, direction: string | null, action: string,
  reason: string, extras: Record<string, unknown> = {}
) {
  await sb.from('execution_log').insert({
    symbol, direction, action, reason, ...extras,
    created_at: new Date().toISOString(),
  });
}

async function reject(
  symbol: string, direction: string, action: string,
  reason: string, status: number, extras: Record<string, unknown> = {}
): Promise<Response> {
  await logExecution(symbol, direction, action, reason, extras);
  return new Response(
    JSON.stringify({ error: reason, action }),
    { status, headers: { ...CORS, 'Content-Type': 'application/json' } }
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
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

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  const authError = await authorizeAction(req);
  if (authError) return authError;

  const startMs = Date.now();
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const {
    symbol,
    direction,
    entry_price,
    sl_price,
    tp1_price,
    tp2_price,
    confidence = 0,
    session_type = 'adhoc',
    signal_id    = null,
    atr          = null,
    notes        = '',
  } = body as {
    symbol:       string;
    direction:    'LONG' | 'SHORT';
    entry_price:  number;
    sl_price:     number;
    tp1_price:    number;
    tp2_price:    number;
    confidence:   number;
    session_type: string;
    signal_id:    string | null;
    atr:          number | null;
    notes:        string;
  };

  if (!symbol || !direction || entry_price == null || sl_price == null || tp1_price == null || tp2_price == null) {
    return new Response(JSON.stringify({ error: 'Missing required fields: symbol, direction, entry_price, sl_price, tp1_price, tp2_price' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // ── 1. Load settings & account ────────────────────────────────────────────
  const [{ data: settings }, { data: account }] = await Promise.all([
    sb.from('bot_settings').select('*').eq('id', 1).single(),
    sb.from('paper_account').select('*').eq('id', 1).single(),
  ]);

  if (!settings || !account) {
    return new Response(JSON.stringify({ error: 'Database not initialised — run SQL migrations' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // ── 2. Bot paused? ────────────────────────────────────────────────────────
  if (settings.is_paused) {
    return reject(symbol, direction, 'REJECT_PAUSED', 'Bot is manually paused', 403);
  }

  // ── 3. Kill-switch active? ────────────────────────────────────────────────
  if (account.kill_switch_active) {
    return reject(symbol, direction, 'REJECT_KILL_SWITCH',
      `Kill-switch active: ${account.kill_switch_reason || 'daily loss limit'}`, 403);
  }

  // ── 3b. News block — high-impact event imminent? ─────────────────────────
  const newsCheck = await checkNewsBlock(symbol);
  if (newsCheck.blocked) {
    return reject(symbol, direction, 'REJECT_NEWS_BLOCK', newsCheck.reason, 403);
  }

  // ── 4. Daily reset check ──────────────────────────────────────────────────
  const today     = new Date().toISOString().slice(0, 10);
  const lastDay   = account.day_date?.toString().slice(0, 10) ?? today;
  if (lastDay !== today) {
    // New trading day — reset daily counters
    await sb.from('paper_account').update({
      daily_pnl_usd:       0,
      daily_start_balance: account.balance,
      daily_trades:        0,
      day_date:            today,
      updated_at:          new Date().toISOString(),
    }).eq('id', 1);
    account.daily_pnl_usd = 0;
    account.daily_start_balance = account.balance;
  }

  // ── 5. Confidence gate ────────────────────────────────────────────────────
  if ((confidence as number) < (settings.confidence_threshold as number)) {
    return reject(symbol, direction, 'REJECT_CONFIDENCE',
      `Confidence ${confidence}% < threshold ${settings.confidence_threshold}%`, 400,
      { confidence });
  }

  // ── 6. Daily loss limit → trigger kill-switch ─────────────────────────────
  const balance          = +(account.balance ?? 100000);
  const dailyPnl         = +(account.daily_pnl_usd ?? 0);
  const dailyLossLimit   = balance * (+(settings.daily_loss_limit_pct ?? 2) / 100);
  if (dailyPnl < 0 && Math.abs(dailyPnl) >= dailyLossLimit) {
    const reason = `Daily loss limit hit: -$${Math.abs(dailyPnl).toFixed(2)} ≥ $${dailyLossLimit.toFixed(2)} (${settings.daily_loss_limit_pct}%)`;
    // Activate kill-switch
    await sb.from('paper_account').update({
      kill_switch_active: true,
      kill_switch_reason: reason,
      kill_switch_at:     new Date().toISOString(),
      updated_at:         new Date().toISOString(),
    }).eq('id', 1);
    await sb.from('bot_settings').update({ is_paused: true, updated_at: new Date().toISOString() }).eq('id', 1);
    return reject(symbol, direction, 'REJECT_KILL_SWITCH', reason, 403, { daily_pnl: dailyPnl });
  }

  // ── 7. Max open positions ─────────────────────────────────────────────────
  const { count: openCount } = await sb
    .from('paper_positions')
    .select('id', { count: 'exact', head: true })
    .in('status', ['OPEN', 'TP1_HIT']);

  if ((openCount ?? 0) >= +(settings.max_open_positions ?? 3)) {
    return reject(symbol, direction, 'REJECT_MAX_POS',
      `Max open positions reached (${openCount}/${settings.max_open_positions})`, 400,
      { open_count: openCount });
  }

  // ── 8. Same symbol already open? ──────────────────────────────────────────
  const { data: sameSymbol } = await sb
    .from('paper_positions')
    .select('id, direction')
    .eq('symbol', symbol)
    .in('status', ['OPEN', 'TP1_HIT'])
    .limit(1);

  if (sameSymbol && sameSymbol.length > 0) {
    return reject(symbol, direction, 'REJECT_DUPLICATE',
      `Position already open for ${symbol} (${sameSymbol[0].direction})`, 400);
  }

  // ── 9. Correlation guard ──────────────────────────────────────────────────
  if (settings.correlation_guard) {
    const myGroup = CORRELATION_GROUP[symbol];
    if (myGroup) {
      // Find all open positions in the same correlation group
      const { data: openPositions } = await sb
        .from('paper_positions')
        .select('symbol, direction, correlation_tag')
        .in('status', ['OPEN', 'TP1_HIT']);

      for (const pos of (openPositions || [])) {
        const posGroup = CORRELATION_GROUP[pos.symbol];
        if (posGroup && posGroup === myGroup && pos.direction === direction) {
          return reject(symbol, direction, 'REJECT_CORRELATION',
            `Correlated exposure blocked: already ${pos.direction} ${pos.symbol} (group: ${myGroup})`, 400,
            { conflicting_symbol: pos.symbol, correlation_group: myGroup });
        }
      }
    }
  }

  // ── 10. Calculate lot size ────────────────────────────────────────────────
  const riskPct    = +(settings.risk_pct ?? 1);
  const riskUsd    = balance * riskPct / 100;
  const slDist     = Math.abs(+entry_price - +sl_price);
  const contractSz = CONTRACT_SIZE[symbol] ?? 100000;
  const lotRaw     = slDist > 0 ? riskUsd / (slDist * contractSz) : 0.01;
  const lotSize    = Math.max(0.01, Math.round(lotRaw * 100) / 100);  // min 0.01, 2dp

  // ── 11. Insert paper position ─────────────────────────────────────────────
  const { data: position, error: posErr } = await sb.from('paper_positions').insert({
    symbol,
    direction,
    entry_price:     +entry_price,
    sl_price:        +sl_price,
    sl_orig:         +sl_price,
    tp1_price:       +tp1_price,
    tp2_price:       +tp2_price,
    lot_size:        lotSize,
    risk_usd:        +riskUsd.toFixed(2),
    size_usd:        +(lotSize * contractSz * +entry_price).toFixed(2),
    status:          'OPEN',
    confidence,
    session_type,
    signal_id:       signal_id || null,
    correlation_tag: CORRELATION_GROUP[symbol] ?? null,
    notes:           notes || null,
    opened_at:       new Date().toISOString(),
    pnl_usd:         0,
    pnl_r:           0,
    partial_pnl_usd: 0,
    partial_pnl_r:   0,
    tp1_hit:         false,
    sl_moved_to_be:  false,
    trailing_activated: false,
  }).select().single();

  if (posErr) {
    console.error('[execute-paper-trade] insert error:', posErr);
    return new Response(JSON.stringify({ error: posErr.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // ── 12. Update account daily trades counter ───────────────────────────────
  await sb.from('paper_account').update({
    daily_trades: (account.daily_trades ?? 0) + 1,
    session_count: (account.session_count ?? 0) + 1,
    updated_at: new Date().toISOString(),
  }).eq('id', 1);

  // ── 13. Log to execution_log ──────────────────────────────────────────────
  await sb.from('execution_log').insert({
    symbol, direction, action: 'OPEN_TRADE',
    reason:      `${direction} ${symbol} @ ${entry_price} | SL:${sl_price} TP1:${tp1_price} TP2:${tp2_price}`,
    confidence,
    entry_price: +entry_price,
    sl_price:    +sl_price,
    lot_size:    lotSize,
    risk_usd:    +riskUsd.toFixed(2),
    position_id: position.id,
    session_type,
    metadata:    { atr, correlation_tag: CORRELATION_GROUP[symbol] ?? null, signal_id },
  });

  // ── 14. Log to bot_memory ─────────────────────────────────────────────────
  try {
    await sb.from('bot_memory').insert({
      session_type,
      run_at:          new Date().toISOString(),
      signals_found:   [{ symbol, direction, confidence }],
      trades_placed:   [{ id: position.id, symbol, direction, entry_price, lot_size: lotSize, risk_usd: riskUsd }],
      market_notes:    `Paper trade opened: ${direction} ${symbol} @ ${entry_price} | Lot: ${lotSize} | Risk: $${riskUsd.toFixed(0)}`,
      lessons_learned: '',
      next_watch_levels: { sl: sl_price, tp1: tp1_price, tp2: tp2_price },
    });
  } catch { /* non-blocking */ }

  const result = {
    success:    true,
    position_id: position.id,
    symbol,
    direction,
    entry_price: +entry_price,
    sl_price:   +sl_price,
    tp1_price:  +tp1_price,
    tp2_price:  +tp2_price,
    lot_size:   lotSize,
    risk_usd:   +riskUsd.toFixed(2),
    risk_pct:   riskPct,
    session_type,
    confidence,
    duration_ms: Date.now() - startMs,
  };

  console.log(`[execute-paper-trade] OPENED: ${direction} ${symbol} lot=${lotSize} risk=$${riskUsd.toFixed(0)} conf=${confidence}%`);

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
