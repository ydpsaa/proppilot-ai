-- PropPilot AI — protected pg_cron jobs for Edge Functions
--
-- Before running this migration, set the same long random value in both places:
--
--   supabase secrets set PROPILOT_CRON_SECRET=<long_random_value>
--
--   ALTER DATABASE postgres SET "app.proppilot_cron_secret" = '<long_random_value>';
--   SELECT set_config('app.proppilot_cron_secret', '<long_random_value>', false);
--
-- The ALTER DATABASE line persists the setting for future cron runs. The
-- set_config line makes it available immediately in the current SQL session.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
DECLARE
  missing_secret boolean;
BEGIN
  missing_secret := nullif(current_setting('app.proppilot_cron_secret', true), '') IS NULL;
  IF missing_secret THEN
    RAISE EXCEPTION 'Missing app.proppilot_cron_secret. Set it before scheduling protected jobs.';
  END IF;
END;
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN (
      'auto-analyze-london',
      'auto-analyze-overlap',
      'auto-analyze-newyork',
      'auto-analyze-asia',
      'auto-analyze-frankfurt',
      'update-outcomes-hourly',
      'update-strategy-stats-daily',
      'update-stats-daily',
      'update-positions-5min',
      'daily-reset-tracking'
    )
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'auto-analyze-asia',
  '0 0 * * 1-5',
  $$
    SELECT net.http_post(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/auto-analyze',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proppilot-cron-secret', current_setting('app.proppilot_cron_secret', true)
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
        'x-proppilot-cron-secret', current_setting('app.proppilot_cron_secret', true)
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
        'x-proppilot-cron-secret', current_setting('app.proppilot_cron_secret', true)
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
        'x-proppilot-cron-secret', current_setting('app.proppilot_cron_secret', true)
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
        'x-proppilot-cron-secret', current_setting('app.proppilot_cron_secret', true)
      ),
      body := '{"source":"pg_cron","session":"newyork"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'update-positions-5min',
  '*/5 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/update-paper-positions',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proppilot-cron-secret', current_setting('app.proppilot_cron_secret', true)
      ),
      body := '{"source":"pg_cron"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'update-outcomes-hourly',
  '5 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/update-outcomes',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proppilot-cron-secret', current_setting('app.proppilot_cron_secret', true)
      ),
      body := '{"source":"pg_cron"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'update-strategy-stats-daily',
  '10 0 * * *',
  $$
    SELECT net.http_post(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/update-strategy-stats',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proppilot-cron-secret', current_setting('app.proppilot_cron_secret', true)
      ),
      body := '{"source":"pg_cron"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'daily-reset-tracking',
  '1 0 * * *',
  $$SELECT reset_daily_tracking()$$
);
