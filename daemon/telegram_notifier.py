"""
PropPilot AI — Telegram Notifier
Real-time trade alerts, daily P&L reports, and morning briefings via Telegram Bot API.

Setup:
  1. Create bot via @BotFather → get TELEGRAM_BOT_TOKEN
  2. Get your chat ID (message @userinfobot) → TELEGRAM_CHAT_ID
  3. Set both in daemon/.env

Alert types:
  signal_alert(signal)         — new LONG_NOW / SHORT_NOW signal
  trade_opened(result, signal) — trade opened successfully
  trade_closed(position)       — TP1 / TP2 / SL hit
  kill_switch_alert(reason)    — daily loss limit breached
  daily_report(account, stats) — end-of-day P&L summary
  morning_briefing(events, account) — pre-session upcoming news + account state
  news_block_alert(symbol, reason)  — trade skipped due to news

All sends are non-blocking (fire-and-forget via thread).
Falls back silently if token is missing.

Usage:
    notifier = TelegramNotifier()
    notifier.signal_alert(signal)
    notifier.trade_opened(trade_result, signal)
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Optional

import structlog

import config

log = structlog.get_logger("telegram")

# Emoji legend
_E = {
    "long":    "📈",
    "short":   "📉",
    "tp1":     "✅",
    "tp2":     "🎯",
    "sl":      "❌",
    "kill":    "🚨",
    "news":    "📰",
    "morning": "🌅",
    "report":  "📊",
    "wait":    "⏳",
    "info":    "ℹ️",
    "gold":    "🥇",
    "btc":     "₿",
}

# Compact symbol display
_SYM = {
    "XAU/USD": f"{_E['gold']} XAU",
    "BTC/USD": f"{_E['btc']} BTC",
    "NAS100":  "📈 NAS",
    "EUR/USD": "💶 EUR",
    "GBP/USD": "💷 GBP",
    "USD/JPY": "💴 JPY",
    "GBP/JPY": "💷💴 GBJ",
    "EUR/JPY": "💶💴 EJ",
    "ETH/USD": "Ξ ETH",
}


class TelegramNotifier:
    """
    Telegram alert dispatcher.
    All sends run in background threads — never blocks the main event loop.
    """

    API_BASE = "https://api.telegram.org/bot{token}/sendMessage"

    def __init__(self) -> None:
        self._token   = config.TELEGRAM_BOT_TOKEN
        self._chat_id = config.TELEGRAM_CHAT_ID
        self._enabled = bool(self._token and self._chat_id and
                             not self._token.startswith("ВСТАВЬ"))
        if self._enabled:
            log.info("telegram_notifier_ready", chat_id=self._chat_id)
        else:
            log.warning("telegram_notifier_disabled",
                        msg="Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env to enable")

    # ── Public alert methods ──────────────────────────────────────────────────

    def signal_alert(self, signal) -> None:
        """New LONG_NOW / SHORT_NOW signal detected."""
        if not self._enabled:
            return
        direction = signal.direction or "?"
        emoji     = _E["long"] if direction == "LONG" else _E["short"]
        sym       = _SYM.get(signal.symbol, signal.symbol)
        rr_str    = f"{signal.risk_reward:.1f}R" if signal.risk_reward else "—"

        confluence_str = ""
        if signal.confluence and signal.confluence.rsi:
            confluence_str = f"\nRSI: {signal.confluence.rsi:.0f}"
            if signal.confluence.reasons:
                confluence_str += f"  |  {', '.join(signal.confluence.reasons[:3])}"

        sweep_str = ""
        if signal.sweep:
            sweep_str = f"\nSweep Q: {signal.sweep.quality:.2f} ({signal.sweep.level.label})"

        msg = (
            f"{emoji} *{direction}* — {sym}\n"
            f"Confidence: *{signal.confidence}%*\n"
            f"Session: {signal.session_name}  |  HTF: {signal.htf_trend}\n"
            f"Entry: `{signal.entry_price}`  |  SL: `{signal.sl_price}`\n"
            f"TP1: `{signal.tp1_price}`  |  TP2: `{signal.tp2_price}`\n"
            f"R/R: *{rr_str}*{sweep_str}{confluence_str}\n"
            f"🔖 {' · '.join(signal.reasoning_codes[:4])}"
        )
        self._send(msg)

    def trade_opened(self, result, signal=None) -> None:
        """Trade successfully opened."""
        if not self._enabled:
            return
        direction = result.direction or "?"
        emoji     = _E["long"] if direction == "LONG" else _E["short"]
        sym       = _SYM.get(result.symbol, result.symbol)
        conf_str  = f"  conf={signal.confidence}%" if signal else ""

        msg = (
            f"✅ *Trade Opened*  {emoji} {sym}\n"
            f"Direction: *{direction}*{conf_str}\n"
            f"Lot: `{result.lot_size}`  |  Risk: `${result.risk_usd:.2f}`\n"
            f"Entry: `{result.entry_price}`\n"
            f"SL: `{result.sl_price}`  |  TP1: `{result.tp1_price}`"
        )
        self._send(msg)

    def trade_closed(self, position: dict) -> None:
        """Position closed — TP1 / TP2 / SL / manual."""
        if not self._enabled:
            return
        status  = position.get("status", "CLOSED")
        pnl     = position.get("pnl_usd", 0) or 0
        pnl_r   = position.get("pnl_r", 0) or 0
        sym     = _SYM.get(position.get("symbol", ""), position.get("symbol", ""))
        direction = position.get("direction", "")

        if status == "TP2_HIT":
            emoji = _E["tp2"]
        elif status == "TP1_HIT":
            emoji = _E["tp1"]
        elif status == "SL_HIT":
            emoji = _E["sl"]
        else:
            emoji = _E["info"]

        pnl_sign = "+" if pnl >= 0 else ""
        msg = (
            f"{emoji} *{status}* — {sym} {direction}\n"
            f"P&L: *{pnl_sign}${pnl:.2f}*  ({pnl_sign}{pnl_r:.2f}R)\n"
            f"Close: `{position.get('close_price', '—')}`  |  "
            f"Entry: `{position.get('entry_price', '—')}`"
        )
        self._send(msg)

    def kill_switch_alert(self, reason: str, account: dict) -> None:
        """Daily loss limit breached — kill switch activated."""
        if not self._enabled:
            return
        balance  = account.get("balance", 0)
        daily_pnl = account.get("daily_pnl_usd", 0) or 0
        msg = (
            f"{_E['kill']} *KILL SWITCH ACTIVATED*\n"
            f"Reason: {reason}\n"
            f"Daily P&L: `${daily_pnl:+.2f}`\n"
            f"Balance: `${balance:,.2f}`\n"
            f"Bot paused until next day reset."
        )
        self._send(msg, parse_mode="Markdown")

    def daily_report(self, account: dict, stats: dict) -> None:
        """End-of-day P&L and performance summary."""
        if not self._enabled:
            return
        balance   = account.get("balance", 100_000)
        daily_pnl = account.get("daily_pnl_usd", 0) or 0
        win_rate  = account.get("win_rate_pct") or 0
        total_t   = account.get("total_trades", 0)
        peak      = account.get("peak_balance", balance)
        dd        = (peak - balance) / peak * 100 if peak else 0
        pnl_sign  = "+" if daily_pnl >= 0 else ""

        best_sym  = stats.get("best_symbol", "—")
        pf        = stats.get("profit_factor") or "—"

        msg = (
            f"{_E['report']} *Daily P&L Report*\n"
            f"Date: {datetime.now(tz=timezone.utc).strftime('%Y-%m-%d')}\n\n"
            f"P&L today: *{pnl_sign}${daily_pnl:.2f}*\n"
            f"Balance: `${balance:,.2f}`  |  Peak: `${peak:,.2f}`\n"
            f"Drawdown: `{dd:.1f}%`\n\n"
            f"Win rate: `{win_rate:.1f}%`  |  Total trades: `{total_t}`\n"
            f"Profit factor: `{pf}`  |  Best symbol: `{best_sym}`"
        )
        self._send(msg)

    def morning_briefing(
        self, events: list, account: dict, session: str = "London"
    ) -> None:
        """Pre-session briefing: upcoming news + account state."""
        if not self._enabled:
            return
        balance   = account.get("balance", 100_000)
        daily_pnl = account.get("daily_pnl_usd", 0) or 0
        open_pos  = account.get("open_count", 0)

        news_lines = ""
        if events:
            lines = []
            for ev in events[:5]:
                t = ev.event_utc.strftime("%H:%M")
                lines.append(f"  `{t}` {ev.currency} — {ev.title}")
            news_lines = "\n" + "\n".join(lines)
        else:
            news_lines = "\n  No high-impact news today 🟢"

        msg = (
            f"{_E['morning']} *{session} Session Briefing*\n"
            f"{datetime.now(tz=timezone.utc).strftime('%Y-%m-%d %H:%M')} UTC\n\n"
            f"Balance: `${balance:,.2f}`  |  Daily P&L: `${daily_pnl:+.2f}`\n"
            f"Open positions: `{open_pos}`\n\n"
            f"{_E['news']} *High-Impact News Today:*{news_lines}"
        )
        self._send(msg)

    def news_block_alert(self, symbol: str, reason: str) -> None:
        """Trade opportunity skipped due to news window."""
        if not self._enabled:
            return
        sym = _SYM.get(symbol, symbol)
        msg = f"{_E['news']} *News Block* — {sym}\n{reason}"
        self._send(msg)

    def wait_signal_alert(self, signal) -> None:
        """WAIT_LONG / WAIT_SHORT — setup forming but not ready."""
        if not self._enabled:
            return
        direction = "LONG" if "LONG" in signal.verdict else "SHORT"
        sym = _SYM.get(signal.symbol, signal.symbol)
        msg = (
            f"{_E['wait']} *Setup Forming* — {sym}\n"
            f"Direction: {direction}  |  Confidence: {signal.confidence}%\n"
            f"Missing: need higher confidence + MSS confirmation"
        )
        self._send(msg)

    def error_alert(self, error: str, context: str = "") -> None:
        """Critical error notification."""
        if not self._enabled:
            return
        msg = f"⚠️ *Bot Error*\n{context}\n`{error[:300]}`"
        self._send(msg)

    def custom(self, text: str) -> None:
        """Send any arbitrary message."""
        if self._enabled:
            self._send(text)

    # ── Internal ──────────────────────────────────────────────────────────────

    def _send(self, text: str, parse_mode: str = "Markdown") -> None:
        """Fire-and-forget send in a daemon thread."""
        t = threading.Thread(
            target=self._send_sync,
            args=(text, parse_mode),
            daemon=True,
            name="tg-send",
        )
        t.start()

    def _send_sync(self, text: str, parse_mode: str) -> None:
        """Blocking send (runs in background thread)."""
        try:
            import httpx
            url = self.API_BASE.format(token=self._token)
            payload = {
                "chat_id":    self._chat_id,
                "text":       text,
                "parse_mode": parse_mode,
                "disable_web_page_preview": True,
            }
            resp = httpx.post(url, json=payload, timeout=10)
            if not resp.is_success:
                log.warning("telegram_send_failed",
                            status=resp.status_code, text=text[:60])
        except ImportError:
            log.debug("telegram_httpx_missing", msg="pip install httpx")
        except Exception as e:
            log.warning("telegram_send_error", error=str(e))
