"""
PropPilot AI — Prop Firm Coach
Groq-powered AI advisor for prop firm challenges.

Answers "should I take this trade now?", "how am I doing?",
"what should I focus on today?", etc. — all grounded in the
live challenge status and trading history.

Usage:
    coach = PropCoach(challenge_id=1)

    # Ask before a trade
    advice = coach.pre_trade_advice(
        symbol="XAU/USD", direction="LONG", session="London",
        risk_usd=50.0, lot_size=0.05
    )
    print(advice)

    # Daily debrief
    debrief = coach.daily_debrief()

    # On-demand question
    answer = coach.ask("I have 3 days left and need 2% more profit. Should I increase risk?")
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional

import structlog
from openai import OpenAI

import config
from challenge_tracker import ChallengeStatus, ChallengeTracker
from rules_engine import RulesEngine, RuleCheckResult

log = structlog.get_logger("prop_coach")


# ─── Groq client ─────────────────────────────────────────────────────────────

def _groq_client() -> OpenAI:
    return OpenAI(
        api_key  = config.GROQ_API_KEY,
        base_url = "https://api.groq.com/openai/v1",
    )

_MODEL        = "llama-3.3-70b-versatile"
_MAX_TOKENS   = 1024
_TEMPERATURE  = 0.4


# ─── Data models ──────────────────────────────────────────────────────────────

@dataclass
class CoachAdvice:
    """Structured response from the Prop Coach."""
    verdict:       str            # TAKE_TRADE / REDUCE_SIZE / WAIT / AVOID / N/A
    message:       str            # Main narrative advice (1–3 paragraphs)
    key_points:    list[str]      # 2–4 bullet actionables
    risk_usd:      Optional[float] = None   # Recommended risk (may differ from requested)
    raw_response:  Optional[str]  = None
    tokens_used:   int            = 0

    def formatted(self) -> str:
        """Human-readable formatted output."""
        lines = [
            f"[{self.verdict}]",
            "",
            self.message,
        ]
        if self.key_points:
            lines.append("")
            for pt in self.key_points:
                lines.append(f"• {pt}")
        if self.risk_usd is not None:
            lines.append("")
            lines.append(f"Recommended risk: ${self.risk_usd:.0f}")
        return "\n".join(lines)


# ─── System prompt builder ────────────────────────────────────────────────────

def _build_system_prompt() -> str:
    return """You are PropPilot's Prop Firm Coach — a sharp, experienced trading mentor
who specializes in helping traders pass and maintain prop firm challenges.

Your role:
- Give honest, grounded advice based on the challenge's exact rules and current status
- Never sugarcoat the risk: if something could blow the account, say it clearly
- Be concise. No fluff, no disclaimers, no motivational speeches
- Always reference the actual numbers (balance, drawdown %, daily limit remaining)
- When recommending a trade, specify whether to take it at full size, reduced size, or skip it
- Think in R-multiples and risk management first, profits second

Your tone: direct, confident, like a senior trader reviewing your position.
You do NOT give generic advice. Every answer is specific to this trader's current challenge state."""


# ─── Prop Coach ───────────────────────────────────────────────────────────────

class PropCoach:
    """
    AI advisor that combines ChallengeStatus + RulesEngine results
    to give context-aware guidance during a prop firm challenge.
    """

    def __init__(self, challenge_id: int) -> None:
        self._tracker = ChallengeTracker(challenge_id)
        self._rules   = RulesEngine(challenge_id)
        self._client  = _groq_client()
        self.challenge_id = challenge_id

    # ── Pre-trade advice ──────────────────────────────────────────────────────

    def pre_trade_advice(
        self,
        symbol:    str,
        direction: str,
        session:   str,
        risk_usd:  float,
        lot_size:  float   = 0.0,
        setup_desc: str    = "",
        is_news_time: bool = False,
    ) -> CoachAdvice:
        """
        Answer: "Should I take this trade right now?"
        Runs RulesEngine first, then enriches with AI commentary.
        """
        status = self._tracker.get_status()
        if not status:
            return CoachAdvice(
                verdict    = "N/A",
                message    = "Could not load challenge status.",
                key_points = [],
            )

        # Run hard rules check
        rule_check = self._rules.check(
            risk_usd     = risk_usd,
            lot_size     = lot_size,
            symbol       = symbol,
            session      = session,
            is_news_time = is_news_time,
        )

        # Compute safe risk
        safe_risk = self._rules.safe_risk_usd(risk_usd)

        prompt = self._build_pre_trade_prompt(
            status, rule_check, symbol, direction, session,
            risk_usd, safe_risk, setup_desc
        )

        return self._call_groq(prompt, risk_usd=safe_risk if rule_check.passed else None)

    def _build_pre_trade_prompt(
        self,
        status:     ChallengeStatus,
        rule_check: RuleCheckResult,
        symbol:     str,
        direction:  str,
        session:    str,
        risk_usd:   float,
        safe_risk:  float,
        setup_desc: str,
    ) -> str:
        r = status.rules
        blocked = not rule_check.passed

        parts = [
            f"=== CHALLENGE STATUS ===",
            f"Firm: {r.firm_name} | Phase: {status.current_phase}",
            f"Balance: ${status.current_balance:,.2f} (started ${status.starting_balance:,.2f})",
            f"P&L: ${status.total_pnl_usd:+,.2f} ({status.total_pnl_pct:+.1f}%)",
            f"Profit target: ${r.profit_target_usd:,.2f} — {status.profit_progress_pct:.0f}% complete",
            f"",
            f"Daily loss used: {status.daily_loss_used_pct:.0f}% of ${r.max_daily_loss_usd:,.0f} limit | "
            f"${status.daily_loss_remaining_usd:,.0f} remaining",
            f"Total drawdown: {status.total_dd_used_pct:.0f}% of ${r.max_total_loss_usd:,.0f} limit | "
            f"${status.total_dd_remaining_usd:,.0f} remaining buffer",
            f"",
            f"Trading days: {status.trading_days_completed}/{r.min_trading_days} min | "
            f"{status.days_remaining} calendar days left",
            f"",
        ]

        if status.alerts:
            parts.append(f"=== ACTIVE ALERTS ===")
            for alert in status.alerts:
                parts.append(alert)
            parts.append("")

        parts.append(f"=== PROPOSED TRADE ===")
        parts.append(f"Symbol: {symbol} | Direction: {direction} | Session: {session}")
        parts.append(f"Requested risk: ${risk_usd:.2f}")
        if safe_risk < risk_usd:
            parts.append(f"Safe risk (after headroom calc): ${safe_risk:.2f}")
        if setup_desc:
            parts.append(f"Setup: {setup_desc}")
        parts.append("")

        if blocked:
            parts.append(f"=== RULE CHECK RESULT: BLOCKED ===")
            for reason in rule_check.reasons:
                parts.append(f"• {reason}")
        else:
            parts.append(f"=== RULE CHECK RESULT: ALLOWED ===")
            if rule_check.warnings:
                parts.append("Warnings:")
                for w in rule_check.warnings:
                    parts.append(f"  {w}")

        parts.append("")
        parts.append(
            "Based on the above, give your verdict: "
            "TAKE_TRADE (full size), REDUCE_SIZE (specify %), WAIT (specific reason), or AVOID. "
            "Respond with JSON: "
            '{"verdict": "...", "message": "...", "key_points": ["...", "..."], "risk_usd": <number or null>}'
        )

        return "\n".join(parts)

    # ── Daily debrief ─────────────────────────────────────────────────────────

    def daily_debrief(self) -> CoachAdvice:
        """
        End-of-day debrief: how did today go, what to focus on tomorrow?
        """
        status = self._tracker.get_status()
        if not status:
            return CoachAdvice(
                verdict    = "N/A",
                message    = "Could not load challenge status.",
                key_points = [],
            )

        history = self._tracker.fetch_daily_history(limit=7)

        prompt = self._build_daily_debrief_prompt(status, history)
        return self._call_groq(prompt)

    def _build_daily_debrief_prompt(
        self, status: ChallengeStatus, history: list[dict]
    ) -> str:
        r = status.rules
        parts = [
            "=== END-OF-DAY DEBRIEF REQUEST ===",
            f"Firm: {r.firm_name} | Phase: {status.current_phase}",
            f"Balance: ${status.current_balance:,.2f} | P&L total: ${status.total_pnl_usd:+,.2f}",
            f"Profit progress: {status.profit_progress_pct:.0f}% of target",
            f"Days remaining: {status.days_remaining} | Trading days: {status.trading_days_completed}/{r.min_trading_days}",
            f"",
            f"TODAY: P&L ${status.today_pnl_usd:+,.2f} over {status.today_trades} trades",
            f"Daily limit used: {status.daily_loss_used_pct:.0f}%",
            f"",
        ]

        if history:
            parts.append("=== LAST 7 TRADING DAYS ===")
            for day in reversed(history[:7]):
                parts.append(
                    f"{day.get('trade_date','?')}: "
                    f"${float(day.get('pnl_usd',0)):+,.2f} | "
                    f"{day.get('trade_count',0)} trades"
                )
            parts.append("")

        if status.alerts:
            parts.append("=== ACTIVE ALERTS ===")
            for alert in status.alerts:
                parts.append(alert)
            parts.append("")

        parts.append(
            "Give an honest daily debrief: assess today's performance, "
            "identify the most important thing to focus on tomorrow, "
            "and flag any challenge-specific risks. "
            "Be concise (3 paragraphs max). "
            'Respond with JSON: {"verdict": "N/A", "message": "...", "key_points": ["...", "..."], "risk_usd": null}'
        )

        return "\n".join(parts)

    # ── Challenge overview ────────────────────────────────────────────────────

    def challenge_overview(self) -> CoachAdvice:
        """
        Full challenge health assessment — call on demand or weekly.
        Covers: progress, risk budget, pace, key threats.
        """
        status = self._tracker.get_status()
        if not status:
            return CoachAdvice(
                verdict    = "N/A",
                message    = "Could not load challenge status.",
                key_points = [],
            )

        history = self._tracker.fetch_daily_history(limit=14)
        trades  = self._tracker.fetch_recent_trades(limit=20)

        prompt = self._build_overview_prompt(status, history, trades)
        return self._call_groq(prompt, max_tokens=1500)

    def _build_overview_prompt(
        self,
        status:  ChallengeStatus,
        history: list[dict],
        trades:  list[dict],
    ) -> str:
        r = status.rules
        parts = [
            "=== FULL CHALLENGE OVERVIEW REQUEST ===",
            f"Firm: {r.firm_name} | Phase: {status.current_phase}",
            f"Account: ${r.account_size_usd:,.0f}",
            f"",
            f"BALANCE SNAPSHOT",
            f"  Starting:     ${status.starting_balance:,.2f}",
            f"  Current:      ${status.current_balance:,.2f}",
            f"  Peak:         ${status.peak_balance:,.2f}",
            f"  Total P&L:    ${status.total_pnl_usd:+,.2f} ({status.total_pnl_pct:+.1f}%)",
            f"  Profit target: ${r.profit_target_usd:,.2f} — {status.profit_progress_pct:.0f}% done",
            f"",
            f"RISK BUDGET",
            f"  Daily loss limit: ${r.max_daily_loss_usd:,.2f} ({r.max_daily_loss_pct}%)",
            f"  Total DD limit:   ${r.max_total_loss_usd:,.2f} ({r.max_total_loss_pct}%)",
            f"  Current DD:       ${status.total_drawdown_usd:,.2f} ({status.total_drawdown_pct:.1f}%)",
            f"  DD buffer left:   ${status.total_dd_remaining_usd:,.2f}",
            f"",
            f"CALENDAR",
            f"  Start date:     {status.challenge_start_date}",
            f"  Days elapsed:   {status.days_elapsed}",
            f"  Days remaining: {status.days_remaining} / {r.max_trading_days}",
            f"  Trading days:   {status.trading_days_completed} / {r.min_trading_days} min required",
            f"",
        ]

        if history:
            total_pnl = sum(float(d.get("pnl_usd", 0)) for d in history)
            total_trades = sum(int(d.get("trade_count", 0)) for d in history)
            winning_days = sum(1 for d in history if float(d.get("pnl_usd", 0)) > 0)
            parts.append(f"RECENT PERFORMANCE ({len(history)} days)")
            parts.append(
                f"  P&L: ${total_pnl:+,.2f} | {total_trades} trades | "
                f"{winning_days}/{len(history)} winning days"
            )
            # Worst day
            worst = min(history, key=lambda d: float(d.get("pnl_usd", 0)))
            parts.append(
                f"  Worst day: {worst.get('trade_date','?')} "
                f"${float(worst.get('pnl_usd',0)):+,.2f}"
            )
            parts.append("")

        if status.alerts:
            parts.append("=== ACTIVE ALERTS ===")
            for alert in status.alerts:
                parts.append(alert)
            parts.append("")

        parts.append(
            "Provide a comprehensive challenge overview covering: "
            "(1) overall health and pace toward the target, "
            "(2) key risks that could blow the challenge, "
            "(3) recommended strategy adjustments for the remaining days. "
            'Respond with JSON: {"verdict": "...", "message": "...", "key_points": ["...", "..."], "risk_usd": null}'
            "\nVerdict options: ON_TRACK / AT_RISK / CRITICAL / PASSED / BREACHED"
        )

        return "\n".join(parts)

    # ── Open Q&A ──────────────────────────────────────────────────────────────

    def ask(self, question: str) -> CoachAdvice:
        """
        Free-form question about the challenge.
        Examples:
          "Should I increase lot size for the last 5 days?"
          "I've been taking too many trades. What's my pattern?"
          "How much profit do I need per day to finish on time?"
        """
        status = self._tracker.get_status()
        ctx = self._build_context_block(status) if status else "Challenge status unavailable."

        prompt = (
            f"{ctx}\n\n"
            f"=== TRADER'S QUESTION ===\n"
            f"{question}\n\n"
            "Answer specifically to this challenge's numbers. Be direct. "
            'Respond with JSON: {"verdict": "N/A", "message": "...", "key_points": ["...", "..."], "risk_usd": null}'
        )
        return self._call_groq(prompt)

    def _build_context_block(self, status: ChallengeStatus) -> str:
        r = status.rules
        return (
            f"=== CHALLENGE CONTEXT ===\n"
            f"Firm: {r.firm_name} | Phase: {status.current_phase}\n"
            f"Balance: ${status.current_balance:,.2f} | P&L: ${status.total_pnl_usd:+,.2f}\n"
            f"Target: {status.profit_progress_pct:.0f}% done | "
            f"Days left: {status.days_remaining} | "
            f"DD remaining: ${status.total_dd_remaining_usd:,.2f}"
        )

    # ── Groq call ─────────────────────────────────────────────────────────────

    def _call_groq(
        self,
        prompt:     str,
        risk_usd:   Optional[float] = None,
        max_tokens: int = _MAX_TOKENS,
    ) -> CoachAdvice:
        """Send prompt to Groq and parse the JSON response."""
        try:
            resp = self._client.chat.completions.create(
                model       = _MODEL,
                max_tokens  = max_tokens,
                temperature = _TEMPERATURE,
                messages    = [
                    {"role": "system", "content": _build_system_prompt()},
                    {"role": "user",   "content": prompt},
                ],
            )
            raw     = resp.choices[0].message.content or ""
            tokens  = resp.usage.total_tokens if resp.usage else 0

            log.info("prop_coach_response", tokens=tokens,
                     challenge_id=self.challenge_id)

            parsed = self._parse_json(raw)
            return CoachAdvice(
                verdict      = parsed.get("verdict", "N/A"),
                message      = parsed.get("message", raw),
                key_points   = parsed.get("key_points", []),
                risk_usd     = parsed.get("risk_usd") or risk_usd,
                raw_response = raw,
                tokens_used  = tokens,
            )

        except Exception as e:
            log.error("prop_coach_error", error=str(e))
            return CoachAdvice(
                verdict      = "N/A",
                message      = f"Coach unavailable: {e}",
                key_points   = [],
                raw_response = str(e),
            )

    def _parse_json(self, text: str) -> dict:
        """Parse JSON from AI response, handling markdown code fences."""
        # Strip ```json ... ``` fences
        stripped = text.strip()
        for fence in ("```json", "```"):
            if stripped.startswith(fence):
                stripped = stripped[len(fence):]
                break
        if stripped.endswith("```"):
            stripped = stripped[:-3]
        stripped = stripped.strip()

        # Find first { ... } block
        start = stripped.find("{")
        end   = stripped.rfind("}")
        if start != -1 and end != -1:
            try:
                return json.loads(stripped[start:end + 1])
            except json.JSONDecodeError:
                pass

        # Fallback
        return {"verdict": "N/A", "message": stripped, "key_points": [], "risk_usd": None}
