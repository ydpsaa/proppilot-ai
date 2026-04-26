// ═══════════════════════════════════════════════════════════════════════════
// PropPilot AI — market-data Edge Function
// Proxies Yahoo Finance (free, no key, no rate limit) for OHLCV + live prices.
// Replaces TwelveData dependency entirely.
//
// GET /market-data?type=ohlcv&symbol=XAU/USD&interval=1h&bars=200
// GET /market-data?type=price&symbol=XAU/USD,EUR/USD,GBP/USD
// ═══════════════════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,apikey',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json',
};

// ── Yahoo Finance symbol mapping ─────────────────────────────────────────────
const YF_SYM: Record<string, string> = {
  'XAU/USD': 'GC=F',       // Gold futures (best proxy for spot)
  'XAG/USD': 'SI=F',       // Silver futures
  'EUR/USD': 'EURUSD=X',
  'GBP/USD': 'GBPUSD=X',
  'USD/JPY': 'USDJPY=X',
  'GBP/JPY': 'GBPJPY=X',
  'AUD/USD': 'AUDUSD=X',
  'USD/CAD': 'USDCAD=X',
  'NAS100':  '^NDX',        // Nasdaq 100 index
  'US30':    '^DJI',        // Dow Jones
  'US500':   '^GSPC',       // S&P 500
  'BTC/USD': 'BTC-USD',
  'ETH/USD': 'ETH-USD',
};

// ── Interval mapping: app → Yahoo Finance ────────────────────────────────────
const YF_INTERVAL: Record<string, { interval: string; range: string }> = {
  '15min': { interval: '15m', range: '5d'  },
  '1h':    { interval: '1h',  range: '30d' },
  '4h':    { interval: '1h',  range: '30d' }, // Yahoo doesn't have 4h; use 1h
  '1d':    { interval: '1d',  range: '1y'  },
};

async function fetchOHLCV(sym: string, interval: string, bars: number) {
  const yfSym = YF_SYM[sym];
  if (!yfSym) throw new Error(`Unknown symbol: ${sym}`);

  const iv = YF_INTERVAL[interval] || YF_INTERVAL['1h'];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=${iv.interval}&range=${iv.range}&includePrePost=false`;

  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
    },
  });

  if (!r.ok) throw new Error(`Yahoo Finance HTTP ${r.status}`);
  const json = await r.json();

  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('No chart data returned');

  const timestamps: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const opens:   number[] = quote.open   || [];
  const highs:   number[] = quote.high   || [];
  const lows:    number[] = quote.low    || [];
  const closes:  number[] = quote.close  || [];

  // Build candles array, filter nulls, take last N bars
  const candles = timestamps
    .map((ts, i) => ({
      t: new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' '),
      o: opens[i],
      h: highs[i],
      l: lows[i],
      v: closes[i],
    }))
    .filter(c => c.v != null && c.h != null && c.l != null)
    .slice(-bars);

  if (candles.length < 20) throw new Error('Insufficient candle data');

  return {
    symbol: sym,
    interval,
    candles,
    lastPrice: candles[candles.length - 1].v,
    source: 'yahoo_finance',
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchPrices(symbols: string[]) {
  const results: Record<string, number | null> = {};

  await Promise.allSettled(symbols.map(async sym => {
    const yfSym = YF_SYM[sym];
    if (!yfSym) { results[sym] = null; return; }

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=1m&range=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!r.ok) { results[sym] = null; return; }

    const json = await r.json();
    const meta = json?.chart?.result?.[0]?.meta;
    results[sym] = meta?.regularMarketPrice ?? meta?.previousClose ?? null;
  }));

  return results;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url    = new URL(req.url);
  const type   = url.searchParams.get('type') || 'ohlcv';
  const sym    = url.searchParams.get('symbol') || 'XAU/USD';
  const tf     = url.searchParams.get('interval') || '1h';
  const bars   = parseInt(url.searchParams.get('bars') || '200', 10);

  try {
    if (type === 'price') {
      const syms = sym.split(',').map(s => s.trim());
      const prices = await fetchPrices(syms);
      return new Response(JSON.stringify({ prices, source: 'yahoo_finance' }), { headers: CORS });
    }

    // Default: OHLCV
    const data = await fetchOHLCV(sym, tf, bars);
    return new Response(JSON.stringify(data), { headers: CORS });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: CORS }
    );
  }
});
