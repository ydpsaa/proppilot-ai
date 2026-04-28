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
