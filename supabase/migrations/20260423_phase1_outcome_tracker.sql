-- PropPilot AI - Phase 1 outcome tracker and analytics.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.signal_analyses (
  id             bigserial PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  symbol         text NOT NULL,
  timeframe      text NOT NULL DEFAULT '1h',
  signal_state   text NOT NULL DEFAULT 'NO_TRADE'
    CHECK (signal_state IN (
      'LONG_NOW','SHORT_NOW','WAIT_LONG','WAIT_SHORT',
      'WAIT_BREAK','AVOID_NEWS','AVOID_CHOP','NO_TRADE'
    )),
  direction      text CHECK (direction IN ('LONG','SHORT')),
  confidence     numeric(5,2) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),

  price          numeric(20,8),
  atr            numeric(20,8),
  rsi            numeric(8,4),
  ema20          numeric(20,8),
  ema50          numeric(20,8),
  ema200         numeric(20,8),
  bb_pct_b       numeric(8,5),
  bb_squeeze     boolean NOT NULL DEFAULT false,
  vwap           numeric(20,8),
  swing_high     numeric(20,8),
  swing_low      numeric(20,8),
  bull_score     numeric(8,3),
  bear_score     numeric(8,3),
  net_score      numeric(8,3),

  session_name   text,
  has_high_news  boolean NOT NULL DEFAULT false,
  has_med_news   boolean NOT NULL DEFAULT false,

  entry_lo       numeric(20,8),
  entry_hi       numeric(20,8),
  sl             numeric(20,8),
  tp1            numeric(20,8),
  tp2            numeric(20,8),
  rr_tp1         numeric(8,3),
  rr_tp2         numeric(8,3),

  rationale      text,
  trigger_text   text,
  invalidation   text,
  raw_signal     jsonb,

  outcome        text NOT NULL DEFAULT 'OPEN'
    CHECK (outcome IN ('OPEN','TP1_HIT','TP2_HIT','SL_HIT','EXPIRED','CANCELLED')),
  outcome_price  numeric(20,8),
  pnl_r          numeric(8,3),
  mfe_r          numeric(8,3),
  mae_r          numeric(8,3),
  outcome_at     timestamptz,
  checked_at     timestamptz,
  check_count    integer NOT NULL DEFAULT 0,
  outcome_source text,
  error_log      text
);

CREATE INDEX IF NOT EXISTS idx_signal_analyses_open
  ON public.signal_analyses (created_at, symbol)
  WHERE outcome = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_signal_analyses_symbol_time
  ON public.signal_analyses (symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_analyses_outcome
  ON public.signal_analyses (outcome, outcome_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_analyses_setup
  ON public.signal_analyses (symbol, signal_state, session_name, timeframe);

CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_analyses_source_unique
  ON public.signal_analyses (created_at, symbol, timeframe, signal_state);

DROP TRIGGER IF EXISTS trg_signal_analyses_updated_at ON public.signal_analyses;
CREATE TRIGGER trg_signal_analyses_updated_at
BEFORE UPDATE ON public.signal_analyses
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.strategy_stats (
  id              bigserial PRIMARY KEY,
  calculated_at   timestamptz NOT NULL DEFAULT now(),
  symbol          text NOT NULL,
  signal_state    text NOT NULL,
  session_name    text NOT NULL,
  timeframe       text NOT NULL,
  total_signals   integer NOT NULL DEFAULT 0,
  open_signals    integer NOT NULL DEFAULT 0,
  wins            integer NOT NULL DEFAULT 0,
  losses          integer NOT NULL DEFAULT 0,
  expired         integer NOT NULL DEFAULT 0,
  win_rate        numeric(8,5) NOT NULL DEFAULT 0,
  avg_win_r       numeric(8,3),
  avg_loss_r      numeric(8,3),
  avg_pnl_r       numeric(8,3),
  expectancy      numeric(8,4) NOT NULL DEFAULT 0,
  profit_factor   numeric(10,4),
  avg_mfe         numeric(8,3),
  avg_mae         numeric(8,3),
  avg_confidence  numeric(8,3),
  best_hour       integer CHECK (best_hour BETWEEN 0 AND 23),
  sample_start    timestamptz,
  sample_end      timestamptz,
  UNIQUE (symbol, signal_state, session_name, timeframe)
);

CREATE INDEX IF NOT EXISTS idx_strategy_stats_expectancy
  ON public.strategy_stats (expectancy DESC, total_signals DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_stats_calculated
  ON public.strategy_stats (calculated_at DESC);

ALTER TABLE public.signal_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategy_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read signal_analyses" ON public.signal_analyses;
DROP POLICY IF EXISTS "Public insert signal_analyses" ON public.signal_analyses;
CREATE POLICY "Public read signal_analyses"
  ON public.signal_analyses FOR SELECT USING (true);
CREATE POLICY "Public insert signal_analyses"
  ON public.signal_analyses FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Public read strategy_stats" ON public.strategy_stats;
CREATE POLICY "Public read strategy_stats"
  ON public.strategy_stats FOR SELECT USING (true);

CREATE OR REPLACE VIEW public.v_analytics_signals AS
SELECT
  id,
  created_at,
  updated_at,
  symbol,
  timeframe,
  signal_state,
  COALESCE(direction,
    CASE
      WHEN signal_state IN ('LONG_NOW','WAIT_LONG') THEN 'LONG'
      WHEN signal_state IN ('SHORT_NOW','WAIT_SHORT') THEN 'SHORT'
      ELSE NULL
    END
  ) AS direction,
  confidence,
  price,
  atr,
  rsi,
  ema20,
  ema50,
  ema200,
  bb_pct_b,
  bb_squeeze,
  vwap,
  swing_high,
  swing_low,
  bull_score,
  bear_score,
  net_score,
  COALESCE(session_name, 'Unknown') AS session_name,
  has_high_news,
  has_med_news,
  entry_lo,
  entry_hi,
  sl,
  tp1,
  tp2,
  rr_tp1,
  rr_tp2,
  rationale,
  trigger_text,
  invalidation,
  outcome,
  outcome_price,
  pnl_r,
  mfe_r,
  mae_r,
  outcome_at,
  checked_at,
  check_count
FROM public.signal_analyses;

INSERT INTO public.signal_analyses (
  created_at,
  updated_at,
  symbol,
  timeframe,
  signal_state,
  direction,
  confidence,
  price,
  atr,
  session_name,
  entry_lo,
  entry_hi,
  sl,
  tp1,
  tp2,
  rr_tp1,
  rr_tp2,
  rationale,
  invalidation,
  raw_signal,
  outcome,
  outcome_price,
  pnl_r,
  outcome_at,
  outcome_source
)
SELECT
  s.created_at,
  COALESCE(s.outcome_at, s.created_at),
  s.symbol,
  s.timeframe,
  s.verdict,
  CASE
    WHEN s.verdict IN ('LONG_NOW','WAIT_LONG') THEN 'LONG'
    WHEN s.verdict IN ('SHORT_NOW','WAIT_SHORT') THEN 'SHORT'
    ELSE NULL
  END,
  s.confidence,
  s.entry_price,
  s.atr,
  COALESCE(s.session_name, s.session_ctx),
  s.ote_zone_lo,
  s.ote_zone_hi,
  s.sl_price,
  s.tp1_price,
  s.tp2_price,
  s.risk_reward,
  s.risk_reward,
  s.ai_narrative,
  s.invalidation,
  s.signal_json,
  CASE
    WHEN s.outcome = 'tp1_hit' THEN 'TP1_HIT'
    WHEN s.outcome = 'tp2_hit' THEN 'TP2_HIT'
    WHEN s.outcome = 'sl_hit' THEN 'SL_HIT'
    WHEN s.outcome = 'expired' THEN 'EXPIRED'
    WHEN s.outcome = 'cancelled' THEN 'CANCELLED'
    ELSE 'OPEN'
  END,
  s.outcome_price,
  s.outcome_pnl_r,
  s.outcome_at,
  'smc_signals_backfill'
FROM public.smc_signals s
WHERE NOT EXISTS (
  SELECT 1
  FROM public.signal_analyses a
  WHERE a.created_at = s.created_at
    AND a.symbol = s.symbol
    AND a.timeframe = s.timeframe
    AND a.signal_state = s.verdict
);

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN ('update-outcomes-hourly', 'update-strategy-stats-daily')
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'update-outcomes-hourly',
  '5 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/update-outcomes',
      headers := '{"Content-Type":"application/json"}'::jsonb,
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
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{"source":"pg_cron"}'::jsonb
    );
  $$
);
