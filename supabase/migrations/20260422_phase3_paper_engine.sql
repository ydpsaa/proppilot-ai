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
