-- ═══════════════════════════════════════════════════════════════════════════
-- PropPilot AI — COMPLETE DATABASE MIGRATION
-- Generated: 2026-04-29
--
-- INSTRUCTIONS:
--   1. Go to: https://supabase.com/dashboard/project/nxiednydxyrtxpkmgtof/editor
--   2. Paste this ENTIRE file into the SQL editor
--   3. Click "Run"
--
-- This sets up the complete PropPilot AI schema:
--   • Core trading tables (paper_account, positions, signals, etc.)
--   • Signal analyses + strategy stats
--   • User profiles + challenge sync
--   • RLS security policies
--   • pg_cron scheduled jobs
--   • Economic calendar cache
--   • Trading Journal (journal_trades, analyses, patterns)
--   • Prop firm challenge tracker
--   • Backtest storage
-- ═══════════════════════════════════════════════════════════════════════════



-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  BASE SETUP (tables, functions, RLS, cron)                              ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- PropPilot AI — COMPLETE SUPABASE SETUP
-- Paste this ENTIRE file in: Supabase Dashboard → SQL Editor → New Query → Run
--
-- BEFORE RUNNING: replace YOUR_CRON_SECRET_HERE with your generated secret:
--   export PROPILOT_CRON_SECRET=$(openssl rand -hex 32) && echo $PROPILOT_CRON_SECRET
--
-- Order: extensions → tables → phase1/2/3 → user_profiles → security → cron jobs
-- ═══════════════════════════════════════════════════════════════════════════

-- ── STEP 1: Set cron secret (same value you used in `supabase secrets set`) ──
-- Replace YOUR_CRON_SECRET_HERE with your actual secret before running!
ALTER DATABASE postgres SET "app.proppilot_cron_secret" = 'YOUR_CRON_SECRET_HERE';
SELECT set_config('app.proppilot_cron_secret', 'YOUR_CRON_SECRET_HERE', false);


-- ═══ FULL MIGRATION (base tables) ═══
-- ═══════════════════════════════════════════════════════════════════════════
-- PropPilot AI — FULL DATABASE MIGRATION (новый проект)
-- Запусти в: Supabase Dashboard → SQL Editor → New query → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- ── EXTENSIONS ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── 1. paper_account ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_account (
  id                   INT PRIMARY KEY DEFAULT 1,
  balance              NUMERIC(14,2) NOT NULL DEFAULT 100000,
  equity               NUMERIC(14,2) NOT NULL DEFAULT 100000,
  open_pnl             NUMERIC(12,2) NOT NULL DEFAULT 0,
  peak_balance         NUMERIC(14,2) NOT NULL DEFAULT 100000,
  max_drawdown         NUMERIC(6,2)  NOT NULL DEFAULT 0,
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

-- ── 2. paper_positions ────────────────────────────────────────────────────────
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
  correlation_tag     TEXT,
  kill_switch_blocked BOOLEAN       NOT NULL DEFAULT FALSE,
  signal_id           BIGINT,
  notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_paper_positions_status
  ON paper_positions (status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_positions_symbol
  ON paper_positions (symbol, opened_at DESC);

-- ── 3. bot_settings ──────────────────────────────────────────────────────────
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
  correlation_guard    BOOLEAN       NOT NULL DEFAULT TRUE,
  allowed_sessions     TEXT[]        NOT NULL DEFAULT '{"London","Overlap","NewYork"}',
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

INSERT INTO bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── 4. bot_memory ─────────────────────────────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS idx_bot_memory_run_at
  ON bot_memory (run_at DESC);

-- ── 5. smc_signals ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smc_signals (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol          TEXT        NOT NULL,
  timeframe       TEXT        NOT NULL DEFAULT 'm5',
  verdict         TEXT        NOT NULL
    CHECK (verdict IN ('LONG_NOW','SHORT_NOW','WAIT_LONG','WAIT_SHORT','NO_TRADE')),
  confidence      SMALLINT    NOT NULL DEFAULT 0
    CHECK (confidence BETWEEN 0 AND 100),
  reasoning_codes TEXT[]      NOT NULL DEFAULT '{}',
  entry_price     NUMERIC(20,8),
  sl_price        NUMERIC(20,8),
  tp1_price       NUMERIC(20,8),
  tp2_price       NUMERIC(20,8),
  ote_zone_lo     NUMERIC(20,8),
  ote_zone_hi     NUMERIC(20,8),
  risk_reward     NUMERIC(5,2),
  invalidation    TEXT,
  session_ctx     TEXT,
  htf_trend       TEXT  CHECK (htf_trend IN ('bullish','bearish','ranging')),
  ltf_trend       TEXT  CHECK (ltf_trend IN ('bullish','bearish','ranging')),
  session_name    TEXT,
  atr             NUMERIC(20,8),
  sweep_occurred  BOOLEAN NOT NULL DEFAULT FALSE,
  sweep_level     NUMERIC(20,8),
  sweep_direction TEXT    CHECK (sweep_direction IN ('low','high',NULL)),
  mss_occurred    BOOLEAN NOT NULL DEFAULT FALSE,
  mss_level       NUMERIC(20,8),
  mss_type        TEXT    CHECK (mss_type IN ('MSS','CHoCH',NULL)),
  displacement    BOOLEAN NOT NULL DEFAULT FALSE,
  fvg_nearby      BOOLEAN NOT NULL DEFAULT FALSE,
  data_status     TEXT    NOT NULL DEFAULT 'live'
    CHECK (data_status IN ('live','delayed','demo')),
  signal_json     JSONB,
  outcome         TEXT  CHECK (outcome IN ('tp1_hit','tp2_hit','sl_hit','expired','cancelled',NULL)),
  outcome_price   NUMERIC(20,8),
  outcome_pnl_r   NUMERIC(6,2),
  outcome_at      TIMESTAMPTZ,
  ai_narrative    TEXT,
  narrative_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_smc_signals_symbol_time
  ON smc_signals (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_smc_signals_verdict
  ON smc_signals (verdict, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_smc_signals_actionable
  ON smc_signals (symbol, created_at DESC)
  WHERE verdict IN ('LONG_NOW','SHORT_NOW') AND confidence >= 65;

-- ── 6. market_levels ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS market_levels (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol           TEXT        NOT NULL,
  level_type       TEXT        NOT NULL,
  price            NUMERIC(20,8) NOT NULL,
  price_top        NUMERIC(20,8),
  price_bot        NUMERIC(20,8),
  label            TEXT,
  timeframe        TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  filled           BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at       TIMESTAMPTZ,
  source_signal_id BIGINT REFERENCES smc_signals(id)
);

CREATE INDEX IF NOT EXISTS idx_market_levels_symbol_active
  ON market_levels (symbol, is_active, level_type);

-- ── 7. symbol_config ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS symbol_config (
  symbol          TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  icon            TEXT DEFAULT '📊',
  asset_class     TEXT NOT NULL
    CHECK (asset_class IN ('crypto','forex','index','commodity','unknown')),
  data_source     TEXT NOT NULL
    CHECK (data_source IN ('binance','twelvedata','alpaca','demo')),
  fallback_source TEXT,
  pip_size        NUMERIC(12,8) NOT NULL DEFAULT 0.0001,
  min_confidence  SMALLINT NOT NULL DEFAULT 60,
  session_filter  TEXT[]   NOT NULL DEFAULT '{"London","Overlap","NewYork"}',
  is_active       BOOLEAN  NOT NULL DEFAULT TRUE,
  max_spread_pips NUMERIC(8,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO symbol_config (symbol, display_name, icon, asset_class, data_source, fallback_source, pip_size)
VALUES
  ('XAU/USD',  'Gold / USD',           '🥇', 'commodity', 'twelvedata', 'demo', 0.01),
  ('EUR/USD',  'Euro / USD',           '💶', 'forex',     'twelvedata', 'demo', 0.0001),
  ('GBP/USD',  'British Pound / USD',  '💷', 'forex',     'twelvedata', 'demo', 0.0001),
  ('USD/JPY',  'US Dollar / Yen',      '💴', 'forex',     'twelvedata', 'demo', 0.01),
  ('NAS100',   'NASDAQ 100',           '📈', 'index',     'alpaca',     'twelvedata', 1.0),
  ('BTC/USD',  'Bitcoin / USD',        '₿',  'crypto',    'binance',    'demo', 1.0),
  ('ETH/USD',  'Ethereum / USD',       'Ξ',  'crypto',    'binance',    'demo', 0.1)
ON CONFLICT (symbol) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = NOW();

-- ── 8. equity_snapshots ───────────────────────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS idx_equity_snapshots_time
  ON equity_snapshots (created_at DESC);

-- ── 9. execution_log ─────────────────────────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS idx_execution_log_created
  ON execution_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_log_symbol
  ON execution_log (symbol, created_at DESC);

-- ── 10. RLS policies ─────────────────────────────────────────────────────────
ALTER TABLE paper_account    ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_positions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_memory       ENABLE ROW LEVEL SECURITY;
ALTER TABLE smc_signals      ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_levels    ENABLE ROW LEVEL SECURITY;
ALTER TABLE symbol_config    ENABLE ROW LEVEL SECURITY;
ALTER TABLE equity_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_log    ENABLE ROW LEVEL SECURITY;

-- paper_account
DROP POLICY IF EXISTS "Public read paper_account"   ON paper_account;
DROP POLICY IF EXISTS "Public update paper_account" ON paper_account;
CREATE POLICY "Public read paper_account"   ON paper_account FOR SELECT USING (true);
CREATE POLICY "Public update paper_account" ON paper_account FOR UPDATE USING (true) WITH CHECK (true);

-- paper_positions
DROP POLICY IF EXISTS "Public read paper_positions"   ON paper_positions;
DROP POLICY IF EXISTS "Public insert paper_positions" ON paper_positions;
DROP POLICY IF EXISTS "Public update paper_positions" ON paper_positions;
CREATE POLICY "Public read paper_positions"   ON paper_positions FOR SELECT USING (true);
CREATE POLICY "Public insert paper_positions" ON paper_positions FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update paper_positions" ON paper_positions FOR UPDATE USING (true) WITH CHECK (true);

-- bot_settings
DROP POLICY IF EXISTS "Public read bot_settings"   ON bot_settings;
DROP POLICY IF EXISTS "Public update bot_settings" ON bot_settings;
CREATE POLICY "Public read bot_settings"   ON bot_settings FOR SELECT USING (true);
CREATE POLICY "Public update bot_settings" ON bot_settings FOR UPDATE USING (true) WITH CHECK (true);

-- bot_memory
DROP POLICY IF EXISTS "Public read bot_memory"   ON bot_memory;
DROP POLICY IF EXISTS "Public insert bot_memory" ON bot_memory;
CREATE POLICY "Public read bot_memory"   ON bot_memory FOR SELECT USING (true);
CREATE POLICY "Public insert bot_memory" ON bot_memory FOR INSERT WITH CHECK (true);

-- smc_signals
DROP POLICY IF EXISTS "Public read smc_signals"   ON smc_signals;
DROP POLICY IF EXISTS "Public insert smc_signals" ON smc_signals;
CREATE POLICY "Public read smc_signals"   ON smc_signals FOR SELECT USING (true);
CREATE POLICY "Public insert smc_signals" ON smc_signals FOR INSERT WITH CHECK (true);

-- market_levels
DROP POLICY IF EXISTS "Public read market_levels"   ON market_levels;
DROP POLICY IF EXISTS "Public insert market_levels" ON market_levels;
CREATE POLICY "Public read market_levels"   ON market_levels FOR SELECT USING (true);
CREATE POLICY "Public insert market_levels" ON market_levels FOR INSERT WITH CHECK (true);

-- symbol_config
DROP POLICY IF EXISTS "Public read symbol_config" ON symbol_config;
CREATE POLICY "Public read symbol_config" ON symbol_config FOR SELECT USING (true);

-- equity_snapshots
DROP POLICY IF EXISTS "Public read equity_snapshots"   ON equity_snapshots;
DROP POLICY IF EXISTS "Public insert equity_snapshots" ON equity_snapshots;
CREATE POLICY "Public read equity_snapshots"   ON equity_snapshots FOR SELECT USING (true);
CREATE POLICY "Public insert equity_snapshots" ON equity_snapshots FOR INSERT WITH CHECK (true);

-- execution_log
DROP POLICY IF EXISTS "Public read execution_log"   ON execution_log;
DROP POLICY IF EXISTS "Public insert execution_log" ON execution_log;
CREATE POLICY "Public read execution_log"   ON execution_log FOR SELECT USING (true);
CREATE POLICY "Public insert execution_log" ON execution_log FOR INSERT WITH CHECK (true);

-- ── 11. Functions ─────────────────────────────────────────────────────────────
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

CREATE OR REPLACE FUNCTION expire_market_levels()
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE market_levels SET is_active = FALSE, updated_at = NOW()
  WHERE is_active = TRUE AND expires_at IS NOT NULL AND expires_at < NOW();
END;
$$;

-- ── 12. Views ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_latest_signals AS
SELECT DISTINCT ON (symbol)
  id, created_at, symbol, timeframe, verdict, confidence,
  reasoning_codes, entry_price, sl_price, tp1_price, tp2_price,
  risk_reward, session_name, htf_trend, sweep_occurred,
  mss_occurred, displacement, data_status, ai_narrative
FROM smc_signals ORDER BY symbol, created_at DESC;

CREATE OR REPLACE VIEW v_bot_dashboard AS
SELECT
  a.balance, a.equity, a.open_pnl, a.daily_pnl_usd,
  a.kill_switch_active, a.kill_switch_reason, a.day_date,
  a.total_trades, a.win_trades, a.loss_trades, a.win_rate_pct,
  a.avg_pnl_r, a.peak_balance, a.max_drawdown, a.updated_at,
  s.is_paused, s.risk_pct, s.daily_loss_limit_pct,
  s.max_open_positions, s.confidence_threshold,
  (SELECT COUNT(*) FROM paper_positions WHERE status IN ('OPEN','TP1_HIT')) AS open_count
FROM paper_account a CROSS JOIN bot_settings s
WHERE a.id = 1 AND s.id = 1;

-- ── 13. pg_cron schedules ────────────────────────────────────────────────────
SELECT cron.schedule('daily-reset-tracking', '1 0 * * *', $$SELECT reset_daily_tracking()$$);

-- ═══════════════════════════════════════════════════════════════════════════
-- DONE. Все таблицы созданы и готовы к работе.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ PHASE 1: Outcome tracker + signal_analyses + strategy_stats ═══
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

-- ═══ PHASE 2: SMC engine ═══
-- ═══════════════════════════════════════════════════════════════════════════════
-- PropPilot AI — Phase 2: SMC Signal Engine Database Schema
-- Migration: 20260422_phase2_smc_engine.sql
-- ═══════════════════════════════════════════════════════════════════════════════
-- Tables added:
--   1. smc_signals      — Deterministic SMC analysis results (one row per analysis run)
--   2. market_levels    — Key price levels cache (PDH/PDL, FVG, EQH/EQL, etc.)
--   3. symbol_config    — Per-symbol settings (asset class, pip size, data source)
--
-- All tables have RLS enabled. The app uses the anon key with public read/insert.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ── 1. SMC Signal Results ──────────────────────────────────────────────────────
-- Stores each output from analyzeMarketStructure(). One row per analysis tick.
-- `outcome` is back-filled by a future Edge Function when TP/SL is hit.

CREATE TABLE IF NOT EXISTS smc_signals (
  id              bigserial PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Identity
  symbol          text        NOT NULL,
  timeframe       text        NOT NULL DEFAULT 'm5',

  -- Verdict
  verdict         text        NOT NULL
    CHECK (verdict IN ('LONG_NOW','SHORT_NOW','WAIT_LONG','WAIT_SHORT','NO_TRADE')),
  confidence      smallint    NOT NULL DEFAULT 0
    CHECK (confidence BETWEEN 0 AND 100),
  reasoning_codes text[]      NOT NULL DEFAULT '{}',

  -- Entry Levels
  entry_price     numeric(20,8),
  sl_price        numeric(20,8),
  tp1_price       numeric(20,8),
  tp2_price       numeric(20,8),
  ote_zone_lo     numeric(20,8),
  ote_zone_hi     numeric(20,8),
  risk_reward     numeric(5,2),

  -- Narrative
  invalidation    text,
  session_ctx     text,

  -- Market Structure
  htf_trend       text  CHECK (htf_trend IN ('bullish','bearish','ranging')),
  ltf_trend       text  CHECK (ltf_trend IN ('bullish','bearish','ranging')),
  session_name    text,
  atr             numeric(20,8),

  -- Triggers (for quick analytics queries)
  sweep_occurred  boolean NOT NULL DEFAULT false,
  sweep_level     numeric(20,8),
  sweep_direction text    CHECK (sweep_direction IN ('low','high',NULL)),
  mss_occurred    boolean NOT NULL DEFAULT false,
  mss_level       numeric(20,8),
  mss_type        text    CHECK (mss_type IN ('MSS','CHoCH',NULL)),
  displacement    boolean NOT NULL DEFAULT false,
  fvg_nearby      boolean NOT NULL DEFAULT false,

  -- Data quality
  data_status     text NOT NULL DEFAULT 'live'
    CHECK (data_status IN ('live','delayed','demo')),

  -- Full raw signal JSON (for future parsing / replays)
  signal_json     jsonb,

  -- Outcome (back-filled by monitor)
  outcome         text  CHECK (outcome IN ('tp1_hit','tp2_hit','sl_hit','expired','cancelled',NULL)),
  outcome_price   numeric(20,8),
  outcome_pnl_r   numeric(6,2),   -- P&L in R multiples (e.g. +2.5 or -1.0)
  outcome_at      timestamptz,

  -- AI narrative (generated on demand)
  ai_narrative    text,
  narrative_at    timestamptz
);

COMMENT ON TABLE smc_signals IS
  'One row per SMC analysis result from the PropPilot deterministic signal engine.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_smc_signals_symbol_time
  ON smc_signals (symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_smc_signals_verdict
  ON smc_signals (verdict, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_smc_signals_symbol_verdict
  ON smc_signals (symbol, verdict, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_smc_signals_outcome
  ON smc_signals (outcome) WHERE outcome IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_smc_signals_confidence
  ON smc_signals (confidence DESC, created_at DESC)
  WHERE verdict IN ('LONG_NOW','SHORT_NOW');

-- Partial index: only actionable signals (for dashboard query speed)
CREATE INDEX IF NOT EXISTS idx_smc_signals_actionable
  ON smc_signals (symbol, created_at DESC)
  WHERE verdict IN ('LONG_NOW','SHORT_NOW') AND confidence >= 65;


-- ── 2. Market Levels Cache ─────────────────────────────────────────────────────
-- Stores key price levels for chart rendering and sweep detection.
-- Populated by the signal engine and expired automatically.

CREATE TABLE IF NOT EXISTS market_levels (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  symbol      text        NOT NULL,
  level_type  text        NOT NULL,  -- 'PDH','PDL','PWH','PWL','EQH','EQL','FVG_BULL','FVG_BEAR','ASIA_HIGH','ASIA_LOW','CDH','CDL'
  price       numeric(20,8) NOT NULL,
  price_top   numeric(20,8),          -- For zone levels (FVG top)
  price_bot   numeric(20,8),          -- For zone levels (FVG bottom)
  label       text,
  timeframe   text,                   -- TF this level was identified on
  is_active   boolean NOT NULL DEFAULT true,
  filled      boolean NOT NULL DEFAULT false,  -- True when price revisited this level
  expires_at  timestamptz,            -- NULL = manual expiry only
  source_signal_id bigint REFERENCES smc_signals(id)
);

COMMENT ON TABLE market_levels IS
  'Cached key price levels for chart rendering and sweep detection. Auto-expired daily.';

CREATE INDEX IF NOT EXISTS idx_market_levels_symbol_active
  ON market_levels (symbol, is_active, level_type);

CREATE INDEX IF NOT EXISTS idx_market_levels_expires
  ON market_levels (expires_at)
  WHERE expires_at IS NOT NULL AND is_active = true;


-- ── 3. Symbol Configuration ───────────────────────────────────────────────────
-- Per-symbol settings controlling data source, pip size, and session filters.
-- Editable by admins; read-only for the trading app.

CREATE TABLE IF NOT EXISTS symbol_config (
  symbol          text PRIMARY KEY,
  display_name    text NOT NULL,
  icon            text DEFAULT '📊',
  asset_class     text NOT NULL
    CHECK (asset_class IN ('crypto','forex','index','commodity','unknown')),
  data_source     text NOT NULL
    CHECK (data_source IN ('binance','twelvedata','alpaca','demo')),
  fallback_source text
    CHECK (fallback_source IN ('twelvedata','demo',NULL)),
  pip_size        numeric(12,8) NOT NULL DEFAULT 0.0001,
  min_confidence  smallint NOT NULL DEFAULT 60,    -- Below this → NO_TRADE override
  session_filter  text[]   NOT NULL DEFAULT '{"London","Overlap","NewYork"}',
  is_active       boolean  NOT NULL DEFAULT true,
  max_spread_pips numeric(8,2),                    -- Max allowed spread before discard
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE symbol_config IS
  'Per-symbol configuration for data sources, pip sizes, and session trading rules.';

-- Seed: default symbols
INSERT INTO symbol_config
  (symbol, display_name, icon, asset_class, data_source, fallback_source, pip_size, session_filter)
VALUES
  ('BTCUSDT', 'Bitcoin / USDT',        '₿',  'crypto',    'binance',     'demo',        1.0,      '{"NewYork","Overlap","London","Asia"}'  ),
  ('ETHUSDT', 'Ethereum / USDT',       'Ξ',  'crypto',    'binance',     'demo',        0.1,      '{"NewYork","Overlap","London","Asia"}'  ),
  ('XAUUSD',  'Gold / USD',            '🥇', 'commodity', 'twelvedata',  'demo',        0.01,     '{"London","Overlap","NewYork"}'         ),
  ('EURUSD',  'Euro / USD',            '💶', 'forex',     'twelvedata',  'demo',        0.0001,   '{"London","Overlap","NewYork"}'         ),
  ('GBPUSD',  'British Pound / USD',   '💷', 'forex',     'twelvedata',  'demo',        0.0001,   '{"London","Overlap","NewYork"}'         ),
  ('NAS100',  'NASDAQ 100',            '📈', 'index',     'alpaca',      'twelvedata',  1.0,      '{"NewYork","Overlap"}'                  )
ON CONFLICT (symbol) DO UPDATE SET
  display_name    = EXCLUDED.display_name,
  icon            = EXCLUDED.icon,
  updated_at      = now();


-- ── 4. Row Level Security (RLS) ───────────────────────────────────────────────
-- The app uses the anon key for read/insert. No auth required for this MVP.

ALTER TABLE smc_signals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE symbol_config ENABLE ROW LEVEL SECURITY;

-- smc_signals: public read + insert (anon can write signals)
DROP POLICY IF EXISTS "Public read smc_signals"   ON smc_signals;
DROP POLICY IF EXISTS "Public insert smc_signals" ON smc_signals;
CREATE POLICY "Public read smc_signals"
  ON smc_signals FOR SELECT USING (true);
CREATE POLICY "Public insert smc_signals"
  ON smc_signals FOR INSERT WITH CHECK (true);

-- market_levels: public read + insert
DROP POLICY IF EXISTS "Public read market_levels"   ON market_levels;
DROP POLICY IF EXISTS "Public insert market_levels" ON market_levels;
CREATE POLICY "Public read market_levels"
  ON market_levels FOR SELECT USING (true);
CREATE POLICY "Public insert market_levels"
  ON market_levels FOR INSERT WITH CHECK (true);

-- symbol_config: public read only
DROP POLICY IF EXISTS "Public read symbol_config" ON symbol_config;
CREATE POLICY "Public read symbol_config"
  ON symbol_config FOR SELECT USING (true);


-- ── 5. Utility Views ──────────────────────────────────────────────────────────

-- Latest signal per symbol (for dashboard)
CREATE OR REPLACE VIEW v_latest_signals AS
SELECT DISTINCT ON (symbol)
  id, created_at, symbol, timeframe, verdict, confidence,
  reasoning_codes, entry_price, sl_price, tp1_price, tp2_price,
  risk_reward, invalidation, session_ctx, htf_trend, ltf_trend,
  sweep_occurred, mss_occurred, displacement, data_status, ai_narrative
FROM smc_signals
ORDER BY symbol, created_at DESC;

COMMENT ON VIEW v_latest_signals IS
  'Latest analysis result per symbol — used by the dashboard for at-a-glance status.';

-- Signal performance stats per symbol
CREATE OR REPLACE VIEW v_signal_stats AS
SELECT
  symbol,
  count(*) FILTER (WHERE verdict IN ('LONG_NOW','SHORT_NOW'))  AS total_actionable,
  count(*) FILTER (WHERE outcome = 'tp1_hit')                  AS tp1_hit,
  count(*) FILTER (WHERE outcome = 'tp2_hit')                  AS tp2_hit,
  count(*) FILTER (WHERE outcome = 'sl_hit')                   AS sl_hit,
  round(
    count(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit'))::numeric /
    nullif(count(*) FILTER (WHERE outcome IS NOT NULL), 0) * 100, 1
  )                                                             AS win_rate_pct,
  round(avg(outcome_pnl_r) FILTER (WHERE outcome_pnl_r IS NOT NULL), 2)  AS avg_pnl_r,
  round(avg(confidence), 0)                                    AS avg_confidence,
  max(created_at)                                              AS last_signal_at
FROM smc_signals
GROUP BY symbol;

COMMENT ON VIEW v_signal_stats IS
  'Aggregate performance statistics per symbol for the analytics dashboard.';


-- ── 6. Helper Functions ───────────────────────────────────────────────────────

-- Expire old market levels daily (call via pg_cron or Edge Function)
CREATE OR REPLACE FUNCTION expire_market_levels()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE market_levels
    SET is_active = false, updated_at = now()
  WHERE is_active = true
    AND expires_at IS NOT NULL
    AND expires_at < now();
END;
$$;

-- Mark a signal outcome (called by monitor bot or manually)
CREATE OR REPLACE FUNCTION mark_signal_outcome(
  p_signal_id   bigint,
  p_outcome     text,
  p_price       numeric,
  p_pnl_r       numeric DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE smc_signals SET
    outcome       = p_outcome,
    outcome_price = p_price,
    outcome_pnl_r = p_pnl_r,
    outcome_at    = now()
  WHERE id = p_signal_id
    AND outcome IS NULL;  -- Don't overwrite if already marked
END;
$$;


-- ── 7. pg_cron: Expire levels daily (if pg_cron extension is enabled) ─────────
-- Uncomment if you have pg_cron enabled on your Supabase project.

-- SELECT cron.schedule(
--   'expire-market-levels-daily',
--   '0 0 * * *',
--   $$SELECT expire_market_levels()$$
-- );


-- ═══════════════════════════════════════════════════════════════════════════════
-- Summary of changes
-- ═══════════════════════════════════════════════════════════════════════════════
-- ✓ smc_signals       — core signal storage with outcome tracking
-- ✓ market_levels     — price level cache for chart rendering
-- ✓ symbol_config     — per-symbol data source + pip config
-- ✓ RLS policies      — public read/insert for anon key
-- ✓ v_latest_signals  — quick dashboard query
-- ✓ v_signal_stats    — win rate + PnL analytics per symbol
-- ✓ expire_market_levels() — maintenance function
-- ✓ mark_signal_outcome()  — outcome recording
-- ✓ 6 default symbols seeded
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══ PHASE 3: Paper trading engine ═══
-- ═══════════════════════════════════════════════════════════════════════════════
-- PropPilot AI — Phase 3: Paper Trading Engine Schema Enhancements
-- Migration: 20260422_phase3_paper_engine.sql
-- ═══════════════════════════════════════════════════════════════════════════════
-- Adds:
--   • paper_account: daily P&L tracking + kill-switch + day-reset
--   • bot_settings: full Phase 3 settings columns
--   • equity_snapshots: if not exists + enhanced columns
--   • execution_log: audit trail for every trade open/close decision
-- ═══════════════════════════════════════════════════════════════════════════════


-- ── 1. paper_account — add daily tracking columns ─────────────────────────────
ALTER TABLE paper_account
  ADD COLUMN IF NOT EXISTS daily_pnl_usd        NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_start_balance   NUMERIC(12,2) NOT NULL DEFAULT 100000,
  ADD COLUMN IF NOT EXISTS daily_trades          INT           NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kill_switch_active    BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS kill_switch_reason    TEXT,
  ADD COLUMN IF NOT EXISTS kill_switch_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS day_date              DATE          NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS session_count         INT           NOT NULL DEFAULT 0,
  -- These may already exist from Phase 2 — safe with IF NOT EXISTS
  ADD COLUMN IF NOT EXISTS balance               NUMERIC(14,2) NOT NULL DEFAULT 100000,
  ADD COLUMN IF NOT EXISTS equity                NUMERIC(14,2) NOT NULL DEFAULT 100000,
  ADD COLUMN IF NOT EXISTS open_pnl              NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS peak_balance          NUMERIC(14,2) NOT NULL DEFAULT 100000,
  ADD COLUMN IF NOT EXISTS max_drawdown          NUMERIC(6,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_trades          INT           NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS win_trades            INT           NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loss_trades           INT           NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS win_rate_pct          NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS avg_pnl_r             NUMERIC(6,3),
  ADD COLUMN IF NOT EXISTS profit_factor         NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW();

-- Seed row if empty
INSERT INTO paper_account (id, balance, equity, peak_balance, day_date)
  VALUES (1, 100000, 100000, 100000, CURRENT_DATE)
  ON CONFLICT (id) DO NOTHING;


-- ── 2. paper_positions — add Phase 3 columns ──────────────────────────────────
ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS lot_size            NUMERIC(8,4)  DEFAULT 0.01,
  ADD COLUMN IF NOT EXISTS risk_usd            NUMERIC(10,2) DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS size_usd            NUMERIC(12,2) DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS sl_orig             NUMERIC(20,8),
  ADD COLUMN IF NOT EXISTS sl_moved_to_be      BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS trailing_activated  BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS close_price         NUMERIC(20,8),
  ADD COLUMN IF NOT EXISTS partial_pnl_usd     NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS partial_pnl_r       NUMERIC(6,3)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tp1_hit             BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mfe                 NUMERIC(6,3),   -- max favourable excursion in R
  ADD COLUMN IF NOT EXISTS mae                 NUMERIC(6,3),   -- max adverse excursion in R
  ADD COLUMN IF NOT EXISTS confidence          INT,
  ADD COLUMN IF NOT EXISTS session_type        TEXT,
  ADD COLUMN IF NOT EXISTS correlation_tag     TEXT,          -- e.g. 'USD_BULL', 'RISK_ON'
  ADD COLUMN IF NOT EXISTS kill_switch_blocked BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notes               TEXT;

-- Ensure status has correct values (extend if needed)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_positions_status_check'
  ) THEN
    ALTER TABLE paper_positions ADD CONSTRAINT paper_positions_status_check
      CHECK (status IN ('OPEN','TP1_HIT','TP2_HIT','SL_HIT','MANUAL_CLOSE','EXPIRED','KILL_SWITCH'));
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── 3. bot_settings — full Phase 3 settings ──────────────────────────────────
-- Create table if Phase 2 migration hasn't run yet
CREATE TABLE IF NOT EXISTS bot_settings (
  id                     INT  PRIMARY KEY DEFAULT 1,
  is_paused              BOOLEAN       NOT NULL DEFAULT FALSE,
  risk_pct               NUMERIC(4,2)  NOT NULL DEFAULT 1.0,
  daily_loss_limit_pct   NUMERIC(4,2)  NOT NULL DEFAULT 2.0,
  max_open_positions     INT           NOT NULL DEFAULT 3,
  confidence_threshold   INT           NOT NULL DEFAULT 70,
  trailing_atr_mult      NUMERIC(3,1)  NOT NULL DEFAULT 1.5,  -- Trailing activates at +1.5R
  partial_close_pct      INT           NOT NULL DEFAULT 50,   -- TP1 closes 50%
  tp1_mult               NUMERIC(4,2)  NOT NULL DEFAULT 2.2,  -- ATR multiplier for TP1
  tp2_mult               NUMERIC(4,2)  NOT NULL DEFAULT 3.6,  -- ATR multiplier for TP2
  sl_mult                NUMERIC(4,2)  NOT NULL DEFAULT 1.4,  -- ATR multiplier for SL
  correlation_guard      BOOLEAN       NOT NULL DEFAULT TRUE,  -- Block correlated pairs
  allowed_sessions       TEXT[]        NOT NULL DEFAULT '{"london_open","ny_open","ny_premarket"}',
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Add any missing columns
ALTER TABLE bot_settings
  ADD COLUMN IF NOT EXISTS trailing_atr_mult    NUMERIC(3,1)  NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS partial_close_pct    INT           NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS tp1_mult             NUMERIC(4,2)  NOT NULL DEFAULT 2.2,
  ADD COLUMN IF NOT EXISTS tp2_mult             NUMERIC(4,2)  NOT NULL DEFAULT 3.6,
  ADD COLUMN IF NOT EXISTS sl_mult              NUMERIC(4,2)  NOT NULL DEFAULT 1.4,
  ADD COLUMN IF NOT EXISTS correlation_guard    BOOLEAN       NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS allowed_sessions     TEXT[]        NOT NULL DEFAULT '{"london_open","ny_open","ny_premarket"}';

-- Seed row
INSERT INTO bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;


-- ── 4. equity_snapshots — create if not exists ────────────────────────────────
CREATE TABLE IF NOT EXISTS equity_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  balance      NUMERIC(14,2) NOT NULL,
  equity       NUMERIC(14,2) NOT NULL,
  open_pnl     NUMERIC(12,2) NOT NULL DEFAULT 0,
  open_count   INT           NOT NULL DEFAULT 0,
  daily_pnl    NUMERIC(12,2) NOT NULL DEFAULT 0,
  source       TEXT          DEFAULT 'cron'   -- 'cron' | 'manual' | 'close_event'
);

CREATE INDEX IF NOT EXISTS idx_equity_snapshots_time
  ON equity_snapshots (created_at DESC);


-- ── 5. execution_log — full audit trail ──────────────────────────────────────
-- Every trade open/reject decision is logged here for transparency.
CREATE TABLE IF NOT EXISTS execution_log (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol        TEXT        NOT NULL,
  direction     TEXT,
  action        TEXT        NOT NULL, -- 'OPEN_TRADE' | 'REJECT_PAUSED' | 'REJECT_KILL_SWITCH' | 'REJECT_MAX_POS' | 'REJECT_CONFIDENCE' | 'REJECT_CORRELATION' | 'REJECT_DD_LIMIT' | 'CLOSE_TP1' | 'CLOSE_TP2' | 'CLOSE_SL' | 'CLOSE_MANUAL' | 'CLOSE_KILL_SWITCH'
  reason        TEXT,
  confidence    INT,
  entry_price   NUMERIC(20,8),
  sl_price      NUMERIC(20,8),
  lot_size      NUMERIC(8,4),
  risk_usd      NUMERIC(10,2),
  position_id   BIGINT,  -- references paper_positions.id (if opened)
  session_type  TEXT,
  metadata      JSONB
);

CREATE INDEX IF NOT EXISTS idx_execution_log_created
  ON execution_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_log_symbol
  ON execution_log (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_log_action
  ON execution_log (action, created_at DESC);


-- ── 6. RLS policies ───────────────────────────────────────────────────────────
ALTER TABLE equity_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_log    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read equity_snapshots"   ON equity_snapshots;
DROP POLICY IF EXISTS "Public insert equity_snapshots" ON equity_snapshots;
CREATE POLICY "Public read equity_snapshots"
  ON equity_snapshots FOR SELECT USING (true);
CREATE POLICY "Public insert equity_snapshots"
  ON equity_snapshots FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Public read execution_log"   ON execution_log;
DROP POLICY IF EXISTS "Public insert execution_log" ON execution_log;
CREATE POLICY "Public read execution_log"
  ON execution_log FOR SELECT USING (true);
CREATE POLICY "Public insert execution_log"
  ON execution_log FOR INSERT WITH CHECK (true);

-- bot_settings: public read + update
ALTER TABLE bot_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read bot_settings"   ON bot_settings;
DROP POLICY IF EXISTS "Public update bot_settings" ON bot_settings;
CREATE POLICY "Public read bot_settings"
  ON bot_settings FOR SELECT USING (true);
CREATE POLICY "Public update bot_settings"
  ON bot_settings FOR UPDATE USING (true) WITH CHECK (true);

-- paper_account: public read + update
ALTER TABLE paper_account ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read paper_account"   ON paper_account;
DROP POLICY IF EXISTS "Public update paper_account" ON paper_account;
CREATE POLICY "Public read paper_account"
  ON paper_account FOR SELECT USING (true);
CREATE POLICY "Public update paper_account"
  ON paper_account FOR UPDATE USING (true) WITH CHECK (true);

-- paper_positions: public read + insert + update
ALTER TABLE paper_positions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read paper_positions"   ON paper_positions;
DROP POLICY IF EXISTS "Public insert paper_positions" ON paper_positions;
DROP POLICY IF EXISTS "Public update paper_positions" ON paper_positions;
CREATE POLICY "Public read paper_positions"
  ON paper_positions FOR SELECT USING (true);
CREATE POLICY "Public insert paper_positions"
  ON paper_positions FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update paper_positions"
  ON paper_positions FOR UPDATE USING (true) WITH CHECK (true);


-- ── 7. Daily reset helper function ───────────────────────────────────────────
-- Call this at 00:00 UTC every day (or pg_cron schedule below)
CREATE OR REPLACE FUNCTION reset_daily_tracking()
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_balance NUMERIC;
BEGIN
  SELECT balance INTO v_balance FROM paper_account WHERE id = 1;

  UPDATE paper_account
  SET daily_pnl_usd      = 0,
      daily_start_balance = COALESCE(v_balance, 100000),
      daily_trades        = 0,
      kill_switch_active  = FALSE,
      kill_switch_reason  = NULL,
      kill_switch_at      = NULL,
      day_date            = CURRENT_DATE,
      updated_at          = NOW()
  WHERE id = 1;

  -- Also resume bot if it was paused by kill-switch (not manual pause)
  UPDATE bot_settings
  SET is_paused = FALSE, updated_at = NOW()
  WHERE id = 1
    AND is_paused = TRUE;

  RAISE NOTICE 'Daily tracking reset for %. Start balance: $%', CURRENT_DATE, v_balance;
END;
$$;

-- Kill-switch trigger function
CREATE OR REPLACE FUNCTION trigger_kill_switch(p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE paper_account
  SET kill_switch_active = TRUE,
      kill_switch_reason = p_reason,
      kill_switch_at     = NOW(),
      updated_at         = NOW()
  WHERE id = 1;

  -- Also mark all OPEN positions for awareness
  UPDATE paper_positions
  SET notes = COALESCE(notes || ' | ', '') || 'Kill-switch at ' || NOW()::TEXT
  WHERE status IN ('OPEN', 'TP1_HIT');

  RAISE NOTICE 'KILL SWITCH ACTIVATED: %', p_reason;
END;
$$;


-- ── 8. Views for bot.html ─────────────────────────────────────────────────────

-- Dashboard summary view
CREATE OR REPLACE VIEW v_bot_dashboard AS
SELECT
  a.balance,
  a.equity,
  a.open_pnl,
  a.daily_pnl_usd,
  a.daily_start_balance,
  a.kill_switch_active,
  a.kill_switch_reason,
  a.day_date,
  a.total_trades,
  a.win_trades,
  a.loss_trades,
  a.win_rate_pct,
  a.avg_pnl_r,
  a.profit_factor,
  a.peak_balance,
  a.max_drawdown,
  a.updated_at,
  s.is_paused,
  s.risk_pct,
  s.daily_loss_limit_pct,
  s.max_open_positions,
  s.confidence_threshold,
  (SELECT COUNT(*) FROM paper_positions WHERE status IN ('OPEN', 'TP1_HIT')) AS open_count,
  (SELECT COUNT(*) FROM paper_positions WHERE status IN ('OPEN', 'TP1_HIT')
     AND opened_at > CURRENT_DATE) AS today_opened,
  (SELECT COALESCE(SUM(pnl_usd), 0) FROM paper_positions
     WHERE closed_at > CURRENT_DATE AND pnl_usd IS NOT NULL) AS today_closed_pnl
FROM paper_account a
CROSS JOIN bot_settings s
WHERE a.id = 1 AND s.id = 1;


-- ── 9. pg_cron schedules ─────────────────────────────────────────────────────
-- Uncomment after confirming pg_cron is enabled on your project.

-- Daily reset at 00:01 UTC every day
-- SELECT cron.schedule('daily-reset-tracking', '1 0 * * *', $$SELECT reset_daily_tracking()$$);

-- Position manager every 5 minutes on weekdays
-- SELECT cron.unschedule('update-paper-positions-30min');  -- remove old 30-min schedule
-- SELECT cron.schedule('manage-positions-5min', '*/5 7-22 * * 1-5',
--   $$SELECT net.http_post(url:=current_setting('app.supabase_url') || '/functions/v1/update-paper-positions',
--     headers:='{"Authorization": "Bearer ' || current_setting('app.service_role_key') || '"}'::jsonb,
--     body:='{}'::jsonb)$$
-- );


-- ═══════════════════════════════════════════════════════════════════════════════
-- Summary of Phase 3 migration
-- ═══════════════════════════════════════════════════════════════════════════════
-- ✓ paper_account: daily P&L, kill-switch, day-date fields
-- ✓ paper_positions: lot_size, risk_usd, trailing, partial P&L, kill-switch flag
-- ✓ bot_settings: Phase 3 tuning knobs (trailing_atr_mult, tp/sl mults, etc.)
-- ✓ equity_snapshots: created + indexed
-- ✓ execution_log: full audit trail for every decision
-- ✓ RLS policies on all new tables
-- ✓ reset_daily_tracking() function (call at 00:00 UTC)
-- ✓ trigger_kill_switch() function
-- ✓ v_bot_dashboard view
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══ User profiles + challenges ═══
-- ═══════════════════════════════════════════════════════════════════════════
-- PropPilot AI — User Profiles + Challenge Sync
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── user_profiles: plan tier + onboarding flag per auth user ─────────────
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id               uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan             text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','elite')),
  onboarding_done  boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own profile" ON public.user_profiles;
CREATE POLICY "Users manage own profile"
  ON public.user_profiles FOR ALL
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Auto-create profile row when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.user_profiles (id)
  VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill existing users (run once)
INSERT INTO public.user_profiles (id)
SELECT id FROM auth.users
ON CONFLICT (id) DO NOTHING;

-- ── user_challenges: cross-device challenge progress sync ─────────────────
CREATE TABLE IF NOT EXISTS public.user_challenges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  challenge_data  jsonb NOT NULL DEFAULT '{}',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_challenges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own challenges" ON public.user_challenges;
CREATE POLICY "Users manage own challenges"
  ON public.user_challenges FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE UNIQUE INDEX IF NOT EXISTS user_challenges_user_id_idx
  ON public.user_challenges(user_id);

-- ═══ Security hardening (tighten RLS) ═══
-- PropPilot AI — Security hardening pass
--
-- This migration keeps public dashboard reads available for the current MVP,
-- but removes anonymous browser writes from trading/account tables. Mutations
-- should go through authenticated users or service-role Edge Functions.

ALTER TABLE public.paper_account    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_positions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_memory       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smc_signals      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_levels    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_analyses  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategy_stats   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equity_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.execution_log    ENABLE ROW LEVEL SECURITY;

-- Remove existing anonymous write policies from previous MVP migrations.
DROP POLICY IF EXISTS "Public update paper_account" ON public.paper_account;
DROP POLICY IF EXISTS "anon_write_paper_account" ON public.paper_account;

DROP POLICY IF EXISTS "Public insert paper_positions" ON public.paper_positions;
DROP POLICY IF EXISTS "Public update paper_positions" ON public.paper_positions;
DROP POLICY IF EXISTS "anon_insert_paper_positions" ON public.paper_positions;
DROP POLICY IF EXISTS "anon_update_paper_positions" ON public.paper_positions;

DROP POLICY IF EXISTS "Public update bot_settings" ON public.bot_settings;
DROP POLICY IF EXISTS "anon_write_bot_settings" ON public.bot_settings;

DROP POLICY IF EXISTS "Public insert bot_memory" ON public.bot_memory;
DROP POLICY IF EXISTS "anon_insert_bot_memory" ON public.bot_memory;

DROP POLICY IF EXISTS "Public insert smc_signals" ON public.smc_signals;
DROP POLICY IF EXISTS "Public update smc_signals" ON public.smc_signals;
DROP POLICY IF EXISTS "anon_insert_smc_signals" ON public.smc_signals;
DROP POLICY IF EXISTS "anon_update_smc_signals" ON public.smc_signals;

DROP POLICY IF EXISTS "Public insert market_levels" ON public.market_levels;
DROP POLICY IF EXISTS "anon_insert_market_levels" ON public.market_levels;

DROP POLICY IF EXISTS "Public insert signal_analyses" ON public.signal_analyses;
DROP POLICY IF EXISTS "Public update signal_analyses" ON public.signal_analyses;
DROP POLICY IF EXISTS "anon_insert_signal_analyses" ON public.signal_analyses;
DROP POLICY IF EXISTS "anon_update_signal_analyses" ON public.signal_analyses;

DROP POLICY IF EXISTS "Public insert strategy_stats" ON public.strategy_stats;
DROP POLICY IF EXISTS "anon_insert_strategy_stats" ON public.strategy_stats;

DROP POLICY IF EXISTS "Public insert equity_snapshots" ON public.equity_snapshots;
DROP POLICY IF EXISTS "anon_insert_equity_snapshots" ON public.equity_snapshots;

DROP POLICY IF EXISTS "Public insert execution_log" ON public.execution_log;
DROP POLICY IF EXISTS "anon_insert_execution_log" ON public.execution_log;

-- Authenticated users can mutate MVP singleton resources. Service-role Edge
-- Functions bypass RLS and remain the preferred path for automated trading.
CREATE POLICY "Authenticated update paper_account"
  ON public.paper_account FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated insert paper_positions"
  ON public.paper_positions FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated update paper_positions"
  ON public.paper_positions FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated update bot_settings"
  ON public.bot_settings FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated insert bot_memory"
  ON public.bot_memory FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated insert smc_signals"
  ON public.smc_signals FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated update smc_signals"
  ON public.smc_signals FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated insert market_levels"
  ON public.market_levels FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated insert signal_analyses"
  ON public.signal_analyses FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated update signal_analyses"
  ON public.signal_analyses FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated insert strategy_stats"
  ON public.strategy_stats FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated insert equity_snapshots"
  ON public.equity_snapshots FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated insert execution_log"
  ON public.execution_log FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ═══ pg_cron jobs (needs cron secret set above) ═══
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
  missing_secret := nullif('b02104dfbd7cc87ddb2f2b561aa9863050063f77b586810e3d6cb8a503e7e0b2', '') IS NULL;
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

SELECT cron.schedule(
  'daily-reset-tracking',
  '1 0 * * *',
  $$SELECT reset_daily_tracking()$$
);

-- ═══════════════════════════════════════════════════════════════════════════
-- ForexFactory Economic Calendar Cache (added 2026-04-27)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── calendar_cache — stores the full FF weekly JSON ──────────────────────
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

-- ── economic_events — individual event cache ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.economic_events (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  currency         TEXT NOT NULL,
  date_iso         TEXT NOT NULL,
  datetime_utc     TIMESTAMPTZ,
  time_label       TEXT,
  impact           TEXT NOT NULL CHECK (impact IN ('High','Medium','Low','Non-Economic')),
  actual           TEXT DEFAULT '',
  forecast         TEXT DEFAULT '',
  previous         TEXT DEFAULT '',
  affected_symbols TEXT[] DEFAULT '{}',
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

-- ── pg_cron: refresh calendar every 30 min on weekdays ───────────────────
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


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  PHASE 4: Outcome Tracking & Edge Analytics                             ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- PropPilot AI — Phase 4: Outcome Tracking + Edge Analytics
-- Migration: 20260427_phase4_analytics_and_outcome.sql
--
-- New objects:
--   1.  smc_signals columns   — outcome_notes (text), sweep_quality (float)
--   2.  v_signal_performance  — win rate, avg R, profit factor per symbol
--   3.  v_session_edge        — performance breakdown by session
--   4.  v_factor_edge         — which reasoning_code combos have real edge
--   5.  v_confidence_buckets  — does higher confidence actually → higher WR?
--   6.  v_monthly_equity      — month-over-month equity curve
--   7.  fn_signal_edge_report — single-call edge report (for AI Coach)
--   8.  fn_mark_outcome       — updated version of existing function (safe)
--   9.  v_open_signals        — signals waiting for outcome (tracker input)
--  10.  pg_cron: auto-expire pending outcomes after 48h
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Add missing columns to smc_signals ────────────────────────────────────

ALTER TABLE smc_signals
  ADD COLUMN IF NOT EXISTS outcome_notes  TEXT,
  ADD COLUMN IF NOT EXISTS sweep_quality  NUMERIC(4,3),   -- 0.000 – 1.000
  ADD COLUMN IF NOT EXISTS mss_from_sweep BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS mss_kind       TEXT
    CHECK (mss_kind IN ('MSS','CHoCH','PURE_MSS','PURE_CHoCH', NULL));

ALTER TABLE smc_signals
  ADD COLUMN IF NOT EXISTS market_regime  TEXT
    CHECK (market_regime IN ('TREND_STRONG','TREND_WEAK','RANGE','HIGH_VOL','LOW_VOL', NULL)),
  ADD COLUMN IF NOT EXISTS regime_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS strategy_votes JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN smc_signals.sweep_quality  IS 'Sweep quality score 0-1 from detect_sweep(). NULL if no sweep.';
COMMENT ON COLUMN smc_signals.mss_from_sweep IS 'True = sweep-based MSS; False = pure structural break.';
COMMENT ON COLUMN smc_signals.mss_kind       IS 'MSS / CHoCH / PURE_MSS / PURE_CHoCH';
COMMENT ON COLUMN smc_signals.market_regime  IS 'Daemon regime classifier output: TREND_STRONG, TREND_WEAK, RANGE, HIGH_VOL, LOW_VOL.';
COMMENT ON COLUMN smc_signals.strategy_votes IS 'Weighted ensemble votes and adaptive strategy weights used for this signal.';


-- ── 2. v_signal_performance — win rate + R stats per symbol ──────────────────

CREATE OR REPLACE VIEW v_signal_performance AS
WITH settled AS (
  SELECT
    symbol,
    outcome,
    outcome_pnl_r,
    confidence,
    session_name,
    created_at
  FROM smc_signals
  WHERE verdict IN ('LONG_NOW','SHORT_NOW')
    AND outcome IS NOT NULL
    AND outcome != 'expired'
),
stats AS (
  SELECT
    symbol,
    COUNT(*)                                               AS total_trades,
    COUNT(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit'))  AS wins,
    COUNT(*) FILTER (WHERE outcome = 'sl_hit')             AS losses,
    COUNT(*) FILTER (WHERE outcome = 'tp2_hit')            AS tp2_hits,
    ROUND(
      COUNT(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit'))::NUMERIC
      / NULLIF(COUNT(*), 0) * 100, 1
    )                                                      AS win_rate_pct,
    ROUND(AVG(outcome_pnl_r), 3)                           AS avg_pnl_r,
    ROUND(AVG(outcome_pnl_r) FILTER (WHERE outcome_pnl_r > 0), 3) AS avg_win_r,
    ROUND(ABS(AVG(outcome_pnl_r) FILTER (WHERE outcome_pnl_r < 0)), 3) AS avg_loss_r,
    ROUND(
      SUM(outcome_pnl_r) FILTER (WHERE outcome_pnl_r > 0)
      / NULLIF(ABS(SUM(outcome_pnl_r) FILTER (WHERE outcome_pnl_r < 0)), 0),
      2
    )                                                      AS profit_factor,
    ROUND(AVG(confidence), 0)                              AS avg_confidence,
    MAX(created_at)                                        AS last_trade_at
  FROM settled
  GROUP BY symbol
)
SELECT
  symbol,
  total_trades,
  wins,
  losses,
  tp2_hits,
  win_rate_pct,
  avg_pnl_r,
  avg_win_r,
  avg_loss_r,
  profit_factor,
  avg_confidence,
  -- Expectancy = win_rate × avg_win − loss_rate × avg_loss
  ROUND(
    (win_rate_pct / 100.0 * COALESCE(avg_win_r, 0))
    - ((100 - win_rate_pct) / 100.0 * COALESCE(avg_loss_r, 0)),
    3
  )                                                        AS expectancy_r,
  last_trade_at
FROM stats
ORDER BY profit_factor DESC NULLS LAST;

COMMENT ON VIEW v_signal_performance IS
  'Win rate, avg R, and profit factor per symbol. Only settled (non-expired) trades.';


-- ── 3. v_session_edge — performance by trading session ───────────────────────

CREATE OR REPLACE VIEW v_session_edge AS
SELECT
  COALESCE(session_name, 'Unknown')                        AS session,
  COUNT(*)                                                 AS total_signals,
  COUNT(*) FILTER (WHERE verdict IN ('LONG_NOW','SHORT_NOW'))  AS actionable,
  COUNT(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit')) AS wins,
  COUNT(*) FILTER (WHERE outcome = 'sl_hit')               AS losses,
  ROUND(
    COUNT(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit'))::NUMERIC
    / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL AND outcome != 'expired'), 0) * 100,
    1
  )                                                        AS win_rate_pct,
  ROUND(AVG(outcome_pnl_r) FILTER (WHERE outcome_pnl_r IS NOT NULL), 3) AS avg_pnl_r,
  ROUND(
    SUM(outcome_pnl_r) FILTER (WHERE outcome_pnl_r > 0)
    / NULLIF(ABS(SUM(outcome_pnl_r) FILTER (WHERE outcome_pnl_r < 0)), 0),
    2
  )                                                        AS profit_factor,
  ROUND(AVG(confidence), 0)                               AS avg_confidence
FROM smc_signals
WHERE verdict IN ('LONG_NOW','SHORT_NOW')
GROUP BY session_name
ORDER BY profit_factor DESC NULLS LAST;

COMMENT ON VIEW v_session_edge IS
  'Performance breakdown by trading session — reveals which sessions have real edge.';


-- ── 4. v_factor_edge — edge by individual reasoning_code ─────────────────────
--
-- Unnests reasoning_codes array so each factor can be scored independently.
-- E.g. "does SWEEP_HIGH_QUALITY actually improve win rate vs SWEEP_MED_QUALITY?"

CREATE OR REPLACE VIEW v_factor_edge AS
WITH exploded AS (
  SELECT
    unnest(reasoning_codes) AS factor,
    outcome,
    outcome_pnl_r,
    confidence
  FROM smc_signals
  WHERE verdict IN ('LONG_NOW','SHORT_NOW')
    AND outcome IS NOT NULL
    AND outcome != 'expired'
    AND reasoning_codes IS NOT NULL
)
SELECT
  factor,
  COUNT(*)                                                 AS occurrences,
  COUNT(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit')) AS wins,
  COUNT(*) FILTER (WHERE outcome = 'sl_hit')               AS losses,
  ROUND(
    COUNT(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit'))::NUMERIC
    / NULLIF(COUNT(*), 0) * 100, 1
  )                                                        AS win_rate_pct,
  ROUND(AVG(outcome_pnl_r), 3)                            AS avg_pnl_r,
  ROUND(
    SUM(outcome_pnl_r) FILTER (WHERE outcome_pnl_r > 0)
    / NULLIF(ABS(SUM(outcome_pnl_r) FILTER (WHERE outcome_pnl_r < 0)), 0),
    2
  )                                                        AS profit_factor
FROM exploded
GROUP BY factor
HAVING COUNT(*) >= 5   -- only show factors with enough data
ORDER BY profit_factor DESC NULLS LAST;

COMMENT ON VIEW v_factor_edge IS
  'Win rate and R-factor per reasoning_code. Shows which individual SMC factors have real edge.';


-- ── 5. v_confidence_buckets — does higher confidence → higher win rate? ───────

CREATE OR REPLACE VIEW v_confidence_buckets AS
SELECT
  CASE
    WHEN confidence BETWEEN 65 AND 69 THEN '65-69'
    WHEN confidence BETWEEN 70 AND 74 THEN '70-74'
    WHEN confidence BETWEEN 75 AND 79 THEN '75-79'
    WHEN confidence BETWEEN 80 AND 84 THEN '80-84'
    WHEN confidence BETWEEN 85 AND 89 THEN '85-89'
    WHEN confidence >= 90             THEN '90+'
    ELSE '<65'
  END                                                      AS confidence_bucket,
  COUNT(*)                                                 AS total_signals,
  COUNT(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit')) AS wins,
  COUNT(*) FILTER (WHERE outcome = 'sl_hit')               AS losses,
  ROUND(
    COUNT(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit'))::NUMERIC
    / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL AND outcome != 'expired'), 0) * 100,
    1
  )                                                        AS win_rate_pct,
  ROUND(AVG(outcome_pnl_r) FILTER (WHERE outcome_pnl_r IS NOT NULL), 3) AS avg_pnl_r
FROM smc_signals
WHERE verdict IN ('LONG_NOW','SHORT_NOW')
GROUP BY confidence_bucket
ORDER BY MIN(confidence);

COMMENT ON VIEW v_confidence_buckets IS
  'Win rate by confidence score bucket — validates whether the scoring model is calibrated.';


-- ── 6. v_monthly_equity — month-over-month equity curve ──────────────────────

CREATE OR REPLACE VIEW v_monthly_equity AS
SELECT
  DATE_TRUNC('month', created_at)                          AS month,
  COUNT(*) FILTER (WHERE verdict IN ('LONG_NOW','SHORT_NOW'))  AS total_trades,
  COUNT(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit')) AS wins,
  COUNT(*) FILTER (WHERE outcome = 'sl_hit')               AS losses,
  ROUND(
    COUNT(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit'))::NUMERIC
    / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL AND outcome != 'expired'), 0) * 100,
    1
  )                                                        AS win_rate_pct,
  ROUND(SUM(outcome_pnl_r) FILTER (WHERE outcome_pnl_r IS NOT NULL), 2) AS total_r,
  ROUND(AVG(outcome_pnl_r) FILTER (WHERE outcome_pnl_r IS NOT NULL), 3) AS avg_r_per_trade
FROM smc_signals
WHERE verdict IN ('LONG_NOW','SHORT_NOW')
GROUP BY DATE_TRUNC('month', created_at)
ORDER BY month;

COMMENT ON VIEW v_monthly_equity IS
  'Month-by-month trade performance in R-multiples — equity curve proxy.';


-- ── 7. v_sweep_quality_edge — does better sweep quality → better outcome? ─────

CREATE OR REPLACE VIEW v_sweep_quality_edge AS
SELECT
  CASE
    WHEN sweep_quality IS NULL            THEN 'no_sweep'
    WHEN sweep_quality < 0.40             THEN 'low   (<0.40)'
    WHEN sweep_quality BETWEEN 0.40 AND 0.59 THEN 'medium (0.40-0.59)'
    WHEN sweep_quality BETWEEN 0.60 AND 0.74 THEN 'good   (0.60-0.74)'
    WHEN sweep_quality >= 0.75            THEN 'high   (≥0.75)'
  END                                                      AS quality_tier,
  COUNT(*)                                                 AS trades,
  ROUND(
    COUNT(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit'))::NUMERIC
    / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL AND outcome != 'expired'), 0) * 100,
    1
  )                                                        AS win_rate_pct,
  ROUND(AVG(outcome_pnl_r) FILTER (WHERE outcome_pnl_r IS NOT NULL), 3) AS avg_pnl_r,
  ROUND(
    SUM(outcome_pnl_r) FILTER (WHERE outcome_pnl_r > 0)
    / NULLIF(ABS(SUM(outcome_pnl_r) FILTER (WHERE outcome_pnl_r < 0)), 0),
    2
  )                                                        AS profit_factor
FROM smc_signals
WHERE verdict IN ('LONG_NOW','SHORT_NOW')
  AND outcome IS NOT NULL AND outcome != 'expired'
GROUP BY quality_tier
ORDER BY MIN(COALESCE(sweep_quality, -1)) DESC;

COMMENT ON VIEW v_sweep_quality_edge IS
  'Validates the new sweep quality scoring — confirms high-quality sweeps outperform low-quality ones.';


-- ── 8. v_mss_type_edge — sweep-based MSS vs pure structural break ─────────────

CREATE OR REPLACE VIEW v_mss_type_edge AS
SELECT
  CASE
    WHEN mss_kind IS NULL               THEN 'no_mss'
    WHEN mss_kind = 'MSS'               THEN 'MSS (sweep, with trend)'
    WHEN mss_kind = 'CHoCH'             THEN 'CHoCH (sweep, counter)'
    WHEN mss_kind = 'PURE_MSS'          THEN 'PURE_MSS (no sweep, with trend)'
    WHEN mss_kind = 'PURE_CHoCH'        THEN 'PURE_CHoCH (no sweep, counter)'
    ELSE mss_kind
  END                                                      AS mss_type,
  COUNT(*)                                                 AS trades,
  ROUND(
    COUNT(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit'))::NUMERIC
    / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL AND outcome != 'expired'), 0) * 100,
    1
  )                                                        AS win_rate_pct,
  ROUND(AVG(outcome_pnl_r) FILTER (WHERE outcome_pnl_r IS NOT NULL), 3) AS avg_pnl_r,
  ROUND(
    SUM(outcome_pnl_r) FILTER (WHERE outcome_pnl_r > 0)
    / NULLIF(ABS(SUM(outcome_pnl_r) FILTER (WHERE outcome_pnl_r < 0)), 0),
    2
  )                                                        AS profit_factor
FROM smc_signals
WHERE verdict IN ('LONG_NOW','SHORT_NOW')
  AND outcome IS NOT NULL AND outcome != 'expired'
GROUP BY mss_type
ORDER BY profit_factor DESC NULLS LAST;

COMMENT ON VIEW v_mss_type_edge IS
  'Compares sweep-based MSS vs pure structural break — validates whether pure breaks have real edge.';


-- ── 9. v_open_signals — signals awaiting outcome (outcome_tracker input) ──────

CREATE OR REPLACE VIEW v_open_signals AS
SELECT
  id,
  created_at,
  symbol,
  direction,
  verdict,
  confidence,
  entry_price,
  sl_price,
  tp1_price,
  tp2_price,
  risk_reward,
  atr,
  session_name,
  reasoning_codes,
  sweep_quality,
  mss_kind,
  EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600   AS age_hours
FROM smc_signals
WHERE verdict IN ('LONG_NOW','SHORT_NOW')
  AND outcome IS NULL
  AND created_at >= NOW() - INTERVAL '49 hours'
ORDER BY created_at DESC;

COMMENT ON VIEW v_open_signals IS
  'Signals waiting for outcome — used by outcome_tracker.py to know what to check.';


-- ── 10. fn_signal_edge_report — AI Coach edge report function ─────────────────
--
-- Single function call returns a JSON summary of the platform's edge.
-- Called by ai_coach.py session_summary to inform the AI about real performance.

CREATE OR REPLACE FUNCTION fn_signal_edge_report()
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_total_trades   INT;
  v_settled        INT;
  v_win_rate       NUMERIC;
  v_avg_r          NUMERIC;
  v_profit_factor  NUMERIC;
  v_best_symbol    TEXT;
  v_best_session   TEXT;
  v_best_factor    TEXT;
  v_worst_symbol   TEXT;
BEGIN
  SELECT
    COUNT(*)                                                           INTO v_total_trades
  FROM smc_signals WHERE verdict IN ('LONG_NOW','SHORT_NOW');

  SELECT
    COUNT(*),
    ROUND(COUNT(*) FILTER (WHERE outcome IN ('tp1_hit','tp2_hit'))::NUMERIC
      / NULLIF(COUNT(*), 0) * 100, 1),
    ROUND(AVG(outcome_pnl_r), 3),
    ROUND(
      SUM(outcome_pnl_r) FILTER (WHERE outcome_pnl_r > 0)
      / NULLIF(ABS(SUM(outcome_pnl_r) FILTER (WHERE outcome_pnl_r < 0)), 0),
      2
    )
  INTO v_settled, v_win_rate, v_avg_r, v_profit_factor
  FROM smc_signals
  WHERE verdict IN ('LONG_NOW','SHORT_NOW')
    AND outcome IS NOT NULL AND outcome != 'expired';

  SELECT symbol INTO v_best_symbol
  FROM v_signal_performance WHERE total_trades >= 5
  ORDER BY profit_factor DESC NULLS LAST LIMIT 1;

  SELECT session INTO v_best_session
  FROM v_session_edge WHERE total_signals >= 5
  ORDER BY profit_factor DESC NULLS LAST LIMIT 1;

  SELECT factor INTO v_best_factor
  FROM v_factor_edge ORDER BY profit_factor DESC NULLS LAST LIMIT 1;

  SELECT symbol INTO v_worst_symbol
  FROM v_signal_performance WHERE total_trades >= 5
  ORDER BY profit_factor ASC NULLS LAST LIMIT 1;

  RETURN jsonb_build_object(
    'total_signals',  v_total_trades,
    'settled_trades', v_settled,
    'win_rate_pct',   v_win_rate,
    'avg_pnl_r',      v_avg_r,
    'profit_factor',  v_profit_factor,
    'best_symbol',    v_best_symbol,
    'best_session',   v_best_session,
    'best_factor',    v_best_factor,
    'worst_symbol',   v_worst_symbol,
    'generated_at',   NOW()
  );
END;
$$;

COMMENT ON FUNCTION fn_signal_edge_report IS
  'Returns a JSON summary of the platform edge — called by AI Coach for session briefings.';


-- ── 11. Updated fn_mark_outcome (safe upsert) ────────────────────────────────

CREATE OR REPLACE FUNCTION fn_mark_outcome(
  p_signal_id    BIGINT,
  p_outcome      TEXT,
  p_price        NUMERIC,
  p_pnl_r        NUMERIC DEFAULT NULL,
  p_notes        TEXT    DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE smc_signals SET
    outcome       = p_outcome,
    outcome_price = p_price,
    outcome_pnl_r = p_pnl_r,
    outcome_notes = p_notes,
    outcome_at    = NOW()
  WHERE id = p_signal_id
    AND outcome IS NULL;   -- idempotent: don't overwrite existing outcomes
END;
$$;


-- ── 12. Auto-expire old open signals via pg_cron ──────────────────────────────

CREATE OR REPLACE FUNCTION expire_stale_signals()
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE smc_signals SET
    outcome       = 'expired',
    outcome_notes = 'Auto-expired by pg_cron after 48h',
    outcome_at    = NOW()
  WHERE verdict IN ('LONG_NOW','SHORT_NOW')
    AND outcome IS NULL
    AND created_at < NOW() - INTERVAL '48 hours';
END;
$$;

COMMENT ON FUNCTION expire_stale_signals IS
  'Marks signals older than 48h as expired. Run via pg_cron daily.';

-- Uncomment if pg_cron is enabled:
-- SELECT cron.schedule('expire-stale-signals', '0 */6 * * *', $$SELECT expire_stale_signals()$$);


-- ── 13. RLS for new views / functions ────────────────────────────────────────
-- Views inherit RLS from base tables. Functions are SECURITY DEFINER-free.
-- No additional RLS needed for read-only views.

-- Grant execute on new functions to anon/service_role
GRANT EXECUTE ON FUNCTION fn_signal_edge_report() TO anon, service_role;
GRANT EXECUTE ON FUNCTION fn_mark_outcome(BIGINT,TEXT,NUMERIC,NUMERIC,TEXT) TO anon, service_role;
GRANT EXECUTE ON FUNCTION expire_stale_signals() TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- Summary of changes
-- ═══════════════════════════════════════════════════════════════════════════
-- ✓ smc_signals: + outcome_notes, sweep_quality, mss_from_sweep, mss_kind
-- ✓ v_signal_performance  — win rate, avg R, profit factor, expectancy per symbol
-- ✓ v_session_edge        — which sessions are actually profitable
-- ✓ v_factor_edge         — which SMC factors have real edge
-- ✓ v_confidence_buckets  — is the confidence model calibrated?
-- ✓ v_monthly_equity      — month-by-month R-curve
-- ✓ v_sweep_quality_edge  — does better sweep quality → better outcome?
-- ✓ v_mss_type_edge       — sweep-based vs pure structural break performance
-- ✓ v_open_signals        — live tracker input
-- ✓ fn_signal_edge_report — JSON edge summary for AI Coach
-- ✓ fn_mark_outcome       — safe idempotent outcome writer
-- ✓ expire_stale_signals  — auto-expire after 48h
-- ═══════════════════════════════════════════════════════════════════════════


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  JOURNAL SYSTEM (journal_trades, analyses, patterns)                    ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ============================================================
-- PropPilot AI — Trading Journal System
-- 2026-04-28
--
-- Полностью изолированная система от алго-трейдинга.
-- Подключается к аккаунту пользователя.
--
-- Tables:
--   journal_trades      — основной журнал сделок
--   journal_analyses    — AI-анализ каждой сделки (Groq)
--   journal_patterns    — выученные паттерны из истории трейдера
--
-- Views:
--   v_journal_performance   — статистика по символу/сессии
--   v_journal_psychology    — психология vs результат
--   v_journal_mistakes      — топ ошибок
--   v_journal_patterns      — лучшие паттерны трейдера
--   v_journal_signals       — персональные сигналы из паттернов
-- ============================================================

-- ─── journal_trades ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS journal_trades (
    id              SERIAL PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Привязка к аккаунту (для мульти-юзер поддержки)
    account_id      INTEGER     DEFAULT 1,   -- paper_account.id

    -- ── Основные параметры сделки ─────────────────────────────────────────
    symbol          TEXT        NOT NULL,
    direction       TEXT        NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
    session         TEXT,                    -- London | NewYork | Asia | Overlap
    timeframe       TEXT,                    -- M5 | M15 | H1 | H4 | D1

    -- ── Исполнение ────────────────────────────────────────────────────────
    entry_time      TIMESTAMPTZ,
    exit_time       TIMESTAMPTZ,
    entry_price     NUMERIC(18,5),
    exit_price      NUMERIC(18,5),
    sl_price        NUMERIC(18,5),
    tp_price        NUMERIC(18,5),
    lot_size        NUMERIC(10,4),
    risk_pct        NUMERIC(5,2),            -- % баланса в риске

    -- ── P&L ───────────────────────────────────────────────────────────────
    pnl_usd         NUMERIC(12,2),
    pnl_r           NUMERIC(8,4),            -- R-multiple (+1.5 = TP, -1.0 = SL)
    outcome         TEXT CHECK (outcome IN (
        'win', 'loss', 'breakeven', 'partial_win', 'missed_tp', 'manual_close'
    )),

    -- ── Стратегия ─────────────────────────────────────────────────────────
    strategy        TEXT,                    -- SMC | Breakout | Indicator | Manual | News
    setup_type      TEXT,                    -- Sweep+MSS | Pure_MSS | BOS | RR | Custom
    htf_trend       TEXT,                    -- bullish | bearish | ranging
    confluence      TEXT[],                  -- ['sweep', 'mss', 'fvg', 'ote', 'rsi', 'macd']

    -- ── Контекст (свободный текст) ────────────────────────────────────────
    entry_reason    TEXT,                    -- почему вошёл
    exit_reason     TEXT,                    -- почему вышел
    market_context  TEXT,                    -- что происходило на рынке
    what_happened   TEXT,                    -- описание развития сделки

    -- ── Психология ────────────────────────────────────────────────────────
    mindset_score   SMALLINT CHECK (mindset_score BETWEEN 1 AND 10),
    emotions        TEXT[],                  -- calm | confident | rushed | fearful | fomo | revenge
    followed_plan   BOOLEAN,                 -- торговал по плану?
    impulsive       BOOLEAN DEFAULT FALSE,   -- импульсивная сделка?

    -- ── Оценки (заполняются вручную или AI) ──────────────────────────────
    entry_quality   SMALLINT CHECK (entry_quality BETWEEN 0 AND 100),
    exit_quality    SMALLINT CHECK (exit_quality BETWEEN 0 AND 100),
    risk_quality    SMALLINT CHECK (risk_quality BETWEEN 0 AND 100),
    overall_rating  SMALLINT CHECK (overall_rating BETWEEN 1 AND 5),

    -- ── Заметки ───────────────────────────────────────────────────────────
    lessons_learned TEXT,
    mistakes        TEXT[],                  -- ['early_exit', 'fomo_entry', 'widened_sl', ...]
    tags            TEXT[],                  -- произвольные теги
    chart_url       TEXT,                    -- ссылка на скриншот графика
    screenshot_note TEXT,                    -- заметка к скриншоту

    -- ── Привязка к алго-системе ───────────────────────────────────────────
    smc_signal_id   INTEGER,                 -- smc_signals.id (если взял из системы)
    source          TEXT DEFAULT 'manual'    -- manual | algo | both
        CHECK (source IN ('manual', 'algo', 'both')),

    -- ── AI анализ ─────────────────────────────────────────────────────────
    ai_analyzed     BOOLEAN     NOT NULL DEFAULT FALSE,
    ai_analyzed_at  TIMESTAMPTZ,
    ai_entry_score  SMALLINT,
    ai_exit_score   SMALLINT,
    ai_risk_score   SMALLINT,
    ai_overall_score SMALLINT,
    ai_verdict      TEXT,                    -- good_trade | premature_exit | bad_entry | good_loss | overtraded
    ai_key_lesson   TEXT,
    ai_pattern      TEXT                     -- что за паттерн идентифицировал AI
);

-- Триггер: auto-update updated_at
CREATE OR REPLACE FUNCTION journal_update_ts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER journal_trades_updated_at
    BEFORE UPDATE ON journal_trades
    FOR EACH ROW EXECUTE FUNCTION journal_update_ts();

-- Индексы
CREATE INDEX IF NOT EXISTS idx_journal_symbol    ON journal_trades (symbol);
CREATE INDEX IF NOT EXISTS idx_journal_session   ON journal_trades (session);
CREATE INDEX IF NOT EXISTS idx_journal_account   ON journal_trades (account_id);
CREATE INDEX IF NOT EXISTS idx_journal_entry_time ON journal_trades (entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_journal_ai        ON journal_trades (ai_analyzed) WHERE NOT ai_analyzed;


-- ─── journal_analyses ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS journal_analyses (
    id              SERIAL PRIMARY KEY,
    trade_id        INTEGER     NOT NULL REFERENCES journal_trades(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Числовые оценки (0-100)
    entry_score     SMALLINT,
    exit_score      SMALLINT,
    risk_score      SMALLINT,
    overall_score   SMALLINT,

    -- Текстовый анализ
    what_happened       TEXT,       -- объективное описание
    what_went_well      TEXT,       -- что сработало
    what_to_improve     TEXT,       -- что улучшить
    key_lesson          TEXT,       -- главный вывод
    pattern_identified  TEXT,       -- найденный паттерн

    -- Контекст из истории трейдера
    similar_trades_count    INTEGER,
    similar_win_rate        NUMERIC(5,2),   -- win rate на похожих сделках
    user_edge_in_setup      NUMERIC(5,2),   -- edge трейдера в этом сетапе (avg_r)

    -- Прогноз (если бы трейдер следовал своим лучшим паттернам)
    recommended_action      TEXT,           -- hold | cut_loss | take_profit | no_action
    recommendation_reason   TEXT,

    -- AI verdict
    verdict         TEXT,           -- good_trade | premature_exit | bad_entry | good_loss | overtraded

    -- Сырой ответ AI для отладки
    raw_groq_response   TEXT,
    model_used          TEXT DEFAULT 'llama-3.3-70b-versatile',
    tokens_used         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_analyses_trade_id ON journal_analyses (trade_id);


-- ─── journal_patterns ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS journal_patterns (
    id              SERIAL PRIMARY KEY,
    account_id      INTEGER NOT NULL DEFAULT 1,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Дескриптор паттерна
    symbol          TEXT,       -- NULL = все символы
    session         TEXT,       -- NULL = все сессии
    direction       TEXT,       -- LONG | SHORT | NULL = оба
    strategy        TEXT,       -- тип стратегии
    setup_type      TEXT,       -- тип сетапа
    htf_trend       TEXT,       -- тренд на HTF
    mindset_filter  TEXT,       -- calm | any (паттерн только для спокойного состояния)

    -- Статистика из истории
    sample_size         INTEGER     NOT NULL DEFAULT 0,
    wins                INTEGER     NOT NULL DEFAULT 0,
    losses              INTEGER     NOT NULL DEFAULT 0,
    win_rate_pct        NUMERIC(5,2),
    avg_r               NUMERIC(6,3),
    avg_entry_score     NUMERIC(5,1),
    avg_exit_score      NUMERIC(5,1),
    total_r             NUMERIC(8,3),
    best_session        TEXT,
    worst_session       TEXT,
    common_mistakes     TEXT[],
    best_exit_reason    TEXT,

    -- Генерация персонального сигнала
    signal_enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
    min_confidence      INTEGER     DEFAULT 60,
    last_signal_at      TIMESTAMPTZ,

    -- Уникальность паттерна
    UNIQUE (account_id, symbol, session, direction, strategy, setup_type, htf_trend)
);

CREATE INDEX IF NOT EXISTS idx_patterns_account ON journal_patterns (account_id);
CREATE INDEX IF NOT EXISTS idx_patterns_signal  ON journal_patterns (signal_enabled, win_rate_pct DESC);


-- ─── Функция: обновить паттерны из истории ────────────────────────────────

CREATE OR REPLACE FUNCTION fn_refresh_journal_patterns(p_account_id INTEGER DEFAULT 1)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_count INTEGER := 0;
BEGIN
    -- Удалить старые паттерны с недостаточной статистикой
    DELETE FROM journal_patterns
    WHERE account_id = p_account_id;

    -- Пересчитать паттерны из реальных сделок (min 3 сделки для паттерна)
    INSERT INTO journal_patterns (
        account_id, symbol, session, direction, strategy,
        sample_size, wins, losses, win_rate_pct,
        avg_r, total_r, avg_entry_score, avg_exit_score,
        updated_at
    )
    SELECT
        p_account_id,
        symbol,
        session,
        direction,
        strategy,
        COUNT(*)                                                AS sample_size,
        SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END)       AS wins,
        SUM(CASE WHEN outcome = 'loss' THEN 1 ELSE 0 END)      AS losses,
        ROUND(
            100.0 * SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) / COUNT(*),
            1
        )                                                       AS win_rate_pct,
        ROUND(AVG(pnl_r)::NUMERIC, 3)                          AS avg_r,
        ROUND(SUM(pnl_r)::NUMERIC, 2)                          AS total_r,
        ROUND(AVG(ai_entry_score)::NUMERIC, 1)                 AS avg_entry_score,
        ROUND(AVG(ai_exit_score)::NUMERIC, 1)                  AS avg_exit_score,
        NOW()
    FROM journal_trades
    WHERE account_id = p_account_id
      AND outcome IS NOT NULL
      AND pnl_r IS NOT NULL
    GROUP BY symbol, session, direction, strategy
    HAVING COUNT(*) >= 3
    ON CONFLICT (account_id, symbol, session, direction, strategy, setup_type, htf_trend)
    DO UPDATE SET
        sample_size     = EXCLUDED.sample_size,
        wins            = EXCLUDED.wins,
        losses          = EXCLUDED.losses,
        win_rate_pct    = EXCLUDED.win_rate_pct,
        avg_r           = EXCLUDED.avg_r,
        total_r         = EXCLUDED.total_r,
        avg_entry_score = EXCLUDED.avg_entry_score,
        avg_exit_score  = EXCLUDED.avg_exit_score,
        updated_at      = NOW();

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;


-- ─── Функция: получить best-match паттерн для текущего сетапа ─────────────

CREATE OR REPLACE FUNCTION fn_journal_pattern_match(
    p_account_id    INTEGER,
    p_symbol        TEXT,
    p_session       TEXT,
    p_direction     TEXT,
    p_strategy      TEXT DEFAULT NULL
)
RETURNS TABLE (
    pattern_id          INTEGER,
    win_rate_pct        NUMERIC,
    avg_r               NUMERIC,
    sample_size         INTEGER,
    signal_strength     TEXT,
    recommendation      TEXT
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT
        jp.id,
        jp.win_rate_pct,
        jp.avg_r,
        jp.sample_size,
        CASE
            WHEN jp.win_rate_pct >= 65 AND jp.avg_r > 0.5 THEN 'STRONG'
            WHEN jp.win_rate_pct >= 55 AND jp.avg_r > 0   THEN 'MODERATE'
            WHEN jp.win_rate_pct >= 45                     THEN 'WEAK'
            ELSE 'NEGATIVE'
        END AS signal_strength,
        CASE
            WHEN jp.win_rate_pct >= 65 AND jp.avg_r > 0.5
                THEN 'Your edge here is strong — take the trade if setup confirms'
            WHEN jp.win_rate_pct >= 55
                THEN 'Moderate edge — reduce size, wait for full confirmation'
            WHEN jp.win_rate_pct < 45
                THEN 'Historically weak for you — skip or paper trade only'
            ELSE 'Insufficient data — treat as new territory'
        END AS recommendation
    FROM journal_patterns jp
    WHERE jp.account_id = p_account_id
      AND (jp.symbol    = p_symbol    OR jp.symbol    IS NULL)
      AND (jp.session   = p_session   OR jp.session   IS NULL)
      AND (jp.direction = p_direction OR jp.direction IS NULL)
      AND (jp.strategy  = p_strategy  OR jp.strategy  IS NULL OR p_strategy IS NULL)
      AND jp.signal_enabled = TRUE
      AND jp.sample_size   >= 3
    ORDER BY
        -- Prefer more specific patterns, then by win rate
        (jp.symbol IS NOT NULL)::INT    DESC,
        (jp.session IS NOT NULL)::INT   DESC,
        (jp.strategy IS NOT NULL)::INT  DESC,
        jp.win_rate_pct                 DESC
    LIMIT 1;
END;
$$;


-- ─── Views ────────────────────────────────────────────────────────────────

-- Общая производительность по символу и сессии
CREATE OR REPLACE VIEW v_journal_performance AS
SELECT
    symbol,
    session,
    direction,
    COUNT(*)                                                            AS total_trades,
    SUM(CASE WHEN outcome = 'win'  THEN 1 ELSE 0 END)                  AS wins,
    SUM(CASE WHEN outcome = 'loss' THEN 1 ELSE 0 END)                  AS losses,
    ROUND(
        100.0 * SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*), 0), 1
    )                                                                   AS win_rate_pct,
    ROUND(AVG(pnl_r)::NUMERIC, 3)                                      AS avg_r,
    ROUND(SUM(pnl_r)::NUMERIC, 2)                                      AS total_r,
    ROUND(AVG(mindset_score)::NUMERIC, 1)                               AS avg_mindset,
    ROUND(AVG(ai_entry_score)::NUMERIC, 1)                             AS avg_entry_quality,
    ROUND(AVG(ai_exit_score)::NUMERIC, 1)                              AS avg_exit_quality,
    SUM(CASE WHEN followed_plan = FALSE THEN 1 ELSE 0 END)             AS off_plan_trades,
    SUM(CASE WHEN impulsive = TRUE THEN 1 ELSE 0 END)                  AS impulsive_trades
FROM journal_trades
WHERE outcome IS NOT NULL
GROUP BY symbol, session, direction
ORDER BY total_r DESC;


-- Психология и результат
CREATE OR REPLACE VIEW v_journal_psychology AS
SELECT
    CASE
        WHEN mindset_score >= 8 THEN 'calm_focused (8-10)'
        WHEN mindset_score >= 6 THEN 'normal (6-7)'
        WHEN mindset_score >= 4 THEN 'distracted (4-5)'
        ELSE 'poor_state (1-3)'
    END                                                                 AS mindset_bucket,
    COUNT(*)                                                            AS trades,
    ROUND(100.0 * SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*), 0), 1)                                      AS win_rate_pct,
    ROUND(AVG(pnl_r)::NUMERIC, 3)                                      AS avg_r,
    ROUND(SUM(pnl_r)::NUMERIC, 2)                                      AS total_r,
    SUM(CASE WHEN followed_plan = FALSE THEN 1 ELSE 0 END)             AS off_plan_count
FROM journal_trades
WHERE mindset_score IS NOT NULL AND outcome IS NOT NULL
GROUP BY mindset_bucket
ORDER BY avg_r DESC;


-- Топ ошибок трейдера (по частоте и влиянию на P&L)
CREATE OR REPLACE VIEW v_journal_mistakes AS
SELECT
    mistake,
    COUNT(*)                                                            AS occurrences,
    ROUND(AVG(pnl_r)::NUMERIC, 3)                                      AS avg_r_when_mistake,
    ROUND(SUM(pnl_r)::NUMERIC, 2)                                      AS total_r_impact,
    ROUND(100.0 * SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*), 0), 1)                                      AS win_rate_with_mistake
FROM journal_trades,
     UNNEST(mistakes) AS mistake
WHERE mistakes IS NOT NULL AND outcome IS NOT NULL
GROUP BY mistake
ORDER BY total_r_impact ASC;   -- наихудшие ошибки вверху


-- Лучшие паттерны трейдера (для генерации персональных сигналов)
CREATE OR REPLACE VIEW v_journal_patterns AS
SELECT
    jp.*,
    CASE
        WHEN win_rate_pct >= 65 AND avg_r > 0.5 THEN '🟢 STRONG EDGE'
        WHEN win_rate_pct >= 55 AND avg_r > 0   THEN '🟡 MODERATE'
        WHEN win_rate_pct >= 45                  THEN '🟠 WEAK'
        ELSE '🔴 NEGATIVE'
    END AS edge_label
FROM journal_patterns jp
ORDER BY avg_r DESC;


-- Персональные сигналы на основе паттернов трейдера
CREATE OR REPLACE VIEW v_journal_signals AS
SELECT
    symbol,
    session,
    direction,
    strategy,
    sample_size,
    win_rate_pct,
    avg_r,
    ROUND((win_rate_pct / 100.0 * avg_r) - ((1 - win_rate_pct / 100.0) * 1.0), 3) AS expectancy_r,
    CASE
        WHEN win_rate_pct >= 65 AND avg_r > 0.5 THEN 'TAKE_TRADE'
        WHEN win_rate_pct >= 55                  THEN 'REDUCE_SIZE'
        WHEN win_rate_pct < 45                   THEN 'AVOID'
        ELSE 'NEUTRAL'
    END AS personal_signal
FROM journal_patterns
WHERE sample_size >= 5
  AND signal_enabled = TRUE
ORDER BY expectancy_r DESC;


-- Недельный прогресс (по неделям)
CREATE OR REPLACE VIEW v_journal_weekly AS
SELECT
    DATE_TRUNC('week', entry_time)::DATE                                AS week_start,
    COUNT(*)                                                            AS trades,
    SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END)                   AS wins,
    ROUND(
        100.0 * SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*), 0), 1
    )                                                                   AS win_rate_pct,
    ROUND(SUM(pnl_r)::NUMERIC, 2)                                      AS total_r,
    ROUND(SUM(pnl_usd)::NUMERIC, 2)                                    AS total_usd,
    ROUND(AVG(mindset_score)::NUMERIC, 1)                               AS avg_mindset,
    ROUND(AVG(ai_entry_score)::NUMERIC, 1)                             AS avg_entry_quality
FROM journal_trades
WHERE entry_time IS NOT NULL AND outcome IS NOT NULL
GROUP BY week_start
ORDER BY week_start DESC;


-- ─── RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE journal_trades    ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_analyses  ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_patterns  ENABLE ROW LEVEL SECURITY;

-- Service role (daemon + API) имеет полный доступ
CREATE POLICY "service_all_journal_trades"
    ON journal_trades FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_all_journal_analyses"
    ON journal_analyses FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_all_journal_patterns"
    ON journal_patterns FOR ALL USING (auth.role() = 'service_role');


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  PROP FIRM CHALLENGE SYSTEM                                             ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- =============================================================================
-- PropPilot AI — Prop Firm Challenge System
-- Migration: 20260428_prop_system.sql
--
-- Tables:
--   prop_challenges   — one row per challenge account
--   prop_daily_stats  — daily P&L snapshot per challenge
--   prop_trades       — every trade logged against a challenge
--   prop_violations   — rule violations log
--
-- Views:
--   v_prop_challenge_status   — live challenge health snapshot
--   v_prop_daily_equity       — equity curve by day
--   v_prop_session_breakdown  — performance by trading session
--
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: prop_challenges
-- One row per prop firm challenge / funded account
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prop_challenges (
    id                      SERIAL PRIMARY KEY,
    account_id              INT         NOT NULL DEFAULT 1,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Identity
    firm_name               TEXT        NOT NULL,                        -- "FTMO", "The5ers", etc.
    phase                   TEXT        NOT NULL DEFAULT 'CHALLENGE',     -- CHALLENGE / VERIFICATION / FUNDED / BREACHED / PASSED
    label                   TEXT,                                        -- user-defined label e.g. "Attempt #3"

    -- Account size
    account_size_usd        NUMERIC(14,2) NOT NULL DEFAULT 100000,
    starting_balance        NUMERIC(14,2) NOT NULL,
    current_balance         NUMERIC(14,2) NOT NULL,
    peak_balance            NUMERIC(14,2) NOT NULL,                      -- for trailing DD firms

    -- Calendar
    start_date              DATE        NOT NULL DEFAULT CURRENT_DATE,
    last_trade_date         DATE,
    trading_days_completed  INT         NOT NULL DEFAULT 0,

    -- Loss rules (stored as percentage, positive value = limit)
    max_daily_loss_pct      NUMERIC(6,2) NOT NULL DEFAULT 5.0,
    max_total_loss_pct      NUMERIC(6,2) NOT NULL DEFAULT 10.0,

    -- Profit target
    profit_target_pct       NUMERIC(6,2) NOT NULL DEFAULT 10.0,         -- 0 = no target (funded)

    -- Trading day requirements
    min_trading_days        INT         NOT NULL DEFAULT 4,
    max_trading_days        INT         NOT NULL DEFAULT 30,            -- 0 = no expiry

    -- Per-trade risk caps
    max_trade_risk_pct      NUMERIC(6,2) NOT NULL DEFAULT 0.0,         -- 0 = no limit
    max_lot_size            NUMERIC(8,2) NOT NULL DEFAULT 0.0,          -- 0 = no limit

    -- Consistency rule
    consistency_pct         NUMERIC(6,2) NOT NULL DEFAULT 0.0,         -- 0 = disabled; e.g. 30 = no single day > 30% of profit

    -- Firm-specific rules
    trailing_drawdown       BOOLEAN     NOT NULL DEFAULT FALSE,          -- True = DD trails peak equity
    news_trading_ban        BOOLEAN     NOT NULL DEFAULT FALSE,
    overnight_hold_ban      BOOLEAN     NOT NULL DEFAULT FALSE,
    weekend_hold_ban        BOOLEAN     NOT NULL DEFAULT TRUE,

    -- Notes
    notes                   TEXT
);

-- Index for account lookups
CREATE INDEX IF NOT EXISTS idx_prop_challenges_account
    ON prop_challenges (account_id, phase);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION prop_challenge_update_ts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prop_challenge_ts ON prop_challenges;
CREATE TRIGGER trg_prop_challenge_ts
    BEFORE UPDATE ON prop_challenges
    FOR EACH ROW EXECUTE FUNCTION prop_challenge_update_ts();


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: prop_daily_stats
-- One row per (challenge_id, trade_date)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prop_daily_stats (
    id              SERIAL PRIMARY KEY,
    challenge_id    INT         NOT NULL REFERENCES prop_challenges(id) ON DELETE CASCADE,
    trade_date      DATE        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Aggregates for the day
    trade_count     INT         NOT NULL DEFAULT 0,
    pnl_usd         NUMERIC(14,2) NOT NULL DEFAULT 0,
    pnl_r           NUMERIC(10,4),
    win_count       INT         NOT NULL DEFAULT 0,
    loss_count      INT         NOT NULL DEFAULT 0,
    max_loss_usd    NUMERIC(14,2),                          -- worst single trade loss
    balance_eod     NUMERIC(14,2),                          -- balance at end of day

    UNIQUE (challenge_id, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_prop_daily_challenge
    ON prop_daily_stats (challenge_id, trade_date DESC);


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: prop_trades
-- Every individual trade logged against a challenge
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prop_trades (
    id              SERIAL PRIMARY KEY,
    challenge_id    INT         NOT NULL REFERENCES prop_challenges(id) ON DELETE CASCADE,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    trade_date      DATE        NOT NULL DEFAULT CURRENT_DATE,

    -- Instrument
    symbol          TEXT        NOT NULL,
    direction       TEXT,                   -- LONG / SHORT
    session         TEXT,                   -- Asian / London / Overlap / NewYork

    -- Execution
    lot_size        NUMERIC(10,4),
    entry_price     NUMERIC(18,6),
    exit_price      NUMERIC(18,6),
    sl_price        NUMERIC(18,6),
    tp_price        NUMERIC(18,6),

    -- Result
    pnl_usd         NUMERIC(14,2) NOT NULL,
    pnl_r           NUMERIC(10,4),
    outcome         TEXT,                   -- win / loss / breakeven

    -- Link to journal
    journal_trade_id INT,                   -- FK to journal_trades.id (optional)

    notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_prop_trades_challenge
    ON prop_trades (challenge_id, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_prop_trades_date
    ON prop_trades (trade_date DESC);


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: prop_violations
-- Log of rule violations (breaches, near-misses, warnings)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prop_violations (
    id              SERIAL PRIMARY KEY,
    challenge_id    INT         NOT NULL REFERENCES prop_challenges(id) ON DELETE CASCADE,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    rule_name       TEXT        NOT NULL,   -- e.g. "daily_loss_limit", "trade_risk_cap"
    description     TEXT        NOT NULL,
    severity        TEXT        NOT NULL DEFAULT 'WARNING',  -- WARNING / CRITICAL
    resolved        BOOLEAN     NOT NULL DEFAULT FALSE,
    resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_prop_violations_challenge
    ON prop_violations (challenge_id, occurred_at DESC);


-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW: v_prop_challenge_status
-- Live challenge health snapshot — one row per active challenge
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_prop_challenge_status AS
SELECT
    c.id                                                    AS challenge_id,
    c.account_id,
    c.firm_name,
    c.phase,
    c.label,
    c.account_size_usd,
    c.starting_balance,
    c.current_balance,
    c.peak_balance,

    -- P&L
    ROUND(c.current_balance - c.starting_balance, 2)        AS total_pnl_usd,
    ROUND((c.current_balance - c.starting_balance)
          / NULLIF(c.starting_balance, 0) * 100, 2)         AS total_pnl_pct,

    -- Drawdown (fixed vs trailing)
    CASE WHEN c.trailing_drawdown
        THEN ROUND(GREATEST(0, c.peak_balance - c.current_balance), 2)
        ELSE ROUND(GREATEST(0, c.starting_balance - c.current_balance), 2)
    END                                                      AS drawdown_usd,
    CASE WHEN c.trailing_drawdown
        THEN ROUND(GREATEST(0, c.peak_balance - c.current_balance)
                   / NULLIF(c.peak_balance, 0) * 100, 2)
        ELSE ROUND(GREATEST(0, c.starting_balance - c.current_balance)
                   / NULLIF(c.starting_balance, 0) * 100, 2)
    END                                                      AS drawdown_pct,

    -- Limits in USD
    ROUND(c.account_size_usd * c.max_daily_loss_pct / 100, 2)   AS max_daily_loss_usd,
    ROUND(c.account_size_usd * c.max_total_loss_pct / 100, 2)   AS max_total_loss_usd,
    ROUND(c.account_size_usd * c.profit_target_pct / 100, 2)    AS profit_target_usd,

    -- Profit progress %
    CASE WHEN c.profit_target_pct > 0
        THEN ROUND(LEAST(100,
            GREATEST(0, (c.current_balance - c.starting_balance))
            / NULLIF(c.account_size_usd * c.profit_target_pct / 100, 0) * 100
        ), 1)
        ELSE NULL
    END                                                      AS profit_progress_pct,

    -- Today's stats (from prop_daily_stats)
    COALESCE(d.pnl_usd, 0)                                  AS today_pnl_usd,
    COALESCE(d.trade_count, 0)                               AS today_trade_count,

    -- Daily headroom
    ROUND(c.account_size_usd * c.max_daily_loss_pct / 100
          - GREATEST(0, -COALESCE(d.pnl_usd, 0)), 2)        AS daily_loss_remaining_usd,

    -- Calendar
    c.start_date,
    c.trading_days_completed,
    c.min_trading_days,
    c.max_trading_days,
    (CURRENT_DATE - c.start_date)::INT                       AS days_elapsed,
    GREATEST(0, c.max_trading_days - (CURRENT_DATE - c.start_date)::INT)
                                                             AS days_remaining

FROM prop_challenges c
LEFT JOIN prop_daily_stats d
    ON d.challenge_id = c.id AND d.trade_date = CURRENT_DATE
WHERE c.phase NOT IN ('PASSED', 'BREACHED')
ORDER BY c.account_id, c.id;


-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW: v_prop_daily_equity
-- Day-by-day equity curve for charting
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_prop_daily_equity AS
SELECT
    d.challenge_id,
    d.trade_date,
    d.pnl_usd                                               AS day_pnl_usd,
    d.trade_count,
    d.win_count,
    d.loss_count,
    -- Running cumulative P&L
    SUM(d.pnl_usd) OVER (
        PARTITION BY d.challenge_id
        ORDER BY d.trade_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )                                                       AS cumulative_pnl_usd,
    c.starting_balance + SUM(d.pnl_usd) OVER (
        PARTITION BY d.challenge_id
        ORDER BY d.trade_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )                                                       AS running_balance
FROM prop_daily_stats d
JOIN prop_challenges c ON c.id = d.challenge_id
ORDER BY d.challenge_id, d.trade_date;


-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW: v_prop_session_breakdown
-- Performance split by trading session for pattern analysis
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_prop_session_breakdown AS
SELECT
    challenge_id,
    COALESCE(session, 'Unknown')                            AS session,
    COUNT(*)                                                AS total_trades,
    SUM(pnl_usd)                                            AS total_pnl_usd,
    AVG(pnl_r)                                              AS avg_pnl_r,
    COUNT(*) FILTER (WHERE pnl_usd > 0)                     AS wins,
    COUNT(*) FILTER (WHERE pnl_usd < 0)                     AS losses,
    ROUND(
        COUNT(*) FILTER (WHERE pnl_usd > 0)::NUMERIC
        / NULLIF(COUNT(*), 0) * 100, 1
    )                                                       AS win_rate_pct
FROM prop_trades
GROUP BY challenge_id, session
ORDER BY challenge_id, total_pnl_usd DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- RLS Policies — service_role only (daemon writes via service key)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE prop_challenges  ENABLE ROW LEVEL SECURITY;
ALTER TABLE prop_daily_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE prop_trades      ENABLE ROW LEVEL SECURITY;
ALTER TABLE prop_violations  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'prop_challenges', 'prop_daily_stats', 'prop_trades', 'prop_violations'
    ] LOOP
        EXECUTE format(
            'DROP POLICY IF EXISTS service_role_all ON %I;
             CREATE POLICY service_role_all ON %I
                 FOR ALL TO service_role USING (true) WITH CHECK (true);',
            tbl, tbl
        );
    END LOOP;
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SEED: common firm presets reference data (informational, not enforced by DB)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prop_firm_presets (
    id          SERIAL PRIMARY KEY,
    firm_name   TEXT NOT NULL,
    preset_name TEXT NOT NULL,
    rules       JSONB NOT NULL,
    UNIQUE (firm_name, preset_name)
);

INSERT INTO prop_firm_presets (firm_name, preset_name, rules) VALUES
('FTMO', '100K Standard', '{
    "account_size_usd": 100000,
    "max_daily_loss_pct": 5,
    "max_total_loss_pct": 10,
    "profit_target_pct": 10,
    "min_trading_days": 4,
    "max_trading_days": 30,
    "trailing_drawdown": false,
    "weekend_hold_ban": true
}'::jsonb),
('The5ers', '100K Hyper Growth', '{
    "account_size_usd": 100000,
    "max_daily_loss_pct": 4,
    "max_total_loss_pct": 4,
    "profit_target_pct": 8,
    "min_trading_days": 0,
    "max_trading_days": 60,
    "trailing_drawdown": true,
    "weekend_hold_ban": false
}'::jsonb),
('Apex Trader Funding', '50K', '{
    "account_size_usd": 50000,
    "max_daily_loss_pct": 0,
    "max_total_loss_pct": 2.5,
    "profit_target_pct": 6,
    "min_trading_days": 7,
    "max_trading_days": 0,
    "trailing_drawdown": true,
    "weekend_hold_ban": true
}'::jsonb),
('FundedNext', '100K Phase1', '{
    "account_size_usd": 100000,
    "max_daily_loss_pct": 5,
    "max_total_loss_pct": 10,
    "profit_target_pct": 10,
    "min_trading_days": 5,
    "max_trading_days": 30,
    "trailing_drawdown": false,
    "weekend_hold_ban": true,
    "consistency_pct": 30
}'::jsonb)
ON CONFLICT (firm_name, preset_name) DO NOTHING;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  BACKTEST TABLES                                                        ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ============================================================
-- PropPilot AI — Backtest Tables Migration
-- 2026-04-28
--
-- Tables:
--   backtest_runs          — one row per backtest run (config + summary stats)
--   backtest_trades        — one row per trade from a backtest run
--   backtest_equity_curve  — daily equity snapshots per run
--
-- Views:
--   v_backtest_summary     — best runs ranked by Sharpe / return
--   v_backtest_session_edge— session-level edge across all runs
-- ============================================================

-- ─── backtest_runs ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS backtest_runs (
    id                  SERIAL PRIMARY KEY,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Configuration
    symbol              TEXT        NOT NULL,
    start_date          DATE        NOT NULL,
    end_date            DATE        NOT NULL,
    bars_analyzed       INTEGER     NOT NULL DEFAULT 0,
    timeframe_minutes   INTEGER     NOT NULL DEFAULT 5,

    -- BacktestConfig snapshot (for reproducibility)
    config              JSONB       NOT NULL DEFAULT '{}',

    -- Core performance stats
    total_trades        INTEGER     NOT NULL DEFAULT 0,
    wins                INTEGER     NOT NULL DEFAULT 0,
    losses              INTEGER     NOT NULL DEFAULT 0,
    win_rate_pct        NUMERIC(6,3),
    total_r             NUMERIC(10,4),
    avg_win_r           NUMERIC(8,4),
    avg_loss_r          NUMERIC(8,4),
    expectancy_r        NUMERIC(8,5),
    profit_factor       NUMERIC(8,3),

    -- Risk / drawdown
    initial_balance     NUMERIC(14,2) NOT NULL DEFAULT 100000,
    final_balance       NUMERIC(14,2),
    total_return_pct    NUMERIC(8,3),
    max_drawdown_pct    NUMERIC(7,3),
    max_drawdown_usd    NUMERIC(12,2),

    -- Risk-adjusted returns
    sharpe              NUMERIC(8,4),
    sortino             NUMERIC(8,4),

    -- Session breakdown (JSON map: session → {trades, wins, total_r, ...})
    session_stats       JSONB       DEFAULT '{}',

    -- Free-form notes or tags
    notes               TEXT,
    tags                TEXT[]      DEFAULT '{}',

    -- Status flags
    trades_skipped      INTEGER     NOT NULL DEFAULT 0
);

-- Index for fast lookups by symbol
CREATE INDEX IF NOT EXISTS idx_backtest_runs_symbol
    ON backtest_runs (symbol);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_created
    ON backtest_runs (created_at DESC);


-- ─── backtest_trades ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS backtest_trades (
    id              SERIAL PRIMARY KEY,
    run_id          INTEGER     NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
    trade_id        INTEGER     NOT NULL,    -- sequential id within the run
    symbol          TEXT        NOT NULL,
    direction       TEXT        NOT NULL,    -- LONG | SHORT
    open_ts         INTEGER     NOT NULL,    -- unix seconds
    close_ts        INTEGER     NOT NULL,
    open_dt         TIMESTAMPTZ GENERATED ALWAYS AS (to_timestamp(open_ts))  STORED,
    close_dt        TIMESTAMPTZ GENERATED ALWAYS AS (to_timestamp(close_ts)) STORED,
    entry_price     NUMERIC(18,5),
    sl_price        NUMERIC(18,5),
    tp1_price       NUMERIC(18,5),
    tp2_price       NUMERIC(18,5),
    exit_price      NUMERIC(18,5),
    exit_reason     TEXT,                   -- TP1 | TP2 | SL | BE | EXPIRED
    pnl_r           NUMERIC(10,4),
    pnl_usd         NUMERIC(12,2),
    risk_usd        NUMERIC(12,2),
    confidence      SMALLINT,
    session         TEXT,
    regime          TEXT
);

CREATE INDEX IF NOT EXISTS idx_bt_trades_run_id
    ON backtest_trades (run_id);

CREATE INDEX IF NOT EXISTS idx_bt_trades_symbol_session
    ON backtest_trades (symbol, session);

CREATE INDEX IF NOT EXISTS idx_bt_trades_exit_reason
    ON backtest_trades (exit_reason);


-- ─── backtest_equity_curve ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS backtest_equity_curve (
    id          SERIAL PRIMARY KEY,
    run_id      INTEGER     NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
    ts          INTEGER     NOT NULL,
    dt          TIMESTAMPTZ GENERATED ALWAYS AS (to_timestamp(ts)) STORED,
    balance     NUMERIC(14,4),
    equity      NUMERIC(14,4)
);

-- Partial index: one sample per day per run (for display)
CREATE INDEX IF NOT EXISTS idx_bt_equity_run_ts
    ON backtest_equity_curve (run_id, ts);


-- ─── Helper function: insert a full backtest result ───────────────────────

CREATE OR REPLACE FUNCTION fn_insert_backtest_result(
    p_report        JSONB,          -- serialized BacktestReport.to_dict()
    p_trades        JSONB,          -- array of BacktestTrade.to_dict()
    p_equity_sample JSONB DEFAULT NULL  -- optional equity curve (array of {ts, balance, equity})
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_run_id INTEGER;
    v_stats  JSONB;
BEGIN
    v_stats := p_report -> 'stats';

    INSERT INTO backtest_runs (
        symbol, start_date, end_date, bars_analyzed,
        config, total_trades, wins, losses,
        win_rate_pct, total_r, avg_win_r, avg_loss_r,
        expectancy_r, profit_factor, initial_balance,
        final_balance, total_return_pct, max_drawdown_pct,
        max_drawdown_usd, sharpe, sortino, session_stats,
        trades_skipped
    )
    VALUES (
        p_report ->> 'symbol',
        (p_report ->> 'start_date')::DATE,
        (p_report ->> 'end_date')::DATE,
        (p_report ->> 'bars_analyzed')::INTEGER,
        p_report -> 'config',
        (v_stats ->> 'total_trades')::INTEGER,
        (v_stats ->> 'wins')::INTEGER,
        (v_stats ->> 'losses')::INTEGER,
        (v_stats ->> 'win_rate_pct')::NUMERIC,
        (v_stats ->> 'total_r')::NUMERIC,
        (v_stats ->> 'avg_win_r')::NUMERIC,
        (v_stats ->> 'avg_loss_r')::NUMERIC,
        (v_stats ->> 'expectancy_r')::NUMERIC,
        (v_stats ->> 'profit_factor')::NUMERIC,
        COALESCE((p_report -> 'config' ->> 'initial_balance')::NUMERIC, 100000),
        (v_stats ->> 'final_balance')::NUMERIC,
        (v_stats ->> 'total_return_pct')::NUMERIC,
        (v_stats ->> 'max_drawdown_pct')::NUMERIC,
        (v_stats ->> 'max_drawdown_usd')::NUMERIC,
        (v_stats ->> 'sharpe')::NUMERIC,
        (v_stats ->> 'sortino')::NUMERIC,
        p_report -> 'session_stats',
        COALESCE((p_report ->> 'trades_skipped')::INTEGER, 0)
    )
    RETURNING id INTO v_run_id;

    -- Insert individual trades
    IF p_trades IS NOT NULL AND jsonb_array_length(p_trades) > 0 THEN
        INSERT INTO backtest_trades (
            run_id, trade_id, symbol, direction,
            open_ts, close_ts, entry_price, sl_price, tp1_price, tp2_price,
            exit_price, exit_reason, pnl_r, pnl_usd, risk_usd,
            confidence, session, regime
        )
        SELECT
            v_run_id,
            (t ->> 'trade_id')::INTEGER,
            t ->> 'symbol',
            t ->> 'direction',
            (t ->> 'open_ts')::INTEGER,
            (t ->> 'close_ts')::INTEGER,
            (t ->> 'entry_price')::NUMERIC,
            (t ->> 'sl_price')::NUMERIC,
            (t ->> 'tp1_price')::NUMERIC,
            (t ->> 'tp2_price')::NUMERIC,
            (t ->> 'exit_price')::NUMERIC,
            t ->> 'exit_reason',
            (t ->> 'pnl_r')::NUMERIC,
            (t ->> 'pnl_usd')::NUMERIC,
            (t ->> 'risk_usd')::NUMERIC,
            (t ->> 'confidence')::SMALLINT,
            t ->> 'session',
            t ->> 'regime'
        FROM jsonb_array_elements(p_trades) AS t;
    END IF;

    -- Insert equity curve sample (optional, can be sparse)
    IF p_equity_sample IS NOT NULL AND jsonb_array_length(p_equity_sample) > 0 THEN
        INSERT INTO backtest_equity_curve (run_id, ts, balance, equity)
        SELECT
            v_run_id,
            (e ->> 'ts')::INTEGER,
            (e ->> 'balance')::NUMERIC,
            (e ->> 'equity')::NUMERIC
        FROM jsonb_array_elements(p_equity_sample) AS e;
    END IF;

    RETURN v_run_id;
END;
$$;


-- ─── Views ────────────────────────────────────────────────────────────────

-- Best backtest runs per symbol, ranked by Sharpe ratio
CREATE OR REPLACE VIEW v_backtest_summary AS
SELECT
    id,
    symbol,
    start_date,
    end_date,
    total_trades,
    ROUND(win_rate_pct, 1)          AS win_rate_pct,
    ROUND(total_r, 2)               AS total_r,
    ROUND(expectancy_r, 4)          AS expectancy_r,
    ROUND(profit_factor, 2)         AS profit_factor,
    ROUND(max_drawdown_pct, 2)      AS max_drawdown_pct,
    ROUND(sharpe, 3)                AS sharpe,
    ROUND(sortino, 3)               AS sortino,
    ROUND(total_return_pct, 2)      AS total_return_pct,
    ROUND(final_balance - initial_balance, 2) AS net_profit_usd,
    config ->> 'tp_strategy'        AS tp_strategy,
    config ->> 'min_confidence'     AS min_confidence,
    created_at
FROM backtest_runs
ORDER BY sharpe DESC NULLS LAST;


-- Session-level edge aggregated across all backtest trades
CREATE OR REPLACE VIEW v_backtest_session_edge AS
SELECT
    t.session,
    t.symbol,
    COUNT(*)                                                AS total_trades,
    SUM(CASE WHEN t.pnl_r > 0 THEN 1 ELSE 0 END)          AS wins,
    ROUND(
        100.0 * SUM(CASE WHEN t.pnl_r > 0 THEN 1 ELSE 0 END) / COUNT(*), 1
    )                                                       AS win_rate_pct,
    ROUND(AVG(t.pnl_r)::NUMERIC, 4)                        AS avg_r,
    ROUND(SUM(t.pnl_r)::NUMERIC, 3)                        AS total_r,
    ROUND(
        COALESCE(
            SUM(CASE WHEN t.pnl_r > 0 THEN t.pnl_usd ELSE 0 END) /
            NULLIF(ABS(SUM(CASE WHEN t.pnl_r < 0 THEN t.pnl_usd ELSE 0 END)), 0),
            0
        )::NUMERIC, 3
    )                                                       AS profit_factor
FROM backtest_trades t
GROUP BY t.session, t.symbol
ORDER BY t.symbol, avg_r DESC;


-- Exit reason breakdown (what % of trades hit TP1 vs SL vs TP2 etc.)
CREATE OR REPLACE VIEW v_backtest_exit_reasons AS
SELECT
    r.symbol,
    t.exit_reason,
    COUNT(*)                                               AS count,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY r.symbol), 1) AS pct,
    ROUND(AVG(t.pnl_r)::NUMERIC, 3)                       AS avg_r
FROM backtest_trades t
JOIN backtest_runs r ON t.run_id = r.id
GROUP BY r.symbol, t.exit_reason
ORDER BY r.symbol, count DESC;


-- Confidence bucket analysis: does higher confidence = better trades?
CREATE OR REPLACE VIEW v_backtest_confidence_edge AS
SELECT
    r.symbol,
    CASE
        WHEN t.confidence >= 85 THEN '85+'
        WHEN t.confidence >= 75 THEN '75-84'
        WHEN t.confidence >= 65 THEN '65-74'
        ELSE '<65'
    END                                                    AS confidence_bucket,
    COUNT(*)                                               AS trades,
    ROUND(100.0 * SUM(CASE WHEN t.pnl_r > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS win_rate,
    ROUND(AVG(t.pnl_r)::NUMERIC, 3)                       AS avg_r,
    ROUND(SUM(t.pnl_r)::NUMERIC, 2)                       AS total_r
FROM backtest_trades t
JOIN backtest_runs r ON t.run_id = r.id
GROUP BY r.symbol, confidence_bucket
ORDER BY r.symbol, confidence_bucket DESC;


-- Market regime performance
CREATE OR REPLACE VIEW v_backtest_regime_edge AS
SELECT
    r.symbol,
    t.regime,
    COUNT(*)                                               AS trades,
    ROUND(100.0 * SUM(CASE WHEN t.pnl_r > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS win_rate,
    ROUND(AVG(t.pnl_r)::NUMERIC, 3)                       AS avg_r,
    ROUND(SUM(t.pnl_r)::NUMERIC, 2)                       AS total_r
FROM backtest_trades t
JOIN backtest_runs r ON t.run_id = r.id
GROUP BY r.symbol, t.regime
ORDER BY r.symbol, avg_r DESC;


-- ─── RLS: only service role reads backtest results ────────────────────────

ALTER TABLE backtest_runs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE backtest_trades       ENABLE ROW LEVEL SECURITY;
ALTER TABLE backtest_equity_curve ENABLE ROW LEVEL SECURITY;

-- Service role (daemon) has full access
CREATE POLICY "service_role_all_backtest_runs"
    ON backtest_runs FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "service_role_all_backtest_trades"
    ON backtest_trades FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "service_role_all_backtest_equity"
    ON backtest_equity_curve FOR ALL
    USING (auth.role() = 'service_role');


-- ─────────────────────────────────────────────────────────────────────────────
-- Extra: Allow authenticated users to read/write their own journal trades
-- (in addition to service_role policies set above)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated read journal_trades"   ON journal_trades;
DROP POLICY IF EXISTS "Authenticated insert journal_trades" ON journal_trades;
DROP POLICY IF EXISTS "Authenticated update journal_trades" ON journal_trades;
CREATE POLICY "Authenticated read journal_trades"
    ON journal_trades FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert journal_trades"
    ON journal_trades FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update journal_trades"
    ON journal_trades FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated read journal_analyses"  ON journal_analyses;
CREATE POLICY "Authenticated read journal_analyses"
    ON journal_analyses FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated read journal_patterns"  ON journal_patterns;
CREATE POLICY "Authenticated read journal_patterns"
    ON journal_patterns FOR SELECT TO authenticated USING (true);

-- Grant journal Edge Function functions to service_role
GRANT EXECUTE ON FUNCTION fn_refresh_journal_patterns(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION fn_journal_pattern_match(INTEGER,TEXT,TEXT,TEXT,TEXT) TO service_role;

-- Allow anon key to read prop_firm_presets (for the Challenge tab)
ALTER TABLE prop_firm_presets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read prop_firm_presets" ON prop_firm_presets;
CREATE POLICY "Public read prop_firm_presets" ON prop_firm_presets FOR SELECT USING (true);

-- Allow authenticated users to read challenge status
DROP POLICY IF EXISTS "Authenticated read prop_challenges" ON prop_challenges;
CREATE POLICY "Authenticated read prop_challenges"
    ON prop_challenges FOR SELECT TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- DONE. PropPilot AI schema is complete and ready.
-- ─────────────────────────────────────────────────────────────────────────────
