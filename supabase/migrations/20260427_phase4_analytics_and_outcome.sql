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
