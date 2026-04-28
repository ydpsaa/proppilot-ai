"""
PropPilot AI — AI Journal Coach
Personal AI coach that learns from the trader's own journal history.

ISOLATED from the algo AI Coach (ai_coach.py):
  ai_coach.py        → analyzes algo signals in real-time
  ai_journal_coach.py → learns from YOUR manual trades, coaches YOU personally

Powered by Groq (Llama 3.3 70B) — free at console.groq.com.
Set GROQ_API_KEY in daemon/.env.

What makes this different from a generic AI:
  - Knows your win rate per symbol, session, strategy
  - Knows your common mistakes by name
  - Knows your best and worst mental states
  - Compares current trade to YOUR history, not generic benchmarks
  - Says things like "Your last 8 EUR/USD longs when ADX<20 all lost"

Usage:
    from journal_manager import JournalManager
    from ai_journal_coach import AIJournalCoach

    jm    = JournalManager()
    coach = AIJournalCoach()

    # Analyze a just-closed trade
    trade   = jm.fetch_trade(trade_id)
    history = jm.fetch_by_symbol(trade["symbol"], limit=30)
    analysis = coach.analyze_trade(trade, history)
    jm.save_analysis(trade_id, analysis)

    # Ask before opening a trade
    patterns = jm.fetch_patterns()
    advice = coach.pre_trade_advice("XAU/USD", "LONG", "London", "SMC", patterns)

    # End-of-day debrief
    today_trades = jm.fetch_recent(limit=10)
    summary = jm.performance_summary()
    debrief = coach.daily_debrief(today_trades, summary)
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import structlog

import config

log = structlog.get_logger("ai_journal_coach")

# ─── Model config ─────────────────────────────────────────────────────────────

_MODEL        = "llama-3.3-70b-versatile"
_MAX_TOKENS   = 1024
_TEMPERATURE  = 0.4


# ─── Result types ─────────────────────────────────────────────────────────────

@dataclass
class JournalAnalysis:
    """Result of an AI trade analysis."""
    entry_score:          Optional[int]   = None   # 0-100
    exit_score:           Optional[int]   = None
    risk_score:           Optional[int]   = None
    overall_score:        Optional[int]   = None

    what_happened:        str = ""
    what_went_well:       str = ""
    what_to_improve:      str = ""
    key_lesson:           str = ""
    pattern_identified:   str = ""

    similar_trades_count: Optional[int]   = None
    similar_win_rate:     Optional[float] = None
    user_edge_in_setup:   Optional[float] = None

    recommended_action:   str = ""
    recommendation_reason: str = ""

    verdict: str = ""   # good_trade | premature_exit | bad_entry | good_loss | overtraded

    raw_response:  str = ""
    model:         str = _MODEL
    tokens_used:   Optional[int] = None

    def to_dict(self) -> dict:
        return self.__dict__.copy()


@dataclass
class PersonalSignal:
    """A signal generated from the trader's own historical patterns."""
    symbol:          str
    direction:       str
    session:         str
    strategy:        str
    signal_strength: str          # STRONG | MODERATE | WEAK | AVOID
    win_rate_pct:    float
    avg_r:           float
    sample_size:     int
    message:         str          # human-readable advice
    recommendation:  str          # TAKE_TRADE | REDUCE_SIZE | AVOID | NEUTRAL


# ─── AIJournalCoach ───────────────────────────────────────────────────────────

class AIJournalCoach:
    """
    Personal trading coach powered by Groq.
    Reads the trader's journal history to give deeply personalized feedback.
    """

    def __init__(self) -> None:
        self._enabled = bool(config.GROQ_API_KEY and
                             not config.GROQ_API_KEY.startswith("gsk_ВСТАВЬ"))
        if self._enabled:
            from openai import OpenAI
            self._client = OpenAI(
                api_key  = config.GROQ_API_KEY,
                base_url = "https://api.groq.com/openai/v1",
            )
            log.info("ai_journal_coach_ready", model=_MODEL)
        else:
            self._client = None
            log.warning("ai_journal_coach_disabled",
                        msg="Set GROQ_API_KEY in .env to enable AI coaching")

    # ── Core: analyze a completed trade ───────────────────────────────────────

    def analyze_trade(
        self,
        trade:   dict,
        history: Optional[list[dict]] = None,
    ) -> JournalAnalysis:
        """
        Deep analysis of a completed trade.
        `history` = recent trades on the same symbol (optional, enriches context).

        Returns JournalAnalysis with scores, lessons, and verdict.
        """
        if not self._enabled:
            return JournalAnalysis(
                verdict="n/a",
                key_lesson="Enable GROQ_API_KEY for AI analysis",
            )

        history = history or []

        # Build history statistics for context
        hist_stats = _compute_history_stats(history, trade.get("symbol"),
                                            trade.get("session"), trade.get("direction"))

        system = (
            "You are a personal trading performance coach. "
            "You analyze completed trades deeply and give actionable, specific feedback. "
            "You speak directly, like a mentor. No generic advice. "
            "Base every observation on the trader's actual history provided to you."
        )

        prompt = f"""
Analyze this completed trade and provide structured feedback.

─── TRADE ────────────────────────────────────────────────────
Symbol    : {trade.get('symbol')}
Direction : {trade.get('direction')}
Session   : {trade.get('session')}
Entry     : {trade.get('entry_price')}  at  {trade.get('entry_time', 'unknown')}
Exit      : {trade.get('exit_price')}  at  {trade.get('exit_time', 'unknown')}
SL        : {trade.get('sl_price')}
TP        : {trade.get('tp_price')}
P&L       : {trade.get('pnl_r', '?')}R  (${trade.get('pnl_usd', '?')})
Outcome   : {trade.get('outcome', 'unknown')}
Strategy  : {trade.get('strategy', 'not specified')}
Setup     : {trade.get('setup_type', 'not specified')}
HTF Trend : {trade.get('htf_trend', 'not specified')}

Entry reason  : {trade.get('entry_reason') or 'not recorded'}
Exit reason   : {trade.get('exit_reason')  or 'not recorded'}
Market context: {trade.get('market_context') or 'not recorded'}
What happened : {trade.get('what_happened') or 'not recorded'}

Mindset score : {trade.get('mindset_score', '?')}/10
Emotions      : {', '.join(trade.get('emotions') or []) or 'not recorded'}
Followed plan : {trade.get('followed_plan', 'unknown')}
Mistakes noted: {', '.join(trade.get('mistakes') or []) or 'none noted'}
Lessons noted : {trade.get('lessons_learned') or 'none noted'}

─── TRADER'S HISTORY (same symbol/session) ──────────────────
{hist_stats}

─── INSTRUCTIONS ────────────────────────────────────────────
Respond in this exact JSON format (no markdown, just JSON):
{{
  "entry_score": <0-100>,
  "exit_score": <0-100>,
  "risk_score": <0-100>,
  "overall_score": <0-100>,
  "what_happened": "<2-3 sentences: objective description of what occurred in the trade>",
  "what_went_well": "<specific things that were executed correctly>",
  "what_to_improve": "<specific, actionable improvement — not generic>",
  "key_lesson": "<the single most important takeaway from this trade>",
  "pattern_identified": "<what type of setup/pattern this was: e.g. 'Asia sweep + London MSS long'>",
  "verdict": "<one of: good_trade | premature_exit | bad_entry | good_loss | overtraded | missed_context>",
  "recommended_action": "<for next time: hold | cut_earlier | wait_confirmation | reduce_size | no_change>",
  "recommendation_reason": "<why this recommendation, referencing their history>"
}}
""".strip()

        try:
            resp = self._client.chat.completions.create(
                model       = _MODEL,
                messages    = [
                    {"role": "system",  "content": system},
                    {"role": "user",    "content": prompt},
                ],
                max_tokens  = _MAX_TOKENS,
                temperature = _TEMPERATURE,
            )
            raw    = resp.choices[0].message.content.strip()
            tokens = getattr(resp.usage, "total_tokens", None)
            data   = _parse_json(raw)

            return JournalAnalysis(
                entry_score         = _safe_int(data.get("entry_score")),
                exit_score          = _safe_int(data.get("exit_score")),
                risk_score          = _safe_int(data.get("risk_score")),
                overall_score       = _safe_int(data.get("overall_score")),
                what_happened       = data.get("what_happened", ""),
                what_went_well      = data.get("what_went_well", ""),
                what_to_improve     = data.get("what_to_improve", ""),
                key_lesson          = data.get("key_lesson", ""),
                pattern_identified  = data.get("pattern_identified", ""),
                similar_trades_count = hist_stats.get("count"),
                similar_win_rate     = hist_stats.get("win_rate"),
                user_edge_in_setup   = hist_stats.get("avg_r"),
                recommended_action   = data.get("recommended_action", ""),
                recommendation_reason= data.get("recommendation_reason", ""),
                verdict             = data.get("verdict", ""),
                raw_response        = raw,
                model               = _MODEL,
                tokens_used         = tokens,
            )
        except Exception as e:
            log.error("analyze_trade_error", symbol=trade.get("symbol"), error=str(e))
            return JournalAnalysis(verdict="error", key_lesson=str(e))

    # ── Pre-trade: should I take this? ────────────────────────────────────────

    def pre_trade_advice(
        self,
        symbol:    str,
        direction: str,
        session:   str,
        strategy:  str,
        patterns:  list[dict],
        context:   Optional[dict] = None,
    ) -> str:
        """
        Ask the AI: "Should I take this trade based on my history?"
        Returns a short, direct recommendation.
        """
        if not self._enabled:
            return "AI coach disabled — add GROQ_API_KEY to .env"

        # Find matching pattern
        match = _best_pattern_match(patterns, symbol, session, direction, strategy)

        system = (
            "You are a direct, concise trading mentor. "
            "You give traders quick pre-trade assessments based on their history. "
            "Max 3 sentences. No fluff. Reference real numbers from their history."
        )

        pattern_text = "No historical data for this specific setup yet." if not match else (
            f"Historical edge for {direction} {symbol} in {session} with {strategy}: "
            f"{match.get('win_rate_pct', '?')}% win rate over {match.get('sample_size', '?')} trades, "
            f"avg {match.get('avg_r', '?')}R. "
            f"Edge label: {match.get('edge_label', 'unknown')}."
        )

        context_text = ""
        if context:
            context_text = f"\nCurrent market context: {json.dumps(context, indent=2)}"

        prompt = (
            f"Trader wants to take: {direction} {symbol} in {session} using {strategy}.\n\n"
            f"{pattern_text}{context_text}\n\n"
            f"Give a direct 2-3 sentence recommendation: should they take this trade, reduce size, or skip?"
        )

        try:
            resp = self._client.chat.completions.create(
                model       = _MODEL,
                messages    = [
                    {"role": "system", "content": system},
                    {"role": "user",   "content": prompt},
                ],
                max_tokens  = 200,
                temperature = 0.3,
            )
            return resp.choices[0].message.content.strip()
        except Exception as e:
            log.error("pre_trade_advice_error", error=str(e))
            return f"AI error: {e}"

    # ── Daily debrief ─────────────────────────────────────────────────────────

    def daily_debrief(
        self,
        today_trades:  list[dict],
        summary:       dict,
        account:       Optional[dict] = None,
    ) -> str:
        """
        End-of-day coaching session.
        Reviews today's trades, highlights patterns, gives tomorrow's focus.
        """
        if not self._enabled:
            return "AI coach disabled — add GROQ_API_KEY to .env"
        if not today_trades:
            return "No trades to review today."

        system = (
            "You are a trading performance coach reviewing a trader's day. "
            "Be specific, direct, and constructive. Reference actual numbers. "
            "End with 1 clear focus point for tomorrow."
        )

        trades_text = "\n".join([
            f"  {i+1}. {t.get('symbol')} {t.get('direction')} | "
            f"Outcome: {t.get('outcome')} | R: {t.get('pnl_r', '?')} | "
            f"Mindset: {t.get('mindset_score', '?')}/10 | "
            f"Followed plan: {t.get('followed_plan', '?')} | "
            f"Exit: {t.get('exit_reason', 'not noted')}"
            for i, t in enumerate(today_trades)
        ])

        account_text = ""
        if account:
            balance = account.get("balance", "?")
            daily_pnl = account.get("daily_pnl_usd", "?")
            account_text = f"\nAccount: Balance ${balance}, Daily P&L ${daily_pnl}"

        prompt = (
            f"Today's trades:\n{trades_text}\n"
            f"Overall stats: {summary.get('total_trades', 0)} trades, "
            f"{summary.get('win_rate_pct', '?')}% WR, {summary.get('total_r', '?')}R total"
            f"{account_text}\n\n"
            "Write a 4-6 sentence daily debrief: what worked, what didn't, "
            "key pattern from today, and ONE specific focus for tomorrow."
        )

        try:
            resp = self._client.chat.completions.create(
                model       = _MODEL,
                messages    = [
                    {"role": "system", "content": system},
                    {"role": "user",   "content": prompt},
                ],
                max_tokens  = 400,
                temperature = 0.4,
            )
            return resp.choices[0].message.content.strip()
        except Exception as e:
            log.error("daily_debrief_error", error=str(e))
            return f"AI error: {e}"

    # ── Weekly review ─────────────────────────────────────────────────────────

    def weekly_review(self, trades: list[dict], summary: dict) -> str:
        """
        Weekly performance review: trends, progress, focus areas for next week.
        """
        if not self._enabled:
            return "AI coach disabled."
        if not trades:
            return "No trades this week."

        system = (
            "You are a trading coach writing a weekly performance review. "
            "Be analytical and specific. Focus on behavioral patterns, not just P&L. "
            "Keep it under 200 words."
        )

        # Aggregate by day and symbol
        by_symbol: dict = {}
        for t in trades:
            s = t.get("symbol", "?")
            r = float(t.get("pnl_r") or 0)
            if s not in by_symbol:
                by_symbol[s] = {"count": 0, "total_r": 0.0, "wins": 0}
            by_symbol[s]["count"]   += 1
            by_symbol[s]["total_r"] += r
            if t.get("outcome") == "win":
                by_symbol[s]["wins"] += 1

        sym_lines = "\n".join([
            f"  {s}: {d['count']} trades, {d['wins']}W, "
            f"{d['total_r']:+.2f}R"
            for s, d in sorted(by_symbol.items(), key=lambda x: -x[1]["total_r"])
        ])

        # Mindset correlation
        calm_trades    = [t for t in trades if (t.get("mindset_score") or 0) >= 7]
        not_calm       = [t for t in trades if 0 < (t.get("mindset_score") or 0) < 7]
        calm_r    = sum(float(t.get("pnl_r") or 0) for t in calm_trades)
        notcalm_r = sum(float(t.get("pnl_r") or 0) for t in not_calm)

        off_plan = sum(1 for t in trades if t.get("followed_plan") is False)

        prompt = (
            f"Weekly summary:\n"
            f"  Total: {len(trades)} trades | "
            f"WR: {summary.get('win_rate_pct', '?')}% | "
            f"R: {summary.get('total_r', '?')} | "
            f"Off-plan: {off_plan}\n"
            f"By symbol:\n{sym_lines}\n"
            f"Calm trades (mindset ≥7): {len(calm_trades)} → {calm_r:+.2f}R\n"
            f"Not calm: {len(not_calm)} → {notcalm_r:+.2f}R\n\n"
            "Write a concise weekly review: key trend, best/worst pattern, "
            "what improved vs last week if visible, and 2 focus points for next week."
        )

        try:
            resp = self._client.chat.completions.create(
                model       = _MODEL,
                messages    = [
                    {"role": "system", "content": system},
                    {"role": "user",   "content": prompt},
                ],
                max_tokens  = 500,
                temperature = 0.4,
            )
            return resp.choices[0].message.content.strip()
        except Exception as e:
            log.error("weekly_review_error", error=str(e))
            return f"AI error: {e}"

    # ── Pattern insights ──────────────────────────────────────────────────────

    def pattern_insights(self, patterns: list[dict]) -> str:
        """
        Summarize the trader's best and worst patterns.
        Tells them WHERE their edge is and WHERE to avoid trading.
        """
        if not self._enabled:
            return "AI coach disabled."
        if not patterns:
            return "Not enough trade history to identify patterns. Log more trades."

        system = (
            "You are a trading edge analyst. "
            "Identify where this trader has real edge and where they lose money. "
            "Be blunt and specific. No generic advice."
        )

        best  = sorted(patterns, key=lambda x: float(x.get("avg_r") or -99), reverse=True)[:3]
        worst = sorted(patterns, key=lambda x: float(x.get("avg_r") or 99))[:3]

        def _fmt(p: dict) -> str:
            return (
                f"  {p.get('direction','?')} {p.get('symbol','?')} | "
                f"Session: {p.get('session','any')} | "
                f"Strategy: {p.get('strategy','?')} | "
                f"WR: {p.get('win_rate_pct','?')}% | "
                f"AvgR: {p.get('avg_r','?')} | "
                f"n={p.get('sample_size','?')}"
            )

        prompt = (
            f"Trader's BEST patterns:\n" + "\n".join(_fmt(p) for p in best) + "\n\n"
            f"Trader's WORST patterns:\n" + "\n".join(_fmt(p) for p in worst) + "\n\n"
            "In 5-7 sentences: explain their actual edge, what they should focus on, "
            "what setups to eliminate from their trading entirely."
        )

        try:
            resp = self._client.chat.completions.create(
                model       = _MODEL,
                messages    = [
                    {"role": "system", "content": system},
                    {"role": "user",   "content": prompt},
                ],
                max_tokens  = 400,
                temperature = 0.3,
            )
            return resp.choices[0].message.content.strip()
        except Exception as e:
            log.error("pattern_insights_error", error=str(e))
            return f"AI error: {e}"

    # ── Personal signal ───────────────────────────────────────────────────────

    def generate_personal_signal(
        self,
        symbol:    str,
        session:   str,
        direction: str,
        strategy:  str,
        patterns:  list[dict],
        current_setup_desc: str = "",
    ) -> Optional[PersonalSignal]:
        """
        Generate a personal signal based on the trader's own historical edge.
        Returns None if no meaningful data exists.

        This is NOT the algo signal — this says:
        "When YOU trade this setup, you historically get X% win rate."
        """
        match = _best_pattern_match(patterns, symbol, session, direction, strategy)
        if not match:
            return None

        win_rate = float(match.get("win_rate_pct") or 0)
        avg_r    = float(match.get("avg_r") or 0)
        n        = int(match.get("sample_size") or 0)

        if n < 3:
            return None

        if win_rate >= 65 and avg_r > 0.5:
            strength = "STRONG"
            rec = "TAKE_TRADE"
            msg = (
                f"Your personal edge on {direction} {symbol} in {session} is strong: "
                f"{win_rate:.0f}% win rate, avg {avg_r:+.2f}R over {n} trades. "
                f"Take the trade if your setup confirms."
            )
        elif win_rate >= 55 and avg_r > 0:
            strength = "MODERATE"
            rec = "REDUCE_SIZE"
            msg = (
                f"Moderate edge: {win_rate:.0f}% WR, {avg_r:+.2f}R avg ({n} trades). "
                f"Consider 50% normal size until win rate improves."
            )
        elif win_rate < 45:
            strength = "AVOID"
            rec = "AVOID"
            msg = (
                f"Historically weak for you: {win_rate:.0f}% WR, {avg_r:+.2f}R ({n} trades). "
                f"Skip this setup or paper trade only."
            )
        else:
            strength = "WEAK"
            rec = "NEUTRAL"
            msg = (
                f"Neutral edge: {win_rate:.0f}% WR, {avg_r:+.2f}R ({n} trades). "
                f"Proceed with caution — no clear personal edge yet."
            )

        return PersonalSignal(
            symbol          = symbol,
            direction       = direction,
            session         = session,
            strategy        = strategy,
            signal_strength = strength,
            win_rate_pct    = win_rate,
            avg_r           = avg_r,
            sample_size     = n,
            message         = msg,
            recommendation  = rec,
        )

    # ── Batch analyze unanalyzed trades ──────────────────────────────────────

    def batch_analyze(
        self,
        journal_manager,    # JournalManager instance
        limit: int = 20,
    ) -> int:
        """
        Analyze all unanalyzed trades in the journal.
        Returns count of trades analyzed.
        Designed to be called as a background job.
        """
        trades = journal_manager.fetch_unanalyzed(limit=limit)
        if not trades:
            log.debug("batch_analyze_nothing_pending")
            return 0

        analyzed = 0
        for trade in trades:
            symbol  = trade.get("symbol", "")
            history = journal_manager.fetch_by_symbol(symbol, limit=30)
            # Exclude current trade from history
            history = [h for h in history if h.get("id") != trade.get("id")]

            analysis = self.analyze_trade(trade, history)
            journal_manager.save_analysis(trade["id"], analysis.to_dict())
            analyzed += 1

        log.info("batch_analyze_complete", analyzed=analyzed)
        return analyzed


# ─── Internal helpers ─────────────────────────────────────────────────────────

def _compute_history_stats(
    history:   list[dict],
    symbol:    Optional[str],
    session:   Optional[str],
    direction: Optional[str],
) -> dict:
    """
    Compute statistics from historical trades for AI context.
    Filters to same symbol+session+direction for relevance.
    """
    if not history:
        return {"count": 0, "text": "No historical data for this setup yet."}

    # Filter to same setup
    filtered = [
        t for t in history
        if (symbol   is None or t.get("symbol")    == symbol)
        and (session  is None or t.get("session")   == session)
        and (direction is None or t.get("direction") == direction)
        and t.get("outcome") is not None
    ]

    if not filtered:
        return {"count": 0, "text": "No closed trades with this exact symbol/session/direction."}

    wins  = [t for t in filtered if t.get("outcome") == "win"]
    r_vals = [float(t["pnl_r"]) for t in filtered if t.get("pnl_r") is not None]
    avg_r  = sum(r_vals) / len(r_vals) if r_vals else 0.0
    win_rt = len(wins) / len(filtered) * 100 if filtered else 0.0

    # Mindset correlation
    calm_r   = [float(t["pnl_r"] or 0) for t in filtered
                if (t.get("mindset_score") or 0) >= 7 and t.get("pnl_r") is not None]
    notcalm_r = [float(t["pnl_r"] or 0) for t in filtered
                 if 0 < (t.get("mindset_score") or 0) < 7 and t.get("pnl_r") is not None]

    # Common mistakes in similar trades
    mistake_counts: dict = {}
    for t in filtered:
        for m in (t.get("mistakes") or []):
            mistake_counts[m] = mistake_counts.get(m, 0) + 1
    top_mistakes = sorted(mistake_counts, key=mistake_counts.get, reverse=True)[:3]

    text = (
        f"Past {len(filtered)} trades — {symbol} {direction} in {session}: "
        f"{win_rt:.0f}% win rate, avg {avg_r:+.2f}R. "
    )
    if calm_r:
        text += f"When calm (mindset ≥7): avg {sum(calm_r)/len(calm_r):+.2f}R. "
    if notcalm_r:
        text += f"When not calm: avg {sum(notcalm_r)/len(notcalm_r):+.2f}R. "
    if top_mistakes:
        text += f"Recurring mistakes: {', '.join(top_mistakes)}."

    return {
        "count":    len(filtered),
        "win_rate": round(win_rt, 1),
        "avg_r":    round(avg_r, 3),
        "text":     text,
    }


def _best_pattern_match(
    patterns:  list[dict],
    symbol:    str,
    session:   str,
    direction: str,
    strategy:  Optional[str],
) -> Optional[dict]:
    """Find the best matching pattern from the list."""
    scored = []
    for p in patterns:
        specificity = 0
        if p.get("symbol")    == symbol:    specificity += 3
        if p.get("session")   == session:   specificity += 2
        if p.get("direction") == direction: specificity += 2
        if p.get("strategy")  == strategy:  specificity += 1
        if specificity >= 4:
            scored.append((specificity, p))
    if not scored:
        return None
    scored.sort(key=lambda x: (-x[0], -float(x[1].get("win_rate_pct") or 0)))
    return scored[0][1]


def _parse_json(text: str) -> dict:
    """Extract JSON from AI response (handles markdown code blocks)."""
    text = text.strip()
    # Strip markdown code fences
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to extract JSON object
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except json.JSONDecodeError:
                pass
    return {}


def _safe_int(val) -> Optional[int]:
    try:
        return int(val) if val is not None else None
    except (TypeError, ValueError):
        return None
