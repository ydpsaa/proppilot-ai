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
