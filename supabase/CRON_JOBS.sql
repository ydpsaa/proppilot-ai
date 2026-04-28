-- ═══════════════════════════════════════════════════════════════════════════
-- PropPilot AI — pg_cron Scheduled Jobs
--
-- Run this AFTER:
--   1. Applying MIGRATION_COMPLETE.sql (all tables/views/functions)
--   2. Enabling pg_cron in: Dashboard → Database → Extensions → pg_cron
--
-- The cron secret is embedded below. Keep this file private.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Remove old jobs if re-running ────────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT jobid FROM cron.job
    WHERE jobname IN (
      'auto-analyze-london', 'auto-analyze-overlap', 'auto-analyze-newyork',
      'auto-analyze-asia', 'auto-analyze-frankfurt',
      'update-outcomes-hourly', 'update-strategy-stats-daily',
      'update-positions-5min', 'daily-reset-tracking',
      'refresh-calendar', 'update-outcomes-hourly', 'update-strategy-stats-daily'
    )
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
END;
$$;

-- ── 1. Trading session analysis ───────────────────────────────────────────────

SELECT cron.schedule(
  'auto-analyze-asia',
  '0 0 * * 1-5',
  $$
    SELECT net.http_post(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/auto-analyze',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proppilot-cron-secret', 'b02104dfbd7cc87ddb2f2b561aa9863050063f77b586810e3d6cb8a503e7e0b2'
      ),
      body := '{"source":"pg_cron","session":"asia"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'auto-analyze-frankfurt',
  '0 7 * * 1-5',
  $$
    SELECT net.http_post(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/auto-analyze',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proppilot-cron-secret', 'b02104dfbd7cc87ddb2f2b561aa9863050063f77b586810e3d6cb8a503e7e0b2'
      ),
      body := '{"source":"pg_cron","session":"frankfurt"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'auto-analyze-london',
  '0 8 * * 1-5',
  $$
    SELECT net.http_post(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/auto-analyze',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proppilot-cron-secret', 'b02104dfbd7cc87ddb2f2b561aa9863050063f77b586810e3d6cb8a503e7e0b2'
      ),
      body := '{"source":"pg_cron","session":"london"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'auto-analyze-overlap',
  '0 12 * * 1-5',
  $$
    SELECT net.http_post(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/auto-analyze',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proppilot-cron-secret', 'b02104dfbd7cc87ddb2f2b561aa9863050063f77b586810e3d6cb8a503e7e0b2'
      ),
      body := '{"source":"pg_cron","session":"overlap"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'auto-analyze-newyork',
  '0 17 * * 1-5',
  $$
    SELECT net.http_post(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/auto-analyze',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proppilot-cron-secret', 'b02104dfbd7cc87ddb2f2b561aa9863050063f77b586810e3d6cb8a503e7e0b2'
      ),
      body := '{"source":"pg_cron","session":"newyork"}'::jsonb
    );
  $$
);

-- ── 2. Position manager every 5 min ──────────────────────────────────────────
SELECT cron.schedule(
  'update-positions-5min',
  '*/5 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/update-paper-positions',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proppilot-cron-secret', 'b02104dfbd7cc87ddb2f2b561aa9863050063f77b586810e3d6cb8a503e7e0b2'
      ),
      body := '{"source":"pg_cron"}'::jsonb
    );
  $$
);

-- ── 3. Outcome tracker hourly ─────────────────────────────────────────────────
SELECT cron.schedule(
  'update-outcomes-hourly',
  '5 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/update-outcomes',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proppilot-cron-secret', 'b02104dfbd7cc87ddb2f2b561aa9863050063f77b586810e3d6cb8a503e7e0b2'
      ),
      body := '{"source":"pg_cron"}'::jsonb
    );
  $$
);

-- ── 4. Strategy stats daily ───────────────────────────────────────────────────
SELECT cron.schedule(
  'update-strategy-stats-daily',
  '10 0 * * *',
  $$
    SELECT net.http_post(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/update-strategy-stats',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proppilot-cron-secret', 'b02104dfbd7cc87ddb2f2b561aa9863050063f77b586810e3d6cb8a503e7e0b2'
      ),
      body := '{"source":"pg_cron"}'::jsonb
    );
  $$
);

-- ── 5. Daily account reset at 00:01 UTC ──────────────────────────────────────
SELECT cron.schedule(
  'daily-reset-tracking',
  '1 0 * * *',
  $$SELECT reset_daily_tracking()$$
);

-- ── 6. Economic calendar refresh every 30 min on weekdays ────────────────────
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

-- ── Verify all jobs were created ─────────────────────────────────────────────
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
