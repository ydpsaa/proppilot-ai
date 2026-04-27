// ═══════════════════════════════════════════════════════════════════════════
// PropPilot AI — calendar Edge Function
// Fetches ForexFactory economic calendar, caches in Supabase,
// returns enriched events with impact, countdown, affected symbols.
//
// Endpoints:
//   GET /calendar                — today's High+Medium events
//   GET /calendar?range=week     — full week
//   GET /calendar?range=tomorrow — tomorrow only
//   GET /calendar?window=30      — events in next N minutes (news block check)
//   GET /calendar?impact=High    — filter by impact
//   GET /calendar?currency=USD   — filter by currency
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2';

const SB_URL  = Deno.env.get('SUPABASE_URL')!;
const SB_SKEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb      = createClient(SB_URL, SB_SKEY, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,apikey,x-proppilot-cron-secret',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── Currency → Symbols mapping ───────────────────────────────────────────────
const CURRENCY_SYMBOLS: Record<string, string[]> = {
  USD: ['XAU/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'NAS100'],
  EUR: ['EUR/USD'],
  GBP: ['GBP/USD'],
  JPY: ['USD/JPY'],
  XAU: ['XAU/USD'],
  BTC: ['BTC/USD'],
  ETH: ['ETH/USD'],
};

function getAffectedSymbols(currency: string): string[] {
  return CURRENCY_SYMBOLS[currency?.toUpperCase()] || [];
}

// ── Fetch from ForexFactory JSON feed ───────────────────────────────────────
interface FFEvent {
  title:    string;
  country:  string;
  date:     string;   // "04-28-2026"  MM-DD-YYYY
  time:     string;   // "8:30am" or "All Day" or "Tentative"
  impact:   string;   // "High" | "Medium" | "Low" | "Non-Economic"
  forecast: string;
  previous: string;
  actual:   string;
}

interface EnrichedEvent {
  id:               string;
  title:            string;
  currency:         string;
  date_iso:         string;  // "2026-04-28"
  datetime_utc:     string | null;
  time_label:       string;
  impact:           'High' | 'Medium' | 'Low' | 'Non-Economic';
  actual:           string;
  forecast:         string;
  previous:         string;
  minutes_until:    number | null;
  affected_symbols: string[];
  is_past:          boolean;
  is_upcoming:      boolean; // within 60 min
  is_imminent:      boolean; // within 15 min
  trading_advice:   string;
}

function parseFFDate(dateStr: string, timeStr: string): string | null {
  // dateStr: "04-28-2026" => ISO "2026-04-28"
  // timeStr: "8:30am", "12:00pm", "All Day", "Tentative"
  try {
    const [mm, dd, yyyy] = dateStr.split('-');
    if (!mm || !dd || !yyyy) return null;

    if (!timeStr || timeStr === 'All Day' || timeStr === 'Tentative') {
      return `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
    }

    // Parse "8:30am" → hours/minutes
    const match = timeStr.match(/^(\d+):(\d+)(am|pm)$/i);
    if (!match) return null;

    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const meridiem = match[3].toLowerCase();

    if (meridiem === 'pm' && hours !== 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;

    // FF times are Eastern Time (ET) = UTC-4 or UTC-5 depending on DST
    // Use UTC-4 (EDT) as default for April-October
    const now = new Date();
    const month = now.getMonth() + 1;
    const offsetHours = (month >= 3 && month <= 10) ? 4 : 5; // EDT vs EST

    const utcHours = hours + offsetHours;
    const hStr = String(utcHours).padStart(2, '0');
    const mStr = String(minutes).padStart(2, '0');

    return `${yyyy}-${mm}-${dd}T${hStr}:${mStr}:00.000Z`;
  } catch {
    return null;
  }
}

function enrichEvent(e: FFEvent): EnrichedEvent {
  const dateIso = e.date
    ? (() => { const [mm, dd, yyyy] = e.date.split('-'); return `${yyyy}-${mm}-${dd}`; })()
    : '';

  const datetimeUtc = parseFFDate(e.date, e.time);
  const now = Date.now();
  const eventMs = datetimeUtc ? new Date(datetimeUtc).getTime() : null;
  const minutesUntil = eventMs != null ? Math.round((eventMs - now) / 60000) : null;
  const isPast = minutesUntil != null ? minutesUntil < -30 : false;
  const isUpcoming = minutesUntil != null ? minutesUntil >= -5 && minutesUntil <= 60 : false;
  const isImminent = minutesUntil != null ? minutesUntil >= -5 && minutesUntil <= 15 : false;

  const impact = e.impact as EnrichedEvent['impact'];
  const affectedSymbols = getAffectedSymbols(e.country);

  let tradingAdvice = '';
  if (impact === 'High' && isImminent) {
    tradingAdvice = `🛑 AVOID — ${e.country} high-impact in ${minutesUntil != null ? Math.max(0, minutesUntil) : '?'}min`;
  } else if (impact === 'High' && isUpcoming) {
    tradingAdvice = `⚠️ Caution — reduce size, ${e.country} high-impact in ${minutesUntil}min`;
  } else if (impact === 'Medium' && isImminent) {
    tradingAdvice = `⚡ Medium impact in ${minutesUntil != null ? Math.max(0, minutesUntil) : '?'}min — stay alert`;
  } else if (isPast && e.actual) {
    tradingAdvice = `✓ Released: ${e.actual} vs ${e.forecast || '—'} forecast`;
  }

  return {
    id:               `${dateIso}-${e.country}-${e.title?.slice(0,20).replace(/\s/g,'-')}`,
    title:            e.title || 'Unknown Event',
    currency:         e.country || '?',
    date_iso:         dateIso,
    datetime_utc:     datetimeUtc,
    time_label:       e.time || '—',
    impact,
    actual:           e.actual || '',
    forecast:         e.forecast || '',
    previous:         e.previous || '',
    minutes_until:    minutesUntil,
    affected_symbols: affectedSymbols,
    is_past:          isPast,
    is_upcoming:      isUpcoming,
    is_imminent:      isImminent,
    trading_advice:   tradingAdvice,
  };
}

// ── Cache: read/write from Supabase ─────────────────────────────────────────
const CACHE_KEY = 'ff_calendar_thisweek';
const CACHE_TTL = 3600; // 1 hour in seconds

async function getCachedEvents(): Promise<EnrichedEvent[] | null> {
  try {
    const { data } = await sb
      .from('calendar_cache')
      .select('events_json, fetched_at')
      .eq('cache_key', CACHE_KEY)
      .single();

    if (!data) return null;
    const age = (Date.now() - new Date(data.fetched_at).getTime()) / 1000;
    if (age > CACHE_TTL) return null;

    return JSON.parse(data.events_json);
  } catch {
    return null;
  }
}

async function setCachedEvents(events: EnrichedEvent[]): Promise<void> {
  try {
    await sb.from('calendar_cache').upsert({
      cache_key:   CACHE_KEY,
      events_json: JSON.stringify(events),
      fetched_at:  new Date().toISOString(),
      event_count: events.length,
    }, { onConflict: 'cache_key' });
  } catch {
    // ignore cache write failures
  }
}

// ── Fetch from FF ────────────────────────────────────────────────────────────
async function fetchFFEvents(): Promise<EnrichedEvent[]> {
  const urls = [
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json?version=9',
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PropPilot/1.0)',
          'Accept': 'application/json',
          'Referer': 'https://www.forexfactory.com/',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const raw: FFEvent[] = await res.json();
      if (!Array.isArray(raw)) continue;

      return raw
        .filter(e => e.impact && ['High', 'Medium', 'Low'].includes(e.impact))
        .map(enrichEvent)
        .sort((a, b) => {
          if (!a.datetime_utc) return 1;
          if (!b.datetime_utc) return -1;
          return a.datetime_utc.localeCompare(b.datetime_utc);
        });
    } catch {
      continue;
    }
  }

  // Fallback: return empty (don't block trading on fetch failure)
  return [];
}

// ── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url    = new URL(req.url);
  const range  = url.searchParams.get('range')    || 'today';   // today|week|tomorrow
  const window = parseInt(url.searchParams.get('window') || '0'); // minutes ahead
  const impact = url.searchParams.get('impact')   || '';         // High|Medium|Low
  const curr   = url.searchParams.get('currency') || '';         // USD|EUR|GBP...
  const forceRefresh = url.searchParams.get('refresh') === 'true';

  // Try cache first
  let allEvents = forceRefresh ? null : await getCachedEvents();

  if (!allEvents) {
    allEvents = await fetchFFEvents();
    if (allEvents.length > 0) {
      await setCachedEvents(allEvents);
    }
  } else {
    // Re-enrich from cache to get fresh countdown values
    // (minutes_until changes every minute, but we serve from cache — re-compute)
    // Actually we store raw FF data separately and re-enrich on read.
    // For now just update the time-sensitive fields:
    allEvents = allEvents.map(e => {
      if (!e.datetime_utc) return e;
      const now = Date.now();
      const eventMs = new Date(e.datetime_utc).getTime();
      const minutesUntil = Math.round((eventMs - now) / 60000);
      const isPast = minutesUntil < -30;
      const isUpcoming = minutesUntil >= -5 && minutesUntil <= 60;
      const isImminent = minutesUntil >= -5 && minutesUntil <= 15;
      let tradingAdvice = '';
      if (e.impact === 'High' && isImminent) {
        tradingAdvice = `🛑 AVOID — ${e.currency} high-impact in ${Math.max(0, minutesUntil)}min`;
      } else if (e.impact === 'High' && isUpcoming) {
        tradingAdvice = `⚠️ Caution — reduce size, ${e.currency} high-impact in ${minutesUntil}min`;
      } else if (e.impact === 'Medium' && isImminent) {
        tradingAdvice = `⚡ Medium impact in ${Math.max(0, minutesUntil)}min — stay alert`;
      } else if (isPast && e.actual) {
        tradingAdvice = `✓ Released: ${e.actual} vs ${e.forecast || '—'} forecast`;
      }
      return { ...e, minutes_until: minutesUntil, is_past: isPast, is_upcoming: isUpcoming, is_imminent: isImminent, trading_advice: tradingAdvice };
    });
  }

  // ── Filter by time range ──
  const nowUtc = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  let filtered = allEvents;

  if (window > 0) {
    // Events in next N minutes (for news block check)
    filtered = allEvents.filter(e =>
      e.minutes_until != null && e.minutes_until >= -5 && e.minutes_until <= window
    );
  } else if (range === 'today') {
    filtered = allEvents.filter(e => e.date_iso === nowUtc);
  } else if (range === 'tomorrow') {
    filtered = allEvents.filter(e => e.date_iso === tomorrow);
  }
  // range === 'week' → return all

  // ── Filter by impact ──
  if (impact) {
    filtered = filtered.filter(e => e.impact === impact);
  }

  // ── Filter by currency ──
  if (curr) {
    filtered = filtered.filter(e => e.currency.toUpperCase() === curr.toUpperCase());
  }

  // ── Compute summary ──
  const highCount      = filtered.filter(e => e.impact === 'High').length;
  const imminentHigh   = filtered.filter(e => e.impact === 'High' && e.is_imminent);
  const upcomingHigh   = filtered.filter(e => e.impact === 'High' && e.is_upcoming && !e.is_imminent);
  const tradingBlocked = imminentHigh.length > 0;

  return json({
    ok:           true,
    range,
    total:        filtered.length,
    high_count:   highCount,
    trading_blocked: tradingBlocked,
    imminent_high:   imminentHigh.map(e => e.currency),
    upcoming_high:   upcomingHigh.map(e => ({ currency: e.currency, minutes: e.minutes_until })),
    cached:       !forceRefresh,
    updated_at:   new Date().toISOString(),
    events:       filtered,
  });
});
