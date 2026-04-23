const TWELVE_DATA_KEY = Deno.env.get('TWELVE_DATA_KEY') || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,apikey',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
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
  SPY: 'SPY',
  QQQ: 'QQQ',
  AAPL: 'AAPL',
  NVDA: 'NVDA',
};

const INTERVALS: Record<string, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '1h',
  '4h': '4h',
  '1day': '1day',
  day: '1day',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function tdSymbol(symbol: string): string {
  const clean = symbol.trim().toUpperCase().replace(/\s/g, '');
  return TD_SYMBOL[clean] || TD_SYMBOL[symbol] || symbol.trim();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!TWELVE_DATA_KEY) return json({ error: 'TWELVE_DATA_KEY is not configured', candles: [] }, 500);

  const url = new URL(req.url);
  const symbol = url.searchParams.get('symbol') || 'XAU/USD';
  const interval = INTERVALS[url.searchParams.get('interval') || '1h'] || '1h';
  const outputsize = Math.min(5000, Math.max(20, Number(url.searchParams.get('outputsize') || 140)));

  const tdUrl = new URL('https://api.twelvedata.com/time_series');
  tdUrl.searchParams.set('symbol', tdSymbol(symbol));
  tdUrl.searchParams.set('interval', interval);
  tdUrl.searchParams.set('outputsize', String(outputsize));
  tdUrl.searchParams.set('apikey', TWELVE_DATA_KEY);
  tdUrl.searchParams.set('format', 'JSON');

  try {
    const res = await fetch(tdUrl, { signal: AbortSignal.timeout(9000) });
    const data = await res.json();
    if (!res.ok || data.status === 'error') {
      return json({ error: data.message || 'Twelve Data request failed', candles: [] }, 502);
    }

    const candles = (Array.isArray(data.values) ? data.values : [])
      .map((v: Record<string, string>) => ({
        t: Date.parse(`${v.datetime}Z`),
        o: Number(v.open),
        h: Number(v.high),
        l: Number(v.low),
        v: Number(v.close),
        vol: Number(v.volume || 0),
      }))
      .filter((c: Record<string, number>) =>
        Number.isFinite(c.t) &&
        Number.isFinite(c.o) &&
        Number.isFinite(c.h) &&
        Number.isFinite(c.l) &&
        Number.isFinite(c.v)
      )
      .sort((a: Record<string, number>, b: Record<string, number>) => a.t - b.t);

    return json({
      symbol,
      sourceSymbol: tdSymbol(symbol),
      interval,
      status: candles.length ? 'live' : 'empty',
      candles,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message, candles: [] }, 500);
  }
});
