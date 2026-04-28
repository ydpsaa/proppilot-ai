"""
PropPilot AI — Rules Engine
Pre-trade rule checker for prop firm challenges.

Wraps ChallengeTracker and evaluates every planned trade against
the active challenge's ruleset before order placement.

Usage:
    re = RulesEngine(challenge_id=1)

    # Basic pre-trade check
    check = re.check(risk_usd=50.0, lot_size=0.05)
    if check.passed:
        place_trade()
    else:
        print(check.reasons)

    # Full check with optional context
    check = re.check(
        risk_usd=50.0,
        lot_size=0.05,
        symbol="XAU/USD",
        session="London",
        is_news_time=False,
    )
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone, time as dtime
from typing import Optional

import structlog

from challenge_tracker import ChallengeTracker, ChallengeStatus, PreTradeCheck, PHASE_BREACHED, PHASE_PASSED

log = structlog.get_logger("rules_engine")


# ─── Weekend session boundaries (UTC) ────────────────────────────────────────

# Forex closes Fri ~21:00 UTC, reopens Sun ~22:00 UTC
_WEEKEND_CLOSE_UTC = dtime(21, 0)   # Friday close
_WEEKEND_OPEN_UTC  = dtime(22, 0)   # Sunday re-open

# Sessions that count as "overnight" — if overnight_hold_ban is True,
# warn on trades that might hold through the session boundary
_SESSION_END_UTC: dict[str, dtime] = {
    "Asian":   dtime(8, 0),    # ~08:00 UTC
    "London":  dtime(16, 0),   # ~16:00 UTC
    "Overlap": dtime(17, 0),   # ~17:00 UTC
    "NewYork": dtime(21, 0),   # ~21:00 UTC
}


@dataclass
class RuleCheckResult:
    """
    Detailed result from a pre-trade rules check.
    passed  = True  → all hard rules OK, trade is allowed
    passed  = False → at least one hard rule violated
    warnings        → soft concerns (e.g. approaching daily limit)
    """
    passed:     bool
    risk_usd:   float
    lot_size:   float
    reasons:    list[str] = field(default_factory=list)
    warnings:   list[str] = field(default_factory=list)

    # Headroom summaries for the AI coach
    daily_remaining_usd:  float = 0.0
    total_remaining_usd:  float = 0.0
    profit_progress_pct:  float = 0.0

    def __bool__(self) -> bool:
        return self.passed

    def summary(self) -> str:
        """One-line summary for logging / display."""
        verdict = "✅ ALLOWED" if self.passed else "🚫 BLOCKED"
        parts   = [verdict, f"risk=${self.risk_usd:.0f}"]
        if self.reasons:
            parts.append(f"| block: {'; '.join(self.reasons)}")
        if self.warnings:
            parts.append(f"| warn: {'; '.join(self.warnings)}")
        return " ".join(parts)


# ─── Rules Engine ─────────────────────────────────────────────────────────────

class RulesEngine:
    """
    Evaluates all prop firm rules for a given trade before order placement.

    Hard rules (block trade):
        1. Challenge is breached / passed / expired
        2. Daily loss limit already hit
        3. Total drawdown limit already hit
        4. Trade risk exceeds per-trade risk cap
        5. Lot size exceeds firm lot cap
        6. Weekend hold ban (trade placed on Friday near close)
        7. Overnight hold ban (trade placed near session end)

    Soft warnings (allow but flag):
        A. Daily loss ≥ 50% / 75% of limit consumed
        B. Total DD ≥ 50% / 75% consumed
        C. This trade + today's loss = > 80% of daily limit
        D. Consistency rule: today's profit > X% threshold
        E. Low trading days remaining vs min requirement
    """

    def __init__(self, challenge_id: int) -> None:
        self._tracker = ChallengeTracker(challenge_id)
        self.challenge_id = challenge_id

    # ── Main check method ─────────────────────────────────────────────────────

    def check(
        self,
        risk_usd:      float,
        lot_size:      float      = 0.0,
        symbol:        str        = "",
        session:       str        = "",
        is_news_time:  bool       = False,
        now:           Optional[datetime] = None,
    ) -> RuleCheckResult:
        """
        Run all rule checks for a planned trade.

        Args:
            risk_usd:     USD at risk for this trade (entry to SL)
            lot_size:     Lot size (0 = skip lot check)
            symbol:       Trading symbol (for logging)
            session:      Session name: Asian / London / Overlap / NewYork
            is_news_time: True if entering within N minutes of high-impact news
            now:          Override current time (for testing)

        Returns:
            RuleCheckResult with passed, reasons, warnings, and headroom info
        """
        status = self._tracker.get_status()
        if not status:
            return RuleCheckResult(
                passed   = False,
                risk_usd = risk_usd,
                lot_size = lot_size,
                reasons  = ["Could not load challenge status from database"],
            )

        rules    = status.rules
        result   = RuleCheckResult(
            passed   = True,
            risk_usd = risk_usd,
            lot_size = lot_size,
            daily_remaining_usd = status.daily_loss_remaining_usd,
            total_remaining_usd = status.total_dd_remaining_usd,
            profit_progress_pct = status.profit_progress_pct,
        )

        now = now or datetime.now(tz=timezone.utc)

        # ── HARD RULES ────────────────────────────────────────────────────────

        # 1. Challenge state
        if status.current_phase == PHASE_BREACHED:
            result.passed = False
            result.reasons.append("Challenge is BREACHED — no trading allowed")
            return result  # No point checking further

        if status.current_phase == PHASE_PASSED:
            result.passed = False
            result.reasons.append("Challenge is already PASSED — request payout")
            return result

        if status.expired:
            result.passed = False
            result.reasons.append(
                f"Challenge expired ({status.days_elapsed} days elapsed, "
                f"max {rules.max_trading_days})"
            )

        # 2. Daily loss limit
        if status.daily_limit_breached:
            result.passed = False
            result.reasons.append(
                f"Daily loss limit already hit "
                f"(limit ${rules.max_daily_loss_usd:.0f}, "
                f"used ${rules.max_daily_loss_usd - status.daily_loss_remaining_usd:.0f})"
            )

        # 3. Total DD limit
        if status.total_limit_breached:
            result.passed = False
            result.reasons.append(
                f"Total drawdown limit reached "
                f"(limit ${rules.max_total_loss_usd:.0f}, "
                f"used ${rules.max_total_loss_usd - status.total_dd_remaining_usd:.0f})"
            )

        # 4. Per-trade risk cap
        if rules.max_trade_risk_usd > 0 and risk_usd > rules.max_trade_risk_usd:
            result.passed = False
            result.reasons.append(
                f"Trade risk ${risk_usd:.0f} exceeds firm cap "
                f"${rules.max_trade_risk_usd:.0f} "
                f"({rules.max_trade_risk_pct:.1f}% of account)"
            )

        # 5. Lot size cap
        if rules.max_lot_size > 0 and lot_size > rules.max_lot_size:
            result.passed = False
            result.reasons.append(
                f"Lot size {lot_size:.2f} exceeds firm cap {rules.max_lot_size:.2f}"
            )

        # 6. Weekend hold ban
        if rules.weekend_hold_ban:
            weekend_issue = self._check_weekend(now)
            if weekend_issue:
                result.passed = False
                result.reasons.append(weekend_issue)

        # 7. News ban
        if rules.news_trading_ban and is_news_time:
            result.passed = False
            result.reasons.append(
                "News trading is banned by this firm — high-impact event within window"
            )

        # 8. Overnight hold ban (soft → hard if session is near close)
        if rules.overnight_hold_ban and session:
            overnight_issue = self._check_overnight(now, session)
            if overnight_issue:
                result.passed = False
                result.reasons.append(overnight_issue)

        # ── SOFT WARNINGS ─────────────────────────────────────────────────────

        # A. Daily headroom warnings
        if not status.daily_limit_breached:
            # Would this trade, if it fully loses, breach the daily limit?
            projected_loss = (rules.max_daily_loss_usd - status.daily_loss_remaining_usd) + risk_usd
            projected_pct  = projected_loss / rules.max_daily_loss_usd * 100 if rules.max_daily_loss_usd else 0.0

            if projected_pct >= 100:
                result.warnings.append(
                    f"⚠️ This trade's full loss would breach daily limit "
                    f"(${status.daily_loss_remaining_usd:.0f} remaining, "
                    f"risking ${risk_usd:.0f})"
                )
            elif status.daily_loss_used_pct >= 75:
                result.warnings.append(
                    f"⚠️ Daily limit at {status.daily_loss_used_pct:.0f}% "
                    f"— only ${status.daily_loss_remaining_usd:.0f} buffer left"
                )
            elif status.daily_loss_used_pct >= 50:
                result.warnings.append(
                    f"ℹ️ Daily loss at {status.daily_loss_used_pct:.0f}% of limit"
                )

        # B. Total DD warnings
        if not status.total_limit_breached:
            if status.total_dd_used_pct >= 75:
                result.warnings.append(
                    f"⚠️ Total DD at {status.total_dd_used_pct:.0f}% of limit "
                    f"— ${status.total_dd_remaining_usd:.0f} remaining buffer"
                )
            elif status.total_dd_used_pct >= 50:
                result.warnings.append(
                    f"ℹ️ Total drawdown at {status.total_dd_used_pct:.0f}% of limit"
                )

        # C. Consistency rule
        if rules.consistency_pct > 0 and status.today_pnl_usd > 0:
            total_profit = max(0.0, status.total_pnl_usd)
            if total_profit > 0:
                today_share = status.today_pnl_usd / total_profit * 100
                if today_share > rules.consistency_pct:
                    result.warnings.append(
                        f"⚠️ Consistency: today's profit is "
                        f"{today_share:.0f}% of total (limit {rules.consistency_pct:.0f}%) "
                        f"— avoid adding more today"
                    )

        # D. Trading days pressure
        days_needed = rules.min_trading_days - status.trading_days_completed
        if days_needed > 0 and status.days_remaining <= days_needed + 2:
            result.warnings.append(
                f"📅 Tight on trading days: need {days_needed} more "
                f"but only {status.days_remaining} days left"
            )

        # E. Profit target nearly reached — protect gains
        if status.profit_progress_pct >= 80 and status.profit_progress_pct < 100:
            result.warnings.append(
                f"🎯 Close to profit target ({status.profit_progress_pct:.0f}%) "
                f"— consider reducing risk to lock it in"
            )

        if result.passed:
            log.info("rules_check_passed",
                     challenge_id=self.challenge_id, symbol=symbol,
                     risk_usd=round(risk_usd, 2), warnings=len(result.warnings))
        else:
            log.warning("rules_check_blocked",
                        challenge_id=self.challenge_id, symbol=symbol,
                        risk_usd=round(risk_usd, 2),
                        reasons=result.reasons)

        return result

    # ── Time-based helpers ────────────────────────────────────────────────────

    def _check_weekend(self, now: datetime) -> Optional[str]:
        """
        Returns a block reason string if we're in the weekend no-trade window.
        Forex markets close Fri 21:00 UTC, reopen Sun 22:00 UTC.
        """
        weekday = now.weekday()  # 0=Mon, 4=Fri, 5=Sat, 6=Sun
        t = now.time().replace(tzinfo=None)

        if weekday == 4 and t >= _WEEKEND_CLOSE_UTC:
            return (
                "Weekend hold ban: Forex market closes Fri 21:00 UTC "
                "— do not open new trades now"
            )
        if weekday == 5:
            return "Weekend hold ban: Saturday — market closed"
        if weekday == 6 and t < _WEEKEND_OPEN_UTC:
            return (
                "Weekend hold ban: market reopens Sun 22:00 UTC "
                f"(current UTC: {t.strftime('%H:%M')})"
            )
        return None

    def _check_overnight(self, now: datetime, session: str) -> Optional[str]:
        """
        Returns a block reason if opening a trade would likely hold overnight.
        Triggered if time is within 30 min of session end.
        """
        end_time = _SESSION_END_UTC.get(session)
        if not end_time:
            return None

        now_time = now.time().replace(tzinfo=None)
        # Calculate minutes until session end
        end_minutes   = end_time.hour * 60 + end_time.minute
        now_minutes   = now_time.hour * 60 + now_time.minute
        diff_minutes  = end_minutes - now_minutes

        if 0 <= diff_minutes <= 30:
            return (
                f"Overnight hold ban: {session} session ends in ~{diff_minutes} min "
                f"(at {end_time.strftime('%H:%M')} UTC) — trade may hold overnight"
            )
        return None

    # ── Safe risk sizing ──────────────────────────────────────────────────────

    def safe_risk_usd(self, desired_risk_usd: float) -> float:
        """
        Return the maximum safe risk for a trade given current challenge state.
        Clamps to the remaining daily loss buffer (with 10% safety margin).
        """
        status = self._tracker.get_status()
        if not status:
            return desired_risk_usd

        rules = status.rules

        # Cap by daily remaining (with 10% buffer so we never accidentally hit the limit)
        max_by_daily = status.daily_loss_remaining_usd * 0.90

        # Cap by total remaining
        max_by_total = status.total_dd_remaining_usd * 0.90

        # Cap by firm per-trade rule
        max_by_rule = rules.max_trade_risk_usd if rules.max_trade_risk_usd > 0 else desired_risk_usd

        safe = min(desired_risk_usd, max_by_daily, max_by_total, max_by_rule)
        safe = max(0.0, safe)

        if safe < desired_risk_usd:
            log.info("risk_clamped",
                     desired=round(desired_risk_usd, 2),
                     safe=round(safe, 2),
                     daily_remaining=round(max_by_daily, 2),
                     total_remaining=round(max_by_total, 2))

        return round(safe, 2)

    # ── Violation logging ─────────────────────────────────────────────────────

    def log_violation(
        self,
        rule_name:   str,
        description: str,
        severity:    str = "WARNING",   # WARNING / CRITICAL
    ) -> bool:
        """Persist a rule violation event to prop_violations."""
        try:
            self._tracker._sb.table("prop_violations").insert({
                "challenge_id": self.challenge_id,
                "occurred_at":  datetime.now(tz=timezone.utc).isoformat(),
                "rule_name":    rule_name,
                "description":  description,
                "severity":     severity,
            }).execute()
            log.warning("prop_violation_logged",
                        challenge_id=self.challenge_id,
                        rule=rule_name, severity=severity)
            return True
        except Exception as e:
            log.error("prop_violation_log_error", error=str(e))
            return False
