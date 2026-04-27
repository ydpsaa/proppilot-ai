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
