-- ═══════════════════════════════════════════════════════════════════════════
-- PropPilot AI — Calendar cache + economic events
-- Run in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. calendar_cache — stores the full FF weekly JSON ─────────────────────
CREATE TABLE IF NOT EXISTS public.calendar_cache (
  cache_key   TEXT PRIMARY KEY,
  events_json TEXT NOT NULL DEFAULT '[]',
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_count INT NOT NULL DEFAULT 0
);

ALTER TABLE public.calendar_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read calendar_cache" ON public.calendar_cache;
CREATE POLICY "Public read calendar_cache"
  ON public.calendar_cache FOR SELECT USING (true);

-- ── 2. economic_events — individual events cache ────────────────────────────
CREATE TABLE IF NOT EXISTS public.economic_events (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  currency        TEXT NOT NULL,
  date_iso        TEXT NOT NULL,
  datetime_utc    TIMESTAMPTZ,
  time_label      TEXT,
  impact          TEXT NOT NULL CHECK (impact IN ('High','Medium','Low','Non-Economic')),
  actual          TEXT DEFAULT '',
  forecast        TEXT DEFAULT '',
  previous        TEXT DEFAULT '',
  affected_symbols TEXT[] DEFAULT '{}',
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_economic_events_date
  ON public.economic_events (date_iso, impact);
CREATE INDEX IF NOT EXISTS idx_economic_events_datetime
  ON public.economic_events (datetime_utc, impact);
CREATE INDEX IF NOT EXISTS idx_economic_events_currency
  ON public.economic_events (currency, date_iso);

ALTER TABLE public.economic_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read economic_events" ON public.economic_events;
CREATE POLICY "Public read economic_events"
  ON public.economic_events FOR SELECT USING (true);

-- ── 3. Refresh calendar_cache periodically via pg_cron ──────────────────────
-- Runs every 30 minutes during market hours to keep data fresh
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid FROM cron.job WHERE jobname = 'refresh-calendar' LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'refresh-calendar',
  '*/30 6-22 * * 1-5',
  $$
    SELECT net.http_get(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/calendar?refresh=true',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proppilot-cron-secret', 'b02104dfbd7cc87ddb2f2b561aa9863050063f77b586810e3d6cb8a503e7e0b2'
      )
    );
  $$
);
