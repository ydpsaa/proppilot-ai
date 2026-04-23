-- ═══════════════════════════════════════════════════════════════════════════
-- PropPilot AI — ПОЛНАЯ МИГРАЦИЯ (запустить один раз в Supabase SQL Editor)
-- https://supabase.com/dashboard/project/nxiednydxyrtxpkmgtof/sql/new
-- ═══════════════════════════════════════════════════════════════════════════

-- EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Helper trigger function ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 1: paper_account (singleton row id=1)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS paper_account (
  id                   INT PRIMARY KEY DEFAULT 1,
  balance              NUMERIC(14,2) NOT NULL DEFAULT 100000,
  equity               NUMERIC(14,2) NOT NULL DEFAULT 100000,
  open_pnl             NUMERIC(12,2) NOT NULL DEFAULT 0,
  peak_balance         NUMERIC(14,2) NOT NULL DEFAULT 100000,
  max_drawdown         NUMERIC(6,2)  NOT NULL DEFAULT 0,
  max_drawdown_pct     NUMERIC(6,2)  NOT NULL DEFAULT 0,
  total_trades         INT           NOT NULL DEFAULT 0,
  win_trades           INT           NOT NULL DEFAULT 0,
  loss_trades          INT           NOT NULL DEFAULT 0,
  daily_wins           INT           NOT NULL DEFAULT 0,
  daily_losses         INT           NOT NULL DEFAULT 0,
  win_rate_pct         NUMERIC(5,1),
  avg_pnl_r            NUMERIC(6,3),
  profit_factor        NUMERIC(6,2),
  daily_pnl_usd        NUMERIC(12,2) NOT NULL DEFAULT 0,
  daily_start_balance  NUMERIC(12,2) NOT NULL DEFAULT 100000,
  daily_trades         INT           NOT NULL DEFAULT 0,
  kill_switch_active   BOOLEAN       NOT NULL DEFAULT FALSE,
  kill_switch_reason   TEXT,
  kill_switch_at       TIMESTAMPTZ,
  day_date             DATE          NOT NULL DEFAULT CURRENT_DATE,
  session_count        INT           NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
INSERT INTO paper_account (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 2: paper_positions
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS paper_positions (
  id                  BIGSERIAL PRIMARY KEY,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at           TIMESTAMPTZ,
  symbol              TEXT        NOT NULL,
  direction           TEXT        NOT NULL CHECK (direction IN ('LONG','SHORT')),
  status              TEXT        NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','TP1_HIT','TP2_HIT','SL_HIT','MANUAL_CLOSE','EXPIRED','KILL_SWITCH')),
  entry_price         NUMERIC(20,8) NOT NULL,
  sl_price            NUMERIC(20,8),
  tp1_price           NUMERIC(20,8),
  tp2_price           NUMERIC(20,8),
  close_price         NUMERIC(20,8),
  current_price       NUMERIC(20,8),
  lot_size            NUMERIC(8,4)  DEFAULT 0.01,
  risk_usd            NUMERIC(10,2) DEFAULT 1000,
  size_usd            NUMERIC(12,2) DEFAULT 1000,
  sl_orig             NUMERIC(20,8),
  sl_moved_to_be      BOOLEAN       NOT NULL DEFAULT FALSE,
  trailing_activated  BOOLEAN       NOT NULL DEFAULT FALSE,
  pnl_usd             NUMERIC(10,2),
  pnl_r               NUMERIC(6,3),
  partial_pnl_usd     NUMERIC(10,2) DEFAULT 0,
  partial_pnl_r       NUMERIC(6,3)  DEFAULT 0,
  tp1_hit             BOOLEAN       NOT NULL DEFAULT FALSE,
  mfe                 NUMERIC(6,3),
  mae                 NUMERIC(6,3),
  confidence          INT,
  session_type        TEXT,
  signal_id           BIGINT,
  notes               TEXT
);
CREATE INDEX IF NOT EXISTS idx_paper_positions_status ON paper_positions (status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_positions_symbol ON paper_positions (symbol, opened_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 3: bot_settings (singleton row id=1)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bot_settings (
  id                   INT PRIMARY KEY DEFAULT 1,
  is_paused            BOOLEAN       NOT NULL DEFAULT FALSE,
  risk_pct             NUMERIC(4,2)  NOT NULL DEFAULT 1.0,
  daily_loss_limit_pct NUMERIC(4,2)  NOT NULL DEFAULT 2.0,
  max_open_positions   INT           NOT NULL DEFAULT 3,
  confidence_threshold INT           NOT NULL DEFAULT 70,
  trailing_atr_mult    NUMERIC(3,1)  NOT NULL DEFAULT 1.5,
  partial_close_pct    INT           NOT NULL DEFAULT 50,
  tp1_mult             NUMERIC(4,2)  NOT NULL DEFAULT 2.2,
  tp2_mult             NUMERIC(4,2)  NOT NULL DEFAULT 3.6,
  sl_mult              NUMERIC(4,2)  NOT NULL DEFAULT 1.4,
  allowed_sessions     TEXT[]        NOT NULL DEFAULT '{"London","Overlap","NewYork"}',
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
INSERT INTO bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 4: bot_memory (AI session summaries)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bot_memory (
  id                BIGSERIAL PRIMARY KEY,
  run_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_type      TEXT,
  signals_found     JSONB       NOT NULL DEFAULT '[]',
  trades_placed     JSONB       NOT NULL DEFAULT '[]',
  market_notes      TEXT,
  lessons_learned   TEXT,
  next_watch_levels JSONB       NOT NULL DEFAULT '{}',
  signals_saved     INT         NOT NULL DEFAULT 0,
  duration_ms       INT         NOT NULL DEFAULT 0,
  error_log         TEXT
);
CREATE INDEX IF NOT EXISTS idx_bot_memory_run_at ON bot_memory (run_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 5: smc_signals (daemon + auto-analyze writes here)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS smc_signals (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  symbol           TEXT          NOT NULL,
  timeframe        TEXT          NOT NULL DEFAULT 'm15',
  verdict          TEXT          NOT NULL DEFAULT 'NO_TRADE'
    CHECK (verdict IN ('LONG_NOW','SHORT_NOW','WAIT_LONG','WAIT_SHORT','NO_TRADE')),
  confidence       NUMERIC(5,2)  NOT NULL DEFAULT 0,
  direction        TEXT          CHECK (direction IN ('LONG','SHORT')),
  entry_price      NUMERIC(20,8),
  sl_price         NUMERIC(20,8),
  tp1_price        NUMERIC(20,8),
  tp2_price        NUMERIC(20,8),
  risk_reward      NUMERIC(8,3),
  atr              NUMERIC(20,8),
  session_name     TEXT,
  session_ctx      TEXT,
  htf_trend        TEXT          DEFAULT 'NEUTRAL',
  sweep_occurred   BOOLEAN       NOT NULL DEFAULT FALSE,
  mss_occurred     BOOLEAN       NOT NULL DEFAULT FALSE,
  displacement     BOOLEAN       NOT NULL DEFAULT FALSE,
  reasoning_codes  TEXT[],
  signal_json      JSONB,
  ai_narrative     TEXT,
  invalidation     TEXT,
  data_status      TEXT          DEFAULT 'live',
  -- Outcome tracking
  outcome          TEXT          CHECK (outcome IN ('tp1_hit','tp2_hit','sl_hit','expired','cancelled')),
  outcome_price    NUMERIC(20,8),
  outcome_pnl_r    NUMERIC(8,3),
  outcome_at       TIMESTAMPTZ,
  -- OTE zone (from daemon)
  ote_zone_lo      NUMERIC(20,8),
  ote_zone_hi      NUMERIC(20,8)
);
CREATE INDEX IF NOT EXISTS idx_smc_signals_created  ON smc_signals (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_smc_signals_symbol   ON smc_signals (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_smc_signals_verdict  ON smc_signals (verdict, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_smc_signals_outcome  ON smc_signals (outcome, outcome_at DESC);

DROP TRIGGER IF EXISTS trg_smc_signals_updated_at ON smc_signals;
CREATE TRIGGER trg_smc_signals_updated_at
BEFORE UPDATE ON smc_signals
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 6: signal_analyses (update-outcomes reads/writes, analytics reads)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.signal_analyses (
  id             BIGSERIAL PRIMARY KEY,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  symbol         TEXT          NOT NULL,
  timeframe      TEXT          NOT NULL DEFAULT '1h',
  signal_state   TEXT          NOT NULL DEFAULT 'NO_TRADE'
    CHECK (signal_state IN ('LONG_NOW','SHORT_NOW','WAIT_LONG','WAIT_SHORT',
                            'WAIT_BREAK','AVOID_NEWS','AVOID_CHOP','NO_TRADE')),
  direction      TEXT          CHECK (direction IN ('LONG','SHORT')),
  confidence     NUMERIC(5,2)  NOT NULL DEFAULT 0,
  price          NUMERIC(20,8),
  atr            NUMERIC(20,8),
  rsi            NUMERIC(8,4),
  ema20          NUMERIC(20,8),
  ema50          NUMERIC(20,8),
  ema200         NUMERIC(20,8),
  session_name   TEXT,
  entry_lo       NUMERIC(20,8),
  entry_hi       NUMERIC(20,8),
  sl             NUMERIC(20,8),
  tp1            NUMERIC(20,8),
  tp2            NUMERIC(20,8),
  rr_tp1         NUMERIC(8,3),
  rr_tp2         NUMERIC(8,3),
  rationale      TEXT,
  invalidation   TEXT,
  raw_signal     JSONB,
  outcome        TEXT          NOT NULL DEFAULT 'OPEN'
    CHECK (outcome IN ('OPEN','TP1_HIT','TP2_HIT','SL_HIT','EXPIRED','CANCELLED')),
  outcome_price  NUMERIC(20,8),
  pnl_r          NUMERIC(8,3),
  mfe_r          NUMERIC(8,3),
  mae_r          NUMERIC(8,3),
  outcome_at     TIMESTAMPTZ,
  checked_at     TIMESTAMPTZ,
  check_count    INTEGER       NOT NULL DEFAULT 0,
  outcome_source TEXT,
  error_log      TEXT,
  UNIQUE (created_at, symbol, timeframe, signal_state)
);
CREATE INDEX IF NOT EXISTS idx_signal_analyses_open    ON public.signal_analyses (created_at, symbol) WHERE outcome = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_signal_analyses_symbol  ON public.signal_analyses (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_analyses_outcome ON public.signal_analyses (outcome, outcome_at DESC);

DROP TRIGGER IF EXISTS trg_signal_analyses_updated_at ON public.signal_analyses;
CREATE TRIGGER trg_signal_analyses_updated_at
BEFORE UPDATE ON public.signal_analyses
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 7: strategy_stats (update-strategy-stats writes, analytics reads)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.strategy_stats (
  id              BIGSERIAL PRIMARY KEY,
  calculated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  symbol          TEXT        NOT NULL,
  signal_state    TEXT        NOT NULL,
  session_name    TEXT        NOT NULL,
  timeframe       TEXT        NOT NULL,
  total_signals   INTEGER     NOT NULL DEFAULT 0,
  open_signals    INTEGER     NOT NULL DEFAULT 0,
  wins            INTEGER     NOT NULL DEFAULT 0,
  losses          INTEGER     NOT NULL DEFAULT 0,
  expired         INTEGER     NOT NULL DEFAULT 0,
  win_rate        NUMERIC(8,5) NOT NULL DEFAULT 0,
  avg_win_r       NUMERIC(8,3),
  avg_loss_r      NUMERIC(8,3),
  avg_pnl_r       NUMERIC(8,3),
  expectancy      NUMERIC(8,4) NOT NULL DEFAULT 0,
  profit_factor   NUMERIC(10,4),
  avg_mfe         NUMERIC(8,3),
  avg_mae         NUMERIC(8,3),
  avg_confidence  NUMERIC(8,3),
  best_hour       INTEGER      CHECK (best_hour BETWEEN 0 AND 23),
  sample_start    TIMESTAMPTZ,
  sample_end      TIMESTAMPTZ,
  UNIQUE (symbol, signal_state, session_name, timeframe)
);
CREATE INDEX IF NOT EXISTS idx_strategy_stats_expectancy ON public.strategy_stats (expectancy DESC, total_signals DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 8: equity_snapshots
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS equity_snapshots (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  balance    NUMERIC(14,2) NOT NULL,
  equity     NUMERIC(14,2) NOT NULL,
  open_pnl   NUMERIC(12,2) NOT NULL DEFAULT 0,
  open_count INT           NOT NULL DEFAULT 0,
  daily_pnl  NUMERIC(12,2) NOT NULL DEFAULT 0,
  source     TEXT          DEFAULT 'daemon'
);
CREATE INDEX IF NOT EXISTS idx_equity_snapshots_time ON equity_snapshots (created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 9: execution_log
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS execution_log (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol       TEXT        NOT NULL,
  direction    TEXT,
  action       TEXT        NOT NULL,
  reason       TEXT,
  confidence   INT,
  entry_price  NUMERIC(20,8),
  sl_price     NUMERIC(20,8),
  lot_size     NUMERIC(8,4),
  risk_usd     NUMERIC(10,2),
  position_id  BIGINT,
  session_type TEXT,
  metadata     JSONB
);
CREATE INDEX IF NOT EXISTS idx_execution_log_created ON execution_log (created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY — public read on all tables
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE paper_account    ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_positions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_memory       ENABLE ROW LEVEL SECURITY;
ALTER TABLE smc_signals      ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_analyses  ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_stats   ENABLE ROW LEVEL SECURITY;
ALTER TABLE equity_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_log    ENABLE ROW LEVEL SECURITY;

-- paper_account
DROP POLICY IF EXISTS "anon_read_paper_account"   ON paper_account;
DROP POLICY IF EXISTS "anon_write_paper_account"  ON paper_account;
CREATE POLICY "anon_read_paper_account"  ON paper_account FOR SELECT USING (true);
CREATE POLICY "anon_write_paper_account" ON paper_account FOR UPDATE USING (true) WITH CHECK (true);

-- paper_positions
DROP POLICY IF EXISTS "anon_read_paper_positions"   ON paper_positions;
DROP POLICY IF EXISTS "anon_insert_paper_positions" ON paper_positions;
DROP POLICY IF EXISTS "anon_update_paper_positions" ON paper_positions;
CREATE POLICY "anon_read_paper_positions"   ON paper_positions FOR SELECT USING (true);
CREATE POLICY "anon_insert_paper_positions" ON paper_positions FOR INSERT WITH CHECK (true);
CREATE POLICY "anon_update_paper_positions" ON paper_positions FOR UPDATE USING (true) WITH CHECK (true);

-- bot_settings
DROP POLICY IF EXISTS "anon_read_bot_settings"  ON bot_settings;
DROP POLICY IF EXISTS "anon_write_bot_settings" ON bot_settings;
CREATE POLICY "anon_read_bot_settings"  ON bot_settings FOR SELECT USING (true);
CREATE POLICY "anon_write_bot_settings" ON bot_settings FOR UPDATE USING (true) WITH CHECK (true);

-- bot_memory
DROP POLICY IF EXISTS "anon_read_bot_memory"   ON bot_memory;
DROP POLICY IF EXISTS "anon_insert_bot_memory" ON bot_memory;
CREATE POLICY "anon_read_bot_memory"   ON bot_memory FOR SELECT USING (true);
CREATE POLICY "anon_insert_bot_memory" ON bot_memory FOR INSERT WITH CHECK (true);

-- smc_signals
DROP POLICY IF EXISTS "anon_read_smc_signals"   ON smc_signals;
DROP POLICY IF EXISTS "anon_insert_smc_signals" ON smc_signals;
DROP POLICY IF EXISTS "anon_update_smc_signals" ON smc_signals;
CREATE POLICY "anon_read_smc_signals"   ON smc_signals FOR SELECT USING (true);
CREATE POLICY "anon_insert_smc_signals" ON smc_signals FOR INSERT WITH CHECK (true);
CREATE POLICY "anon_update_smc_signals" ON smc_signals FOR UPDATE USING (true) WITH CHECK (true);

-- signal_analyses
DROP POLICY IF EXISTS "anon_read_signal_analyses"   ON signal_analyses;
DROP POLICY IF EXISTS "anon_insert_signal_analyses" ON signal_analyses;
DROP POLICY IF EXISTS "anon_update_signal_analyses" ON signal_analyses;
CREATE POLICY "anon_read_signal_analyses"   ON signal_analyses FOR SELECT USING (true);
CREATE POLICY "anon_insert_signal_analyses" ON signal_analyses FOR INSERT WITH CHECK (true);
CREATE POLICY "anon_update_signal_analyses" ON signal_analyses FOR UPDATE USING (true) WITH CHECK (true);

-- strategy_stats
DROP POLICY IF EXISTS "anon_read_strategy_stats" ON strategy_stats;
DROP POLICY IF EXISTS "anon_insert_strategy_stats" ON strategy_stats;
CREATE POLICY "anon_read_strategy_stats"  ON strategy_stats FOR SELECT USING (true);
CREATE POLICY "anon_insert_strategy_stats" ON strategy_stats FOR INSERT WITH CHECK (true);

-- equity_snapshots
DROP POLICY IF EXISTS "anon_read_equity_snapshots"   ON equity_snapshots;
DROP POLICY IF EXISTS "anon_insert_equity_snapshots" ON equity_snapshots;
CREATE POLICY "anon_read_equity_snapshots"   ON equity_snapshots FOR SELECT USING (true);
CREATE POLICY "anon_insert_equity_snapshots" ON equity_snapshots FOR INSERT WITH CHECK (true);

-- execution_log
DROP POLICY IF EXISTS "anon_read_execution_log"   ON execution_log;
DROP POLICY IF EXISTS "anon_insert_execution_log" ON execution_log;
CREATE POLICY "anon_read_execution_log"   ON execution_log FOR SELECT USING (true);
CREATE POLICY "anon_insert_execution_log" ON execution_log FOR INSERT WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════════
-- VIEWS
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_latest_signals AS
SELECT DISTINCT ON (symbol)
  id, created_at, symbol, timeframe, verdict, confidence,
  reasoning_codes, entry_price, sl_price, tp1_price, tp2_price,
  risk_reward, session_name, htf_trend, sweep_occurred,
  mss_occurred, displacement, data_status, ai_narrative, outcome
FROM smc_signals ORDER BY symbol, created_at DESC;

CREATE OR REPLACE VIEW v_bot_dashboard AS
SELECT
  a.balance, a.equity, a.open_pnl, a.daily_pnl_usd,
  a.kill_switch_active, a.kill_switch_reason, a.day_date,
  a.total_trades, a.win_trades, a.loss_trades, a.win_rate_pct,
  a.avg_pnl_r, a.peak_balance, a.max_drawdown, a.updated_at,
  s.is_paused, s.risk_pct, s.daily_loss_limit_pct,
  s.max_open_positions, s.confidence_threshold,
  (SELECT COUNT(*) FROM paper_positions WHERE status = 'OPEN') AS open_count
FROM paper_account a CROSS JOIN bot_settings s
WHERE a.id = 1 AND s.id = 1;

-- ═══════════════════════════════════════════════════════════════════════════
-- SQL FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reset_daily_tracking()
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_balance NUMERIC;
BEGIN
  SELECT balance INTO v_balance FROM paper_account WHERE id = 1;
  UPDATE paper_account SET
    daily_pnl_usd       = 0,
    daily_start_balance = COALESCE(v_balance, 100000),
    daily_trades        = 0,
    daily_wins          = 0,
    daily_losses        = 0,
    kill_switch_active  = FALSE,
    kill_switch_reason  = NULL,
    kill_switch_at      = NULL,
    day_date            = CURRENT_DATE,
    updated_at          = NOW()
  WHERE id = 1;
  UPDATE bot_settings SET is_paused = FALSE, updated_at = NOW()
  WHERE id = 1 AND is_paused = TRUE;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- pg_cron SCHEDULES
-- Вызывают Edge Functions через pg_net (HTTP POST к Supabase Edge)
-- ЗАМЕНИ <PROJECT_REF> на: nxiednydxyrtxpkmgtof
-- ═══════════════════════════════════════════════════════════════════════════

-- Удаляем старые расписания если были
SELECT cron.unschedule('auto-analyze-london')   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='auto-analyze-london');
SELECT cron.unschedule('auto-analyze-overlap')  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='auto-analyze-overlap');
SELECT cron.unschedule('auto-analyze-newyork')  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='auto-analyze-newyork');
SELECT cron.unschedule('auto-analyze-asia')     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='auto-analyze-asia');
SELECT cron.unschedule('auto-analyze-frankfurt')WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='auto-analyze-frankfurt');
SELECT cron.unschedule('update-outcomes-hourly')WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='update-outcomes-hourly');
SELECT cron.unschedule('update-stats-daily')    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='update-stats-daily');
SELECT cron.unschedule('update-positions-5min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='update-positions-5min');
SELECT cron.unschedule('daily-reset-tracking')  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='daily-reset-tracking');

-- auto-analyze: 5 раз в день (сессионные открытия UTC)
SELECT cron.schedule('auto-analyze-london',    '0 8  * * 1-5',
  $$SELECT net.http_post('https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/auto-analyze',
    '{}', '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}')$$);

SELECT cron.schedule('auto-analyze-overlap',   '0 12 * * 1-5',
  $$SELECT net.http_post('https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/auto-analyze',
    '{}', '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}')$$);

SELECT cron.schedule('auto-analyze-newyork',   '0 17 * * 1-5',
  $$SELECT net.http_post('https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/auto-analyze',
    '{}', '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}')$$);

SELECT cron.schedule('auto-analyze-asia',      '0 0  * * 1-5',
  $$SELECT net.http_post('https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/auto-analyze',
    '{}', '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}')$$);

SELECT cron.schedule('auto-analyze-frankfurt', '0 7  * * 1-5',
  $$SELECT net.http_post('https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/auto-analyze',
    '{}', '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}')$$);

-- update-outcomes: каждый час
SELECT cron.schedule('update-outcomes-hourly', '5 * * * *',
  $$SELECT net.http_post('https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/update-outcomes',
    '{}', '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}')$$);

-- update-strategy-stats: каждый день в 00:10 UTC
SELECT cron.schedule('update-stats-daily', '10 0 * * *',
  $$SELECT net.http_post('https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/update-strategy-stats',
    '{}', '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}')$$);

-- update-paper-positions: каждые 5 минут
SELECT cron.schedule('update-positions-5min', '*/5 * * * *',
  $$SELECT net.http_post('https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/update-paper-positions',
    '{}', '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}')$$);

-- reset daily tracking: каждый день в 00:01 UTC
SELECT cron.schedule('daily-reset-tracking', '1 0 * * *', $$SELECT reset_daily_tracking()$$);

-- ═══════════════════════════════════════════════════════════════════════════
-- ГОТОВО. Проверь: Dashboard → Database → Cron Jobs
-- Должно быть 9 активных jobs.
-- ═══════════════════════════════════════════════════════════════════════════
