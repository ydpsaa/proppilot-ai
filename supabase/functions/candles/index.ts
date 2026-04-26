const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,apikey',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

const YF_SYMBOL: Record<string, string> = {
  XAUUSD: 'GC=F',
  'XAU/USD': 'GC=F',
  GOLD: 'GC=F',
  EURUSD: 'EURUSD=X',
  'EUR/USD': 'EURUSD=X',
  GBPUSD: 'GBPUSD=X',
  'GBP/USD': 'GBPUSD=X',
  USDJPY: 'USDJPY=X',
  'USD/JPY': 'USDJPY=X',
  GBPJPY: 'GBPJPY=X',
  'GBP/JPY': 'GBPJPY=X',
  BTCUSDT: 'BTC-USD',
  BTCUSD: 'BTC-USD',
  'BTC/USD': 'BTC-USD',
  ETHUSDT: 'ETH-USD',
  ETHUSD: 'ETH-USD',
  'ETH/USD': 'ETH-USD',
  NAS100: '^NDX',
  US100: '^NDX',
  NDX: '^NDX',
  SPY: 'SPY',
  QQQ: 'QQQ',
  AAPL: 'AAPL',
  NVDA: 'NVDA',
};

const INTERVALS: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '1h',
  '1day': '1d',
  day: '1d',
};

const RANGES: Record<string, string> = {
  '1m': '1d',
  '5m': '5d',
  '15m': '5d',
  '30m': '5d',
  '1h': '30d',
  '1d': '1y',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function yfSymbol(symbol: string): string {
  const clean = symbol.trim().toUpperCase().replace(/\s/g, '');
  return YF_SYMBOL[clean] || YF_SYMBOL[symbol] || symbol.trim();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);
  const symbol = url.searchParams.get('symbol') || 'XAU/USD';
  const interval = INTERVALS[url.searchParams.get('interval') || '1h'] || '1h';
  const outputsize = Math.min(5000, Math.max(20, Number(url.searchParams.get('outputsize') || 140)));

  const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSymbol(symbol))}?interval=${interval}&range=${RANGES[interval] || '30d'}&includePrePost=false`;

  try {
    const res = await fetch(yfUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return json({ error: `Yahoo Finance HTTP ${res.status}`, candles: [] }, 502);
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp || [];
    const quote = result?.indicators?.quote?.[0] || {};
    const opens: number[] = quote.open || [];
    const highs: number[] = quote.high || [];
    const lows: number[] = quote.low || [];
    const closes: number[] = quote.close || [];
    const volumes: number[] = quote.volume || [];

    const candles = timestamps
      .map((ts, i) => ({
        t: ts * 1000,
        o: Number(opens[i]),
        h: Number(highs[i]),
        l: Number(lows[i]),
        v: Number(closes[i]),
        vol: Number(volumes[i] || 0),
      }))
      .filter((c: Record<string, number>) =>
        Number.isFinite(c.t) &&
        Number.isFinite(c.o) &&
        Number.isFinite(c.h) &&
        Number.isFinite(c.l) &&
        Number.isFinite(c.v)
      )
      .slice(-outputsize)
      .sort((a: Record<string, number>, b: Record<string, number>) => a.t - b.t);

    return json({
      symbol,
      sourceSymbol: yfSymbol(symbol),
      interval,
      source: 'yahoo_finance',
      status: candles.length ? 'live' : 'empty',
      candles,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message, candles: [] }, 500);
  }
});
