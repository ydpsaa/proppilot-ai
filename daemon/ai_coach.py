"""
PropPilot AI — AI Coach
Groq (Llama 3.3 70B) integration — FREE, no credit card required.
OpenAI-compatible API via Groq cloud.

Sign up: https://console.groq.com → API Keys → Create Key
Put key in .env: GROQ_API_KEY=gsk_...

Usage:
    coach = AICoach()
    narrative = coach.pre_trade_narrative(signal, account, context)
    summary   = coach.session_summary(signals, trades, account)
    analysis  = coach.post_trade_analysis(position)
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

import structlog
from openai import OpenAI

import config
from signal_engine import SignalResult

log = structlog.get_logger("ai_coach")

# ─── Prompt helpers ───────────────────────────────────────────────────────────

def _fmt_signal(signal: SignalResult) -> str:
    return (
        f"Symbol:       {signal.symbol}\n"
        f"Direction:    {signal.direction}\n"
        f"Verdict:      {signal.verdict}\n"
        f"Confidence:   {signal.confidence}%\n"
        f"Session:      {signal.session_name}\n"
        f"HTF Trend:    {signal.htf_trend}\n"
        f"Entry:        {signal.entry_price}\n"
        f"SL:           {signal.sl_price}\n"
        f"TP1:          {signal.tp1_price}  |  TP2: {signal.tp2_price}\n"
        f"R/R:          {signal.risk_reward:.2f}\n"
        f"ATR:          {signal.atr:.5f}\n"
        f"Sweep:        {'YES' if signal.sweep_detected else 'NO'}\n"
        f"MSS:          {'YES' if signal.mss_detected else 'NO'}\n"
        f"Displacement: {'YES' if signal.displacement else 'NO'}\n"
        f"FVG:          {'YES' if signal.fvg_detected else 'NO'}\n"
        f"OTE Zone:     {'YES' if signal.ote_zone else 'NO'}\n"
        f"Codes:        {', '.join(signal.reasoning_codes)}"
    )


def _fmt_account(account: dict) -> str:
    bal    = account.get("balance", 100_000)
    equity = account.get("equity", bal)
    dpnl   = account.get("daily_pnl_usd", 0)
    trades = account.get("daily_trades", 0)
    wins   = account.get("daily_wins", 0)
    losses = account.get("daily_losses", 0)
    return (
        f"Balance: ${bal:,.2f}  Equity: ${equity:,.2f}\n"
        f"Daily P&L: ${dpnl:+.2f}  |  Trades: {trades}  (W:{wins} L:{losses})"
    )


# ─── AICoach ─────────────────────────────────────────────────────────────────

class AICoach:
    """
    AI Coach powered by Groq (free tier).
    Model: llama-3.3-70b-versatile — 32K context, very fast.
    Falls back silently if API key is missing.
    """

    MODEL      = "llama-3.3-70b-versatile"
    BASE_URL   = "https://api.groq.com/openai/v1"
    MAX_TOKENS = 1024

    def __init__(self):
        api_key = config.GROQ_API_KEY
        if not api_key or api_key.startswith("ВСТАВЬ"):
            log.warning("ai_coach_no_key",
                        msg="GROQ_API_KEY not set — AI Coach disabled")
            self._client = None
        else:
            self._client = OpenAI(
                base_url=self.BASE_URL,
                api_key=api_key,
            )
            log.info("ai_coach_init", model=self.MODEL, provider="Groq")

    # ── Public API ────────────────────────────────────────────────────────────

    def pre_trade_narrative(
        self,
        signal:  SignalResult,
        account: dict,
        context: dict,
    ) -> str:
        """3-4 sentence SMC pre-trade briefing. Stored in bot_memory.market_notes."""
        lessons_txt = "\n".join(f"- {l}" for l in context.get("recent_lessons", []))
        levels_txt  = json.dumps(context.get("key_levels", {}), indent=2)

        prompt = f"""You are PropPilot AI, an expert Smart Money Concepts (SMC/ICT) trading analyst.

## Current Signal
{_fmt_signal(signal)}

## Account State
{_fmt_account(account)}

## Recent Bot Lessons
{lessons_txt or "None yet."}

## Key Watch Levels
{levels_txt}

Write a concise pre-trade briefing (3-4 sentences):
1. Why this setup is valid (or questionable) from an SMC perspective.
2. Key confluences present or missing.
3. One specific risk or invalidation level to watch.
4. Confidence assessment: agree/partially agree/disagree with the {signal.confidence}% score.

Be direct and analytical. No greetings."""

        return self._call(prompt, max_tokens=400)

    def post_trade_analysis(
        self,
        position: dict,
        signal_context: str = "",
    ) -> str:
        """ONE actionable lesson after a position closes. Stored in lessons_learned."""
        pnl     = position.get("pnl_usd", 0)
        pnl_r   = position.get("pnl_r", 0)
        entry   = position.get("entry_price")
        sl      = position.get("sl_price")
        tp1     = position.get("tp1_price")
        tp2     = position.get("tp2_price")
        close_p = position.get("close_price")
        sym     = position.get("symbol", "?")
        status  = position.get("status", "CLOSED")

        dur_hrs = ""
        if position.get("opened_at") and position.get("closed_at"):
            try:
                opened  = datetime.fromisoformat(position["opened_at"].replace("Z", "+00:00"))
                closed  = datetime.fromisoformat(position["closed_at"].replace("Z", "+00:00"))
                dur_hrs = f"{(closed - opened).total_seconds() / 3600:.1f}h"
            except Exception:
                pass

        sig_ctx = ("Signal context:\n" + signal_context) if signal_context else ""

        prompt = f"""You are PropPilot AI post-trade analyst.

## Closed Position
Symbol:    {sym}
Direction: {position.get("direction")}
Result:    {status}
P&L:       ${pnl:+.2f} ({pnl_r:+.2f}R)
Entry:     {entry}  ->  Close: {close_p}
SL: {sl}   TP1: {tp1}   TP2: {tp2}
Duration:  {dur_hrs or "unknown"}
{sig_ctx}

Write ONE actionable lesson (2-3 sentences):
- What worked or failed in this trade's SMC logic.
- A specific rule to improve future signals.

No fluff. Be concrete."""

        return self._call(prompt, max_tokens=200)

    def session_summary(
        self,
        signals:      list[dict],
        trades:       list[dict],
        account:      dict,
        session_name: str = "",
    ) -> tuple[str, str, dict]:
        """
        End-of-session summary.
        Returns: (market_notes, lessons_learned, next_watch_levels)
        """
        nl = "\n"
        sigs_txt = nl.join(
            f"  {s.get('symbol')} {s.get('direction')} "
            f"conf={s.get('confidence')}% {s.get('verdict')}"
            for s in signals[:6]
        ) or "  None"

        result_tag = lambda t: "OK" if t.get("success") else "FAIL"
        trades_txt = nl.join(
            f"  {t.get('symbol')} {t.get('direction')} "
            f"@ {t.get('entry_price')} [{result_tag(t)}]"
            for t in trades[:6]
        ) or "  None"

        n_sigs   = len(signals)
        n_trades = len(trades)

        prompt = f"""You are PropPilot AI session analyst.

## Session: {session_name or "Unknown"}
## Account
{_fmt_account(account)}

## Signals Evaluated ({n_sigs} total)
{sigs_txt}

## Trades Placed ({n_trades} total)
{trades_txt}

Respond in EXACTLY this format (no extra text):

MARKET_NOTES: <2 sentences on market structure and bias observed>
LESSONS: <1-2 sentences the bot should remember for next session>
WATCH_LEVELS: {{"SYMBOL_level": price_float, ...}}"""

        raw = self._call(prompt, max_tokens=400)
        return self._parse_session_summary(raw)

    def evaluate_signal_quality(self, signal: SignalResult) -> dict:
        """Returns {grade: A/B/C/D, flags: [...], suggestion: str}"""
        prompt = f"""You are a senior SMC trading coach reviewing a bot signal.

## Signal
{_fmt_signal(signal)}

Rate this signal in JSON:
{{
  "grade": "A" | "B" | "C" | "D",
  "flags": ["list of concerns or strengths"],
  "suggestion": "one-line improvement or approval"
}}

Respond ONLY with the JSON object."""

        raw = self._call(prompt, max_tokens=200)
        try:
            start = raw.find("{")
            end   = raw.rfind("}") + 1
            return json.loads(raw[start:end])
        except Exception:
            return {"grade": "C", "flags": ["parse_error"], "suggestion": raw[:120]}

    # ── Internal ──────────────────────────────────────────────────────────────

    def _call(self, prompt: str, max_tokens: int = 512) -> str:
        """Call Groq API. Returns empty string if client not initialised."""
        if self._client is None:
            return ""
        try:
            resp = self._client.chat.completions.create(
                model=self.MODEL,
                max_tokens=max_tokens,
                temperature=0.3,
                messages=[{"role": "user", "content": prompt}],
            )
            text = resp.choices[0].message.content or ""
            log.debug("ai_coach_call",
                      tokens_in=resp.usage.prompt_tokens,
                      tokens_out=resp.usage.completion_tokens)
            return text.strip()
        except Exception as e:
            log.error("ai_coach_error", error=str(e))
            return f"[AI Coach error: {e}]"

    @staticmethod
    def _parse_session_summary(raw: str) -> tuple[str, str, dict]:
        market_notes = ""
        lessons      = ""
        watch_levels: dict = {}

        try:
            lines     = raw.split("\n")
            mode      = None
            level_buf = []

            for line in lines:
                if line.startswith("MARKET_NOTES:"):
                    mode = "notes"
                    market_notes = line[len("MARKET_NOTES:"):].strip()
                elif line.startswith("LESSONS:"):
                    mode = "lessons"
                    lessons = line[len("LESSONS:"):].strip()
                elif line.startswith("WATCH_LEVELS:"):
                    mode = "levels"
                    remainder = line[len("WATCH_LEVELS:"):].strip()
                    if remainder:
                        level_buf.append(remainder)
                elif mode == "notes" and line.strip():
                    market_notes += " " + line.strip()
                elif mode == "lessons" and line.strip():
                    lessons += " " + line.strip()
                elif mode == "levels" and line.strip():
                    level_buf.append(line.strip())

            levels_raw = " ".join(level_buf)
            if levels_raw:
                start = levels_raw.find("{")
                end   = levels_raw.rfind("}") + 1
                if start >= 0 and end > start:
                    watch_levels = json.loads(levels_raw[start:end])

        except Exception as e:
            log.warning("session_summary_parse_error", error=str(e))

        return market_notes.strip(), lessons.strip(), watch_levels
