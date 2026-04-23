"""
PropPilot AI — Risk Engine
Pre-trade compliance layer. Runs before every execution decision.

Checks (in order):
  1. Bot paused / kill-switch active
  2. Session allowed
  3. Confidence ≥ threshold
  4. Daily loss limit
  5. Max open positions
  6. Duplicate symbol
  7. Correlation guard
  8. Min risk/reward
  9. Lot size calculation

All checks are deterministic: given account state + signal → PASS or REJECT(reason).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import structlog

import config

log = structlog.get_logger("risk_engine")

# ─── Result types ─────────────────────────────────────────────────────────────

@dataclass
class RiskCheck:
    passed:     bool
    reason:     str
    action:     str    # REJECT_* code or "PASS"
    lot_size:   Optional[float] = None
    risk_usd:   Optional[float] = None

    def __bool__(self) -> bool:
        return self.passed


@dataclass
class PropFirmRules:
    """Rules for a prop firm challenge / funded account."""
    firm_name:          str   = "Custom"
    daily_loss_pct:     float = 5.0   # FTMO standard = 5%, FundedNext = 4%
    max_drawdown_pct:   float = 10.0
    min_rr:             float = 1.5   # Minimum risk/reward ratio
    news_block_minutes: int   = 30    # Block trading 30 min before/after HIGH news
    weekend_hold:       bool  = False  # Standard accounts: no weekend holding
    max_daily_trades:   int   = 10
    allowed_sessions:   list[str] = field(default_factory=lambda: [
        "London", "Overlap", "NewYork"
    ])


# ─── Default prop rules ───────────────────────────────────────────────────────

PROP_PROFILES: dict[str, PropFirmRules] = {
    "ftmo_standard": PropFirmRules(
        firm_name="FTMO Standard",
        daily_loss_pct=5.0,
        max_drawdown_pct=10.0,
        min_rr=1.5,
        news_block_minutes=30,
        weekend_hold=False,
        allowed_sessions=["London", "Overlap", "NewYork"],
    ),
    "ftmo_swing": PropFirmRules(
        firm_name="FTMO Swing",
        daily_loss_pct=5.0,
        max_drawdown_pct=10.0,
        min_rr=1.5,
        news_block_minutes=0,
        weekend_hold=True,
        allowed_sessions=["London", "Overlap", "NewYork", "Asia"],
    ),
    "fundednext_standard": PropFirmRules(
        firm_name="FundedNext Standard",
        daily_loss_pct=4.0,
        max_drawdown_pct=8.0,
        min_rr=1.5,
        news_block_minutes=30,
        weekend_hold=False,
        allowed_sessions=["London", "Overlap", "NewYork"],
    ),
    "topstep": PropFirmRules(
        firm_name="TopStep",
        daily_loss_pct=4.0,
        max_drawdown_pct=6.0,
        min_rr=1.5,
        news_block_minutes=30,
        weekend_hold=False,
        allowed_sessions=["London", "Overlap", "NewYork"],
    ),
    "paper": PropFirmRules(
        firm_name="Paper (PropPilot defaults)",
        daily_loss_pct=2.0,
        max_drawdown_pct=10.0,
        min_rr=1.5,
        news_block_minutes=0,
        weekend_hold=True,
        allowed_sessions=["London", "Frankfurt", "Overlap", "NewYork", "Asia"],
    ),
}


# ─── RiskEngine ──────────────────────────────────────────────────────────────

class RiskEngine:
    """
    Stateless risk checker — pass account/settings dicts from Supabase
    and a SignalResult, get back a RiskCheck.
    """

    def __init__(self, prop_profile: str = "paper"):
        self.prop = PROP_PROFILES.get(prop_profile, PROP_PROFILES["paper"])
        log.info("risk_engine_init", firm=self.prop.firm_name)

    def check(
        self,
        signal,                   # SignalResult from signal_engine.py
        account: dict,            # paper_account row from Supabase
        settings: dict,           # bot_settings row from Supabase
        open_positions: list[dict],  # paper_positions with status OPEN/TP1_HIT
    ) -> RiskCheck:
        """Run all pre-trade checks. Returns first failure or PASS with lot size."""

        symbol    = signal.symbol
        direction = signal.direction
        balance   = float(account.get("balance", 100_000))

        # 1. Bot paused
        if settings.get("is_paused"):
            return RiskCheck(False, "Bot is manually paused", "REJECT_PAUSED")

        # 2. Kill-switch
        if account.get("kill_switch_active"):
            reason = account.get("kill_switch_reason", "daily loss limit")
            return RiskCheck(False, f"Kill-switch active: {reason}", "REJECT_KILL_SWITCH")

        # 3. Session allowed
        session = signal.session_name
        allowed = settings.get("allowed_sessions") or self.prop.allowed_sessions
        # Normalize allowed sessions (Supabase stores them as snake_case sometimes)
        allowed_norm = [s.lower().replace(" ", "_") for s in allowed]
        session_norm = session.lower().replace(" ", "_")
        if session_norm not in allowed_norm and session not in allowed:
            return RiskCheck(False, f"Session {session} not in allowed sessions {allowed}",
                             "REJECT_SESSION")

        # 4. Confidence
        threshold = int(settings.get("confidence_threshold", 70))
        if signal.confidence < threshold:
            return RiskCheck(False,
                             f"Confidence {signal.confidence}% < threshold {threshold}%",
                             "REJECT_CONFIDENCE")

        # 5. Daily loss limit
        daily_pnl    = float(account.get("daily_pnl_usd", 0))
        loss_limit_pct = float(settings.get("daily_loss_limit_pct",
                                            self.prop.daily_loss_pct))
        loss_limit_usd = balance * loss_limit_pct / 100
        if daily_pnl < 0 and abs(daily_pnl) >= loss_limit_usd:
            return RiskCheck(False,
                             f"Daily loss limit hit: -${abs(daily_pnl):.2f} "
                             f"≥ ${loss_limit_usd:.2f} ({loss_limit_pct}%)",
                             "REJECT_DAILY_LOSS")

        # 6. Max drawdown
        peak_balance = float(account.get("peak_balance", balance))
        current_dd_pct = (peak_balance - balance) / peak_balance * 100 if peak_balance else 0
        if current_dd_pct >= self.prop.max_drawdown_pct:
            return RiskCheck(False,
                             f"Max drawdown hit: {current_dd_pct:.1f}% "
                             f"≥ {self.prop.max_drawdown_pct}%",
                             "REJECT_DRAWDOWN")

        # 7. Max open positions
        max_pos = int(settings.get("max_open_positions", 3))
        if len(open_positions) >= max_pos:
            return RiskCheck(False,
                             f"Max open positions reached ({len(open_positions)}/{max_pos})",
                             "REJECT_MAX_POS")

        # 8. Duplicate symbol
        for pos in open_positions:
            if pos.get("symbol") == symbol:
                return RiskCheck(False,
                                 f"Position already open for {symbol} ({pos.get('direction')})",
                                 "REJECT_DUPLICATE")

        # 9. Correlation guard
        if settings.get("correlation_guard", True):
            result = self._check_correlation(symbol, direction, open_positions)
            if result:
                return result

        # 10. Risk/reward
        if signal.risk_reward is not None and signal.risk_reward < self.prop.min_rr:
            return RiskCheck(False,
                             f"R/R {signal.risk_reward:.2f} < minimum {self.prop.min_rr}",
                             "REJECT_RR")

        # 11. Lot size calculation
        risk_pct  = float(settings.get("risk_pct", 1.0))
        risk_usd  = balance * risk_pct / 100
        lot_size, calc_info = self._calc_lot(
            symbol=symbol,
            entry_price=signal.entry_price,
            sl_price=signal.sl_price,
            risk_usd=risk_usd,
        )

        log.info("risk_check_passed", symbol=symbol, direction=direction,
                 lot_size=lot_size, risk_usd=risk_usd, confidence=signal.confidence)

        return RiskCheck(
            passed=True,
            reason="All checks passed",
            action="PASS",
            lot_size=lot_size,
            risk_usd=round(risk_usd, 2),
        )

    # ── Correlation guard ─────────────────────────────────────────────────────

    def _check_correlation(self, symbol: str, direction: Optional[str],
                            open_positions: list[dict]) -> Optional[RiskCheck]:
        my_group = config.CORRELATION_GROUP.get(symbol)
        if not my_group or not direction:
            return None
        for pos in open_positions:
            pos_sym   = pos.get("symbol", "")
            pos_dir   = pos.get("direction", "")
            pos_group = config.CORRELATION_GROUP.get(pos_sym)
            if pos_group and pos_group == my_group and pos_dir == direction:
                return RiskCheck(
                    False,
                    f"Correlated exposure blocked: already {pos_dir} {pos_sym} "
                    f"(group: {my_group})",
                    "REJECT_CORRELATION",
                )
        return None

    # ── Lot size calculation ──────────────────────────────────────────────────

    def _calc_lot(self, symbol: str, entry_price: Optional[float],
                  sl_price: Optional[float], risk_usd: float) -> tuple[float, dict]:
        """
        lot = risk_usd / (sl_distance × contract_size)
        Minimum lot: 0.01, rounded to 2 decimal places.
        """
        contract_sz = config.CONTRACT_SIZE.get(symbol, 100_000)

        if entry_price is None or sl_price is None:
            lot = 0.01
            return lot, {"reason": "no_levels", "lot": lot}

        sl_dist = abs(entry_price - sl_price)
        if sl_dist <= 0:
            lot = 0.01
            return lot, {"reason": "zero_sl_dist", "lot": lot}

        lot_raw = risk_usd / (sl_dist * contract_sz)
        lot     = max(0.01, round(lot_raw * 100) / 100)

        info = {
            "entry": entry_price, "sl": sl_price,
            "sl_dist": sl_dist, "contract_sz": contract_sz,
            "risk_usd": risk_usd, "lot_raw": lot_raw, "lot": lot,
        }
        log.debug("lot_calc", symbol=symbol, **info)
        return lot, info

    # ── Post-close update helpers ──────────────────────────────────────────────

    @staticmethod
    def should_trigger_kill_switch(account: dict, settings: dict) -> bool:
        """True if daily loss limit has been breached."""
        balance       = float(account.get("balance", 100_000))
        daily_pnl     = float(account.get("daily_pnl_usd", 0))
        loss_limit_pct = float(settings.get("daily_loss_limit_pct", 2.0))
        loss_limit_usd = balance * loss_limit_pct / 100
        return daily_pnl < 0 and abs(daily_pnl) >= loss_limit_usd

    @staticmethod
    def calc_position_size_info(symbol: str, balance: float, risk_pct: float,
                                 entry: float, sl: float) -> dict:
        """Utility: compute lot size without full check pipeline."""
        contract_sz = config.CONTRACT_SIZE.get(symbol, 100_000)
        risk_usd    = balance * risk_pct / 100
        sl_dist     = abs(entry - sl)
        lot_raw     = risk_usd / (sl_dist * contract_sz) if sl_dist > 0 else 0.01
        lot         = max(0.01, round(lot_raw * 100) / 100)
        size_usd    = lot * contract_sz * entry
        return {
            "lot_size":    lot,
            "risk_usd":    round(risk_usd, 2),
            "size_usd":    round(size_usd, 2),
            "sl_dist":     sl_dist,
            "contract_sz": contract_sz,
        }
