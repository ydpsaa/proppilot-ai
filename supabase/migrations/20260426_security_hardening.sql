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
