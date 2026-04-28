"""
PropPilot AI — Challenge Tracker
Tracks prop firm challenge rules and monitors daily/overall metrics.

Completely isolated from the algo trading and journal systems.
Connects to the same Supabase instance but only touches prop_* tables.

Supported firms (expandable):
    FTMO, MyForexFunds style, The5ers, Funded Next, Apex — all use similar rule sets.
    Rules are stored per-challenge in prop_challenges table.

Usage:
    ct = ChallengeTracker(challenge_id=1)

    # Check before taking a trade
    ok, reason = ct.pre_trade_check(risk_usd=50.0)

    # Record a closed trade
    ct.record_trade(pnl_usd=120.0, pnl_r=1.2, symbol="XAU/USD")

    # Get full status snapshot
    status = ct.get_status()
    print(status.phase, status.daily_loss_remaining_usd)
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Optional

import structlog

import config

log = structlog.get_logger("challenge_tracker")


# ─── Challenge phase constants ────────────────────────────────────────────────

PHASE_CHALLENGE   = "CHALLENGE"     # Phase 1 — hit profit target
PHASE_VERIFICATION = "VERIFICATION" # Phase 2 — confirm consistency
PHASE_FUNDED      = "FUNDED"        # Funded account — keep it
PHASE_BREACHED    = "BREACHED"      # Rules violated — account terminated
PHASE_PASSED      = "PASSED"        # All phases completed


# ─── Data models ──────────────────────────────────────────────────────────────

@dataclass
class ChallengeRules:
    """
    The fixed ruleset for a prop challenge.
    All percentage values are expressed as positive decimals (e.g., 5.0 = 5%).
    """
    account_id:          int
    firm_name:           str
    phase:               str                    # CHALLENGE / VERIFICATION / FUNDED
    account_size_usd:    float                  # Starting balance (e.g., 100_000)

    # Loss limits (as % of account_size, always positive)
    max_daily_loss_pct:  float   = 5.0          # Max loss in a single day
    max_total_loss_pct:  float   = 10.0         # Max drawdown from starting balance

    # Profit targets (as % of account_size)
    profit_target_pct:   float   = 10.0         # Profit needed to pass (0 = no target)

    # Trading day requirements
    min_trading_days:    int     = 4            # Minimum unique trading days needed
    max_trading_days:    int     = 30           # Days allowed before challenge expires

    # Optional per-trade risk limit (0 = no limit)
    max_trade_risk_pct:  float   = 0.0          # Max risk per trade as % of balance
    max_lot_size:        float   = 0.0          # Max lots per trade (0 = no limit)

    # Consistency rule (some firms require no single day > X% of total profit)
    consistency_pct:     float   = 0.0          # 0 = disabled

    # Scale-out / trailing stop rules (firm-specific)
    trailing_drawdown:   bool    = False        # True = drawdown trails peak equity
    news_trading_ban:    bool    = False        # True = no trades during high-impact news
    overnight_hold_ban:  bool    = False        # True = must close before session end
    weekend_hold_ban:    bool    = True         # True = must close before weekend

    # Computed helpers (set from account_size)
    @property
    def max_daily_loss_usd(self) -> float:
        return self.account_size_usd * self.max_daily_loss_pct / 100.0

    @property
    def max_total_loss_usd(self) -> float:
        return self.account_size_usd * self.max_total_loss_pct / 100.0

    @property
    def profit_target_usd(self) -> float:
        return self.account_size_usd * self.profit_target_pct / 100.0

    @property
    def max_trade_risk_usd(self) -> float:
        if self.max_trade_risk_pct <= 0:
            return 0.0
        return self.account_size_usd * self.max_trade_risk_pct / 100.0


@dataclass
class ChallengeStatus:
    """
    Live snapshot of a challenge's current state.
    """
    challenge_id:          int
    rules:                 ChallengeRules
    current_phase:         str

    # Equity
    starting_balance:      float
    current_balance:       float
    peak_balance:          float              # For trailing DD firms

    # Progress
    total_pnl_usd:         float             # current_balance - starting_balance
    total_pnl_pct:         float             # total_pnl_usd / starting_balance * 100
    total_drawdown_usd:    float             # peak - current
    total_drawdown_pct:    float

    # Daily
    today_pnl_usd:         float
    today_trades:          int
    today_date:            date

    # Calendar
    trading_days_completed: int
    challenge_start_date:  date
    days_elapsed:          int
    days_remaining:        int

    # Rule headroom
    daily_loss_used_pct:   float             # 0–100 (% of daily limit consumed)
    daily_loss_remaining_usd: float
    total_dd_used_pct:     float             # 0–100
    total_dd_remaining_usd:   float
    profit_progress_pct:   float             # 0–100 toward target

    # Violation flags
    daily_limit_breached:  bool = False
    total_limit_breached:  bool = False
    expired:               bool = False
    is_passing:            bool = False       # All criteria met

    # Alerts (text list)
    alerts:                list[str] = field(default_factory=list)

    def safe_to_trade(self) -> bool:
        return (
            not self.daily_limit_breached
            and not self.total_limit_breached
            and not self.expired
            and self.current_phase not in (PHASE_BREACHED, PHASE_PASSED)
        )


@dataclass
class PreTradeCheck:
    """Result of a pre-trade risk rule check."""
    passed:       bool
    risk_usd:     float
    reasons:      list[str] = field(default_factory=list)
    warnings:     list[str] = field(default_factory=list)

    def __bool__(self) -> bool:
        return self.passed


# ─── Challenge Tracker ────────────────────────────────────────────────────────

class ChallengeTracker:
    """
    Supabase interface for the Prop Firm Challenge system.
    All methods are synchronous (use asyncio.to_thread for async contexts).

    One ChallengeTracker instance = one challenge account.
    """

    def __init__(self, challenge_id: int) -> None:
        self._sb           = config.get_supabase()
        self.challenge_id  = challenge_id
        self._challenge    : Optional[dict] = None   # raw DB row cache
        self._rules        : Optional[ChallengeRules] = None

    # ── Cache helpers ──────────────────────────────────────────────────────────

    def _load(self, force: bool = False) -> Optional[dict]:
        """Load the challenge row from Supabase (cached)."""
        if self._challenge is not None and not force:
            return self._challenge
        try:
            res = (self._sb.table("prop_challenges")
                   .select("*")
                   .eq("id", self.challenge_id)
                   .single()
                   .execute())
            self._challenge = res.data or {}
            self._rules = None  # invalidate rules cache
            return self._challenge
        except Exception as e:
            log.error("challenge_load_error", id=self.challenge_id, error=str(e))
            return None

    def get_rules(self, force: bool = False) -> Optional[ChallengeRules]:
        """Build a ChallengeRules object from the DB row."""
        if self._rules is not None and not force:
            return self._rules
        row = self._load(force=force)
        if not row:
            return None
        self._rules = ChallengeRules(
            account_id          = row.get("account_id", 1),
            firm_name           = row.get("firm_name", "Unknown"),
            phase               = row.get("phase", PHASE_CHALLENGE),
            account_size_usd    = float(row.get("account_size_usd", 100_000)),
            max_daily_loss_pct  = float(row.get("max_daily_loss_pct", 5.0)),
            max_total_loss_pct  = float(row.get("max_total_loss_pct", 10.0)),
            profit_target_pct   = float(row.get("profit_target_pct", 10.0)),
            min_trading_days    = int(row.get("min_trading_days", 4)),
            max_trading_days    = int(row.get("max_trading_days", 30)),
            max_trade_risk_pct  = float(row.get("max_trade_risk_pct", 0.0)),
            max_lot_size        = float(row.get("max_lot_size", 0.0)),
            consistency_pct     = float(row.get("consistency_pct", 0.0)),
            trailing_drawdown   = bool(row.get("trailing_drawdown", False)),
            news_trading_ban    = bool(row.get("news_trading_ban", False)),
            overnight_hold_ban  = bool(row.get("overnight_hold_ban", False)),
            weekend_hold_ban    = bool(row.get("weekend_hold_ban", True)),
        )
        return self._rules

    # ── Status snapshot ───────────────────────────────────────────────────────

    def get_status(self) -> Optional[ChallengeStatus]:
        """
        Compute a full live ChallengeStatus snapshot.
        Reads challenge row + today's daily stats.
        """
        row = self._load(force=True)
        if not row:
            return None
        rules = self.get_rules()
        if not rules:
            return None

        today     = date.today()
        today_str = today.isoformat()

        # Fetch today's daily stats row
        daily = self._fetch_daily(today_str)

        current_balance = float(row.get("current_balance", rules.account_size_usd))
        peak_balance    = float(row.get("peak_balance", current_balance))
        starting        = float(row.get("starting_balance", rules.account_size_usd))

        total_pnl_usd   = current_balance - starting
        total_pnl_pct   = (total_pnl_usd / starting * 100) if starting else 0.0

        # Drawdown
        if rules.trailing_drawdown:
            dd_usd = max(0.0, peak_balance - current_balance)
            dd_from = peak_balance
        else:
            dd_usd = max(0.0, starting - current_balance)
            dd_from = starting
        dd_pct = (dd_usd / dd_from * 100) if dd_from else 0.0

        # Daily P&L
        today_pnl_usd  = float(daily.get("pnl_usd", 0.0))
        today_trades   = int(daily.get("trade_count", 0))

        # Daily headroom
        daily_loss_used    = max(0.0, -today_pnl_usd)   # positive = we lost money
        daily_used_pct     = (daily_loss_used / rules.max_daily_loss_usd * 100
                              if rules.max_daily_loss_usd else 0.0)
        daily_remaining    = max(0.0, rules.max_daily_loss_usd - daily_loss_used)

        # Total headroom
        total_used_pct     = (dd_usd / rules.max_total_loss_usd * 100
                              if rules.max_total_loss_usd else 0.0)
        total_remaining    = max(0.0, rules.max_total_loss_usd - dd_usd)

        # Profit progress
        profit_progress    = 0.0
        if rules.profit_target_usd > 0:
            profit_progress = min(100.0, max(0.0, total_pnl_usd / rules.profit_target_usd * 100))

        # Trading days
        trading_days = int(row.get("trading_days_completed", 0))

        # Calendar
        start_date = date.fromisoformat(str(row.get("start_date", today_str))[:10])
        elapsed    = (today - start_date).days
        remaining  = max(0, rules.max_trading_days - elapsed)

        # Breach checks
        daily_breached = daily_loss_used >= rules.max_daily_loss_usd
        total_breached = dd_usd >= rules.max_total_loss_usd
        expired        = elapsed > rules.max_trading_days

        phase = row.get("phase", PHASE_CHALLENGE)

        # Passing check
        is_passing = (
            not daily_breached
            and not total_breached
            and not expired
            and total_pnl_usd >= rules.profit_target_usd
            and trading_days >= rules.min_trading_days
            and phase not in (PHASE_BREACHED, PHASE_PASSED)
        )

        # Build alerts
        alerts: list[str] = []
        if daily_used_pct >= 80:
            alerts.append(
                f"⚠️ Daily loss at {daily_used_pct:.0f}% of limit "
                f"(${daily_remaining:.0f} remaining)"
            )
        if total_used_pct >= 70:
            alerts.append(
                f"⚠️ Total drawdown at {total_used_pct:.0f}% of limit "
                f"(${total_remaining:.0f} buffer)"
            )
        if remaining <= 3 and not is_passing:
            alerts.append(
                f"⏰ Only {remaining} days left — need "
                f"${max(0, rules.profit_target_usd - total_pnl_usd):.0f} more profit"
            )
        if trading_days < rules.min_trading_days:
            needed = rules.min_trading_days - trading_days
            alerts.append(
                f"📅 Need {needed} more trading day(s) "
                f"(have {trading_days}/{rules.min_trading_days})"
            )
        if daily_breached:
            alerts.append("🚫 DAILY LOSS LIMIT HIT — no more trades today!")
        if total_breached:
            alerts.append("🚫 TOTAL DRAWDOWN LIMIT HIT — account at risk!")
        if expired:
            alerts.append("⌛ Challenge period expired!")
        if is_passing:
            alerts.append("✅ Profit target reached — ready to request payout!")

        return ChallengeStatus(
            challenge_id          = self.challenge_id,
            rules                 = rules,
            current_phase         = phase,
            starting_balance      = starting,
            current_balance       = current_balance,
            peak_balance          = peak_balance,
            total_pnl_usd         = round(total_pnl_usd, 2),
            total_pnl_pct         = round(total_pnl_pct, 2),
            total_drawdown_usd    = round(dd_usd, 2),
            total_drawdown_pct    = round(dd_pct, 2),
            today_pnl_usd         = round(today_pnl_usd, 2),
            today_trades          = today_trades,
            today_date            = today,
            trading_days_completed = trading_days,
            challenge_start_date  = start_date,
            days_elapsed          = elapsed,
            days_remaining        = remaining,
            daily_loss_used_pct   = round(daily_used_pct, 1),
            daily_loss_remaining_usd = round(daily_remaining, 2),
            total_dd_used_pct     = round(total_used_pct, 1),
            total_dd_remaining_usd = round(total_remaining, 2),
            profit_progress_pct   = round(profit_progress, 1),
            daily_limit_breached  = daily_breached,
            total_limit_breached  = total_breached,
            expired               = expired,
            is_passing            = is_passing,
            alerts                = alerts,
        )

    # ── Trade recording ───────────────────────────────────────────────────────

    def record_trade(
        self,
        pnl_usd:    float,
        pnl_r:      float,
        symbol:     str,
        direction:  str      = "",
        session:    str      = "",
        lot_size:   float    = 0.0,
        entry_price: float   = 0.0,
        exit_price:  float   = 0.0,
        notes:       str     = "",
    ) -> bool:
        """
        Record a completed trade in prop_trades and update prop_challenges + prop_daily_stats.
        Called after every trade close.
        """
        now      = datetime.now(tz=timezone.utc)
        today_str = now.date().isoformat()

        try:
            # 1. Insert trade record
            trade_row = {
                "challenge_id":  self.challenge_id,
                "recorded_at":   now.isoformat(),
                "trade_date":    today_str,
                "symbol":        symbol,
                "direction":     direction,
                "session":       session,
                "lot_size":      lot_size if lot_size else None,
                "entry_price":   entry_price if entry_price else None,
                "exit_price":    exit_price if exit_price else None,
                "pnl_usd":       round(pnl_usd, 2),
                "pnl_r":         round(pnl_r, 4),
                "notes":         notes or None,
            }
            trade_row = {k: v for k, v in trade_row.items() if v is not None}
            self._sb.table("prop_trades").insert(trade_row).execute()

            # 2. Upsert daily stats
            self._upsert_daily(today_str, pnl_usd)

            # 3. Update challenge balance and peak
            self._update_challenge_balance(pnl_usd, today_str)

            log.info("prop_trade_recorded",
                     challenge_id=self.challenge_id, symbol=symbol,
                     pnl_usd=round(pnl_usd, 2), pnl_r=round(pnl_r, 4))
            return True

        except Exception as e:
            log.error("prop_trade_record_error", challenge_id=self.challenge_id, error=str(e))
            return False

    def _upsert_daily(self, date_str: str, pnl_usd: float) -> None:
        """Upsert prop_daily_stats — increments pnl_usd and trade_count for today."""
        existing = self._fetch_daily(date_str)
        if existing and existing.get("id"):
            day_id    = existing["id"]
            new_pnl   = round(float(existing.get("pnl_usd", 0.0)) + pnl_usd, 2)
            new_count = int(existing.get("trade_count", 0)) + 1
            self._sb.table("prop_daily_stats").update({
                "pnl_usd":     new_pnl,
                "trade_count": new_count,
                "updated_at":  datetime.now(tz=timezone.utc).isoformat(),
            }).eq("id", day_id).execute()
        else:
            self._sb.table("prop_daily_stats").insert({
                "challenge_id": self.challenge_id,
                "trade_date":   date_str,
                "pnl_usd":      round(pnl_usd, 2),
                "trade_count":  1,
                "created_at":   datetime.now(tz=timezone.utc).isoformat(),
                "updated_at":   datetime.now(tz=timezone.utc).isoformat(),
            }).execute()

    def _fetch_daily(self, date_str: str) -> dict:
        """Fetch today's prop_daily_stats row."""
        try:
            res = (self._sb.table("prop_daily_stats")
                   .select("*")
                   .eq("challenge_id", self.challenge_id)
                   .eq("trade_date", date_str)
                   .limit(1)
                   .execute())
            rows = res.data or []
            return rows[0] if rows else {}
        except Exception as e:
            log.error("prop_daily_fetch_error", error=str(e))
            return {}

    def _update_challenge_balance(self, pnl_usd: float, today_str: str) -> None:
        """Update current_balance, peak_balance, trading_days_completed on prop_challenges."""
        row = self._load(force=True)
        if not row:
            return

        starting   = float(row.get("starting_balance", 100_000))
        current    = float(row.get("current_balance", starting))
        peak       = float(row.get("peak_balance", current))
        rules      = self.get_rules()

        new_current = round(current + pnl_usd, 2)
        new_peak    = max(peak, new_current)

        # Count unique trading days
        trading_days = self._count_trading_days()

        updates: dict = {
            "current_balance":         new_current,
            "peak_balance":            new_peak,
            "trading_days_completed":  trading_days,
            "last_trade_date":         today_str,
            "updated_at":              datetime.now(tz=timezone.utc).isoformat(),
        }

        # Auto-phase: check for breach
        if rules:
            dd_usd = max(0.0, starting - new_current) if not rules.trailing_drawdown \
                     else max(0.0, new_peak - new_current)
            today_daily = self._fetch_daily(today_str)
            today_loss  = max(0.0, -float(today_daily.get("pnl_usd", 0.0)))

            if dd_usd >= rules.max_total_loss_usd or today_loss >= rules.max_daily_loss_usd:
                updates["phase"] = PHASE_BREACHED
                log.warning("challenge_breached",
                            challenge_id=self.challenge_id,
                            dd_usd=round(dd_usd, 2),
                            today_loss=round(today_loss, 2))

        try:
            self._sb.table("prop_challenges").update(updates).eq("id", self.challenge_id).execute()
            self._challenge = None  # invalidate cache
        except Exception as e:
            log.error("challenge_balance_update_error", error=str(e))

    def _count_trading_days(self) -> int:
        """Count distinct trading days from prop_daily_stats."""
        try:
            res = (self._sb.table("prop_daily_stats")
                   .select("trade_date")
                   .eq("challenge_id", self.challenge_id)
                   .gt("trade_count", 0)
                   .execute())
            return len(res.data or [])
        except Exception:
            return 0

    # ── Factory methods ───────────────────────────────────────────────────────

    def create_challenge(
        self,
        firm_name:          str,
        phase:              str,
        account_size_usd:   float,
        start_date:         Optional[str] = None,
        **kwargs,
    ) -> Optional[int]:
        """
        Create a new challenge in the database.
        kwargs: any ChallengeRules fields (max_daily_loss_pct, profit_target_pct, etc.)
        Returns the new challenge id.
        """
        today = date.today().isoformat()
        row = {
            "account_id":          kwargs.get("account_id", 1),
            "firm_name":           firm_name,
            "phase":               phase,
            "account_size_usd":    account_size_usd,
            "starting_balance":    account_size_usd,
            "current_balance":     account_size_usd,
            "peak_balance":        account_size_usd,
            "start_date":          start_date or today,
            "max_daily_loss_pct":  kwargs.get("max_daily_loss_pct", 5.0),
            "max_total_loss_pct":  kwargs.get("max_total_loss_pct", 10.0),
            "profit_target_pct":   kwargs.get("profit_target_pct", 10.0),
            "min_trading_days":    kwargs.get("min_trading_days", 4),
            "max_trading_days":    kwargs.get("max_trading_days", 30),
            "max_trade_risk_pct":  kwargs.get("max_trade_risk_pct", 0.0),
            "max_lot_size":        kwargs.get("max_lot_size", 0.0),
            "consistency_pct":     kwargs.get("consistency_pct", 0.0),
            "trailing_drawdown":   kwargs.get("trailing_drawdown", False),
            "news_trading_ban":    kwargs.get("news_trading_ban", False),
            "overnight_hold_ban":  kwargs.get("overnight_hold_ban", False),
            "weekend_hold_ban":    kwargs.get("weekend_hold_ban", True),
            "trading_days_completed": 0,
            "created_at":          datetime.now(tz=timezone.utc).isoformat(),
            "updated_at":          datetime.now(tz=timezone.utc).isoformat(),
        }
        try:
            res = self._sb.table("prop_challenges").insert(row).execute()
            new_id = res.data[0]["id"] if res.data else None
            log.info("challenge_created", firm=firm_name, phase=phase, id=new_id,
                     size=account_size_usd)
            return new_id
        except Exception as e:
            log.error("challenge_create_error", error=str(e))
            return None

    # ── Fetch history ─────────────────────────────────────────────────────────

    def fetch_daily_history(self, limit: int = 30) -> list[dict]:
        """Fetch recent daily stats rows, newest first."""
        try:
            res = (self._sb.table("prop_daily_stats")
                   .select("*")
                   .eq("challenge_id", self.challenge_id)
                   .order("trade_date", desc=True)
                   .limit(limit)
                   .execute())
            return res.data or []
        except Exception as e:
            log.error("prop_daily_history_error", error=str(e))
            return []

    def fetch_recent_trades(self, limit: int = 50) -> list[dict]:
        """Fetch recent prop trades."""
        try:
            res = (self._sb.table("prop_trades")
                   .select("*")
                   .eq("challenge_id", self.challenge_id)
                   .order("recorded_at", desc=True)
                   .limit(limit)
                   .execute())
            return res.data or []
        except Exception as e:
            log.error("prop_trades_fetch_error", error=str(e))
            return []

    def fetch_violations(self) -> list[dict]:
        """Fetch all rule violations logged for this challenge."""
        try:
            res = (self._sb.table("prop_violations")
                   .select("*")
                   .eq("challenge_id", self.challenge_id)
                   .order("occurred_at", desc=True)
                   .execute())
            return res.data or []
        except Exception as e:
            log.error("prop_violations_fetch_error", error=str(e))
            return []


# ─── Preset factory helpers ────────────────────────────────────────────────────

# Common firm presets — pass as **FIRM_PRESETS["FTMO_100K"] to create_challenge()
FIRM_PRESETS: dict[str, dict] = {
    "FTMO_100K": {
        "firm_name":          "FTMO",
        "account_size_usd":   100_000,
        "max_daily_loss_pct": 5.0,
        "max_total_loss_pct": 10.0,
        "profit_target_pct":  10.0,
        "min_trading_days":   4,
        "max_trading_days":   30,
        "trailing_drawdown":  False,
        "weekend_hold_ban":   True,
    },
    "FTMO_200K": {
        "firm_name":          "FTMO",
        "account_size_usd":   200_000,
        "max_daily_loss_pct": 5.0,
        "max_total_loss_pct": 10.0,
        "profit_target_pct":  10.0,
        "min_trading_days":   4,
        "max_trading_days":   30,
        "trailing_drawdown":  False,
        "weekend_hold_ban":   True,
    },
    "THE5ERS_100K": {
        "firm_name":          "The5ers",
        "account_size_usd":   100_000,
        "max_daily_loss_pct": 4.0,
        "max_total_loss_pct": 4.0,
        "profit_target_pct":  8.0,
        "min_trading_days":   0,
        "max_trading_days":   60,
        "trailing_drawdown":  True,   # The5ers uses trailing DD
        "weekend_hold_ban":   False,
    },
    "APEX_50K": {
        "firm_name":          "Apex Trader Funding",
        "account_size_usd":   50_000,
        "max_daily_loss_pct": 0.0,    # Apex: no daily limit, only trailing DD
        "max_total_loss_pct": 2.5,    # 1250 trailing DD on 50K
        "profit_target_pct":  6.0,    # 3000 profit target on 50K
        "min_trading_days":   7,
        "max_trading_days":   0,      # No time limit
        "trailing_drawdown":  True,
        "weekend_hold_ban":   True,
    },
    "FUNDEDNEXT_100K": {
        "firm_name":          "FundedNext",
        "account_size_usd":   100_000,
        "max_daily_loss_pct": 5.0,
        "max_total_loss_pct": 10.0,
        "profit_target_pct":  10.0,   # Phase 1
        "min_trading_days":   5,
        "max_trading_days":   30,
        "trailing_drawdown":  False,
        "weekend_hold_ban":   True,
        "consistency_pct":    30.0,   # No single day > 30% of total profit
    },
}
