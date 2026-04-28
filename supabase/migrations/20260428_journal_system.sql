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
