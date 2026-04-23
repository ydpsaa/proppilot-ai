"""
PropPilot AI — Configuration & Constants
All settings loaded from environment variables (.env file on VPS).
"""

from __future__ import annotations
import os
import logging
from dataclasses import dataclass, field
from typing import Optional
from dotenv import load_dotenv
import structlog

load_dotenv()

# ─── Environment ──────────────────────────────────────────────────────────────

SUPABASE_URL      = os.environ["SUPABASE_URL"]
SUPABASE_KEY      = os.environ["SUPABASE_SERVICE_ROLE_KEY"]  # service role for daemon
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")   # legacy, not used
GROQ_API_KEY      = os.getenv("GROQ_API_KEY", "")        # FREE at console.groq.com
TWELVE_DATA_KEY   = os.getenv("TWELVE_DATA_KEY", "")
BINANCE_API_KEY   = os.getenv("BINANCE_API_KEY", "")
BINANCE_SECRET    = os.getenv("BINANCE_SECRET", "")
ALPACA_API_KEY    = os.getenv("ALPACA_API_KEY", "")
ALPACA_SECRET     = os.getenv("ALPACA_SECRET", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID", "")

# Execution mode: "paper" | "live"
EXECUTION_MODE = os.getenv("EXECUTION_MODE", "paper").lower()

# Log level
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

# ─── Instrument Constants ─────────────────────────────────────────────────────

# Contract size: how many units per 1 lot
CONTRACT_SIZE: dict[str, float] = {
    "XAU/USD":  100.0,     # 1 lot = 100 troy oz
    "NAS100":    20.0,     # 1 lot ≈ 20 index units
    "EUR/USD": 100_000.0,
    "GBP/USD": 100_000.0,
    "USD/JPY": 100_000.0,
    "GBP/JPY": 100_000.0,
    "EUR/JPY": 100_000.0,
    "BTC/USD":    1.0,
    "ETH/USD":    1.0,
}

# Pip value (one pip in price terms)
PIP_SIZE: dict[str, float] = {
    "XAU/USD":  0.01,
    "NAS100":   1.0,
    "EUR/USD":  0.0001,
    "GBP/USD":  0.0001,
    "USD/JPY":  0.01,
    "GBP/JPY":  0.01,
    "EUR/JPY":  0.01,
    "BTC/USD":  1.0,
    "ETH/USD":  0.1,
}

# Data source per instrument
DATA_SOURCE: dict[str, str] = {
    "XAU/USD":  "twelvedata",
    "NAS100":   "alpaca",
    "EUR/USD":  "twelvedata",
    "GBP/USD":  "twelvedata",
    "USD/JPY":  "twelvedata",
    "GBP/JPY":  "twelvedata",
    "EUR/JPY":  "twelvedata",
    "BTC/USD":  "binance",
    "ETH/USD":  "binance",
}

# Twelve Data symbol mapping
TWELVE_DATA_SYMBOL: dict[str, str] = {
    "XAU/USD":  "XAU/USD",
    "EUR/USD":  "EUR/USD",
    "GBP/USD":  "GBP/USD",
    "USD/JPY":  "USD/JPY",
    "GBP/JPY":  "GBP/JPY",
    "EUR/JPY":  "EUR/JPY",
    "NAS100":   "NDX",
}

# Binance symbol mapping
BINANCE_SYMBOL: dict[str, str] = {
    "BTC/USD": "BTCUSDT",
    "ETH/USD": "ETHUSDT",
}

# Alpaca symbol mapping
ALPACA_SYMBOL: dict[str, str] = {
    "NAS100": "QQQ",   # NAS100 proxy via QQQ ETF
}

# Correlation groups (same group + same direction = blocked)
CORRELATION_GROUP: dict[str, str] = {
    "XAU/USD": "USD_BEAR",
    "EUR/USD": "USD_BEAR",
    "GBP/USD": "USD_BEAR",
    "NAS100":  "RISK_ON",
    "BTC/USD": "RISK_ON",
    "ETH/USD": "RISK_ON",
    "USD/JPY": "USD_BULL",
    "GBP/JPY": "JPY_BEAR",
    "EUR/JPY": "JPY_BEAR",
}

# Timeframes to maintain (in minutes)
TIMEFRAMES = [1, 5, 15, 60, 240, 1440]   # M1, M5, M15, H1, H4, D1

# Trading session schedule (UTC)
SESSIONS: list[dict] = [
    {"name": "london_open",  "hour": 7,  "minute": 0,  "weekdays": range(0, 5)},
    {"name": "ny_premarket", "hour": 8,  "minute": 30, "weekdays": range(0, 5)},
    {"name": "ny_open",      "hour": 13, "minute": 0,  "weekdays": range(0, 5)},
    {"name": "ny_mid",       "hour": 16, "minute": 0,  "weekdays": range(0, 5)},
    {"name": "day_end",      "hour": 20, "minute": 0,  "weekdays": range(0, 5)},
]

# Default active symbols to trade
DEFAULT_SYMBOLS = ["XAU/USD", "EUR/USD", "GBP/USD", "NAS100", "BTC/USD"]

# Candle history depth to load on startup (bars of M1)
HISTORY_BARS_M1 = 1000   # ~16.6 hours of M1

# ─── Logging ──────────────────────────────────────────────────────────────────

def setup_logging() -> structlog.BoundLogger:
    """Configure structlog with JSON output for VPS logging."""
    log_level = getattr(logging, LOG_LEVEL, logging.INFO)

    logging.basicConfig(
        format="%(message)s",
        level=log_level,
    )

    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    return structlog.get_logger("proppilot")


# ─── Supabase client (singleton) ──────────────────────────────────────────────

_sb_client = None

def get_supabase():
    """Return the shared Supabase client (lazy init)."""
    global _sb_client
    if _sb_client is None:
        from supabase import create_client
        _sb_client = create_client(SUPABASE_URL, SUPABASE_KEY)
    return _sb_client


# ─── Edge function URLs ───────────────────────────────────────────────────────

EDGE_BASE = f"{SUPABASE_URL}/functions/v1"
EDGE_EXECUTE_TRADE   = f"{EDGE_BASE}/execute-paper-trade"
EDGE_UPDATE_POSITIONS = f"{EDGE_BASE}/update-paper-positions"
EDGE_AUTO_ANALYZE    = f"{EDGE_BASE}/auto-analyze"

EDGE_HEADERS = {
    "apikey":        SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type":  "application/json",
}
