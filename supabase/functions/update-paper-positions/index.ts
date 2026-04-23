// ═══════════════════════════════════════════════════════════════════════════
// PropPilot — update-paper-positions Edge Function
// Runs every 5 min via pg_cron. Fetches live prices and updates P&L.
// Closes positions when TP1/TP2/SL is hit.
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2';

const SB_URL  = Deno.env.get('SUPABASE_URL')!;
const SB_SKEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TD_KEY  = Deno.env.get('TWELVE_DATA_KEY') || '';

const sb = createClient(SB_URL, SB_SKEY);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,apikey',
};

// Contract sizes for P&L calculation
const CONTRACT_SIZE: Record<string, number> = {
  'XAU/USD': 100,
  'NAS100':  20,
  'EUR/USD': 100000,
  'GBP/USD': 100000,
  'USD/JPY': 100000,
  'GBP/JPY': 100000,
  'BTC/USD': 1,
  'ETH/USD': 1,
};

// Twelve Data symbol map
const TD_SYMBOL: Record<string, string> = {
  'XAU/USD': 'XAU/USD',
  'EUR/USD': 'EUR/USD',
  'GBP/USD': 'GBP/USD',
  'USD/JPY': 'USD/JPY',
  'NAS100':  'NDX',
  'BTC/USD': 'BTC/USD',
  'ETH/USD': 'ETH/USD',
};

// Fetch live price from Twelve Data (or fallback to demo)
async function fetchPrice(symbol: string): Promise<number | null> {
  if (!TD_KEY) return demoPrice(symbol);

  const tdSym = TD_SYMBOL[symbol] || symbol;
  try {
    const r = await fetch(
      `https://api.twelvedata.com/price?symbol=${encodeURIComponent(tdSym)}&apikey=${TD_KEY}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const d = await r.json();
    const price = parseFloat(d.price);
    if (!isNaN(price) && price > 0) return price;
  } catch { /* fallthrough to demo */ }

  return demoPrice(symbol);
}

// Demo prices (used when no API key or API fails)
function demoPrice(symbol: string): number {
  const base: Record<string, number> = {
    'XAU/USD': 2345.0,
    'EUR/USD': 1.0850,
    'GBP/USD': 1.2700,
    'USD/JPY': 149.50,
    'NAS100':  17800.0,
    'BTC/USD': 67000.0,
    'ETH/USD': 3500.0,
  };
  const b = base[symbol] || 1.0;
  // Small random walk ±0.1%
  return b * (1 + (Math.random() - 0.5) * 0.002);
}

// Calculate P&L in USD
function calcPnl(pos: Record<string, number | string>, currentPrice: number): { pnl_usd: number; pnl_r: number } {
  const entry    = +pos.entry_price;
  const lotSize  = +pos.lot_size || 0.01;
  const riskUsd  = +pos.risk_usd || 100;
  const contract = CONTRACT_SIZE[pos.symbol as string] || 100000;
  const dir      = pos.direction === 'LONG' ? 1 : -1;

  const priceDiff = (currentPrice - entry) * dir;
  const pnl_usd   = priceDiff * lotSize * contract;

  const slDist = Math.abs(entry - +pos.sl_price);
  const pnl_r  = slDist > 0 ? pnl_usd / riskUsd : 0;

  return { pnl_usd: +pnl_usd.toFixed(2), pnl_r: +pnl_r.toFixed(3) };
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const now = new Date().toISOString();
  let updated = 0, closed = 0;

  try {
    // Fetch all open positions
    const { data: positions, error } = await sb
      .from('paper_positions')
      .select('*')
      .in('status', ['OPEN', 'TP1_HIT']);

    if (error) throw new Error(error.message);
    if (!positions || positions.length === 0) {
      return new Response(JSON.stringify({ updated: 0, closed: 0, message: 'No open positions' }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // Get unique symbols
    const symbols = [...new Set(positions.map((p: any) => p.symbol))];

    // Fetch prices for all symbols concurrently
    const priceMap: Record<string, number> = {};
    await Promise.all(symbols.map(async (sym) => {
      const price = await fetchPrice(sym as string);
      if (price) priceMap[sym as string] = price;
    }));

    // Process each position
    for (const pos of positions as any[]) {
      const currentPrice = priceMap[pos.symbol];
      if (!currentPrice) continue;

      const { pnl_usd, pnl_r } = calcPnl(pos, currentPrice);
      const sl  = +pos.sl_price;
      const tp1 = +pos.tp1_price;
      const tp2 = +pos.tp2_price;
      const isLong = pos.direction === 'LONG';

      // Check SL hit
      const slHit = isLong ? currentPrice <= sl : currentPrice >= sl;
      // Check TP1 hit
      const tp1Hit = isLong ? currentPrice >= tp1 : currentPrice <= tp1;
      // Check TP2 hit
      const tp2Hit = isLong ? currentPrice >= tp2 : currentPrice <= tp2;

      if (slHit) {
        // Close at SL
        await sb.from('paper_positions').update({
          status:      'SL_HIT',
          close_price: currentPrice,
          closed_at:   now,
          pnl_usd,
          pnl_r,
        }).eq('id', pos.id);

        // Update account
        await updateAccount(-Math.abs(pnl_usd), false);

        await sb.from('execution_log').insert({
          symbol: pos.symbol, direction: pos.direction,
          action: 'CLOSE_SL',
          reason: `SL hit @ ${currentPrice} | P&L: $${pnl_usd}`,
          position_id: pos.id, entry_price: pos.entry_price,
          sl_price: sl, session_type: pos.session_type,
        });

        closed++;

      } else if (tp2Hit && pos.status === 'TP1_HIT') {
        // Close full at TP2
        await sb.from('paper_positions').update({
          status:      'TP2_HIT',
          close_price: currentPrice,
          closed_at:   now,
          pnl_usd,
          pnl_r,
        }).eq('id', pos.id);

        await updateAccount(pnl_usd, true);

        await sb.from('execution_log').insert({
          symbol: pos.symbol, direction: pos.direction,
          action: 'CLOSE_TP2',
          reason: `TP2 hit @ ${currentPrice} | P&L: $${pnl_usd}`,
          position_id: pos.id, entry_price: pos.entry_price,
          session_type: pos.session_type,
        });

        closed++;

      } else if (tp1Hit && pos.status === 'OPEN') {
        // Partial close at TP1 — move to TP1_HIT, move SL to breakeven
        const partialPnl = pnl_usd * 0.5;
        await sb.from('paper_positions').update({
          status:         'TP1_HIT',
          tp1_hit:        true,
          sl_price:       pos.entry_price,  // Move SL to breakeven
          sl_moved_to_be: true,
          partial_pnl_usd: +partialPnl.toFixed(2),
          partial_pnl_r:   +(pnl_r * 0.5).toFixed(3),
          pnl_usd:        +partialPnl.toFixed(2),
          pnl_r:          +(pnl_r * 0.5).toFixed(3),
        }).eq('id', pos.id);

        await updateAccount(partialPnl, true);

        await sb.from('execution_log').insert({
          symbol: pos.symbol, direction: pos.direction,
          action: 'CLOSE_TP1',
          reason: `TP1 hit @ ${currentPrice} | Partial P&L: $${partialPnl.toFixed(2)} | SL moved to BE`,
          position_id: pos.id, entry_price: pos.entry_price,
          session_type: pos.session_type,
        });

        updated++;

      } else {
        // Just update live P&L
        await sb.from('paper_positions').update({ pnl_usd, pnl_r }).eq('id', pos.id);
        updated++;
      }
    }

    // Refresh account equity
    await refreshEquity();

    console.log(`[update-positions] updated=${updated} closed=${closed} symbols=${symbols.join(',')}`);

    return new Response(JSON.stringify({ updated, closed, prices: priceMap }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    console.error('[update-positions] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function updateAccount(pnl_usd: number, isWin: boolean) {
  const { data: acct } = await sb.from('paper_account').select('*').eq('id', 1).single();
  if (!acct) return;

  const newBalance  = +(+acct.balance + pnl_usd).toFixed(2);
  const newEquity   = newBalance;
  const newDailyPnl = +(+acct.daily_pnl_usd + pnl_usd).toFixed(2);
  const newTotal    = (acct.total_trades || 0) + 1;
  const newWins     = (acct.win_trades || 0) + (isWin ? 1 : 0);
  const newLosses   = (acct.loss_trades || 0) + (isWin ? 0 : 1);
  const newPeak     = Math.max(+acct.peak_balance || newBalance, newBalance);
  const newDd       = +((newPeak - newBalance) / newPeak * 100).toFixed(2);

  await sb.from('paper_account').update({
    balance:      newBalance,
    equity:       newEquity,
    daily_pnl_usd: newDailyPnl,
    total_trades: newTotal,
    win_trades:   newWins,
    loss_trades:  newLosses,
    peak_balance: newPeak,
    max_drawdown: Math.max(acct.max_drawdown || 0, newDd),
    win_rate_pct: +((newWins / newTotal) * 100).toFixed(1),
    updated_at:   new Date().toISOString(),
  }).eq('id', 1);
}

async function refreshEquity() {
  const { data: positions } = await sb
    .from('paper_positions')
    .select('pnl_usd')
    .in('status', ['OPEN', 'TP1_HIT']);

  const openPnl = (positions || []).reduce((s: number, p: any) => s + (+p.pnl_usd || 0), 0);

  await sb.from('paper_account').update({
    open_pnl:  +openPnl.toFixed(2),
    updated_at: new Date().toISOString(),
  }).eq('id', 1);
}
