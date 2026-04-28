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
