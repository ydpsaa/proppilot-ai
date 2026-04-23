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
