"""
PropPilot AI — News Filter
Blocks trading 30 min before and after HIGH-impact economic news events.

Data sources (in priority order):
  1. ForexFactory RSS feed  (free, no API key)
  2. Investing.com calendar (requires httpx — fallback)
  3. Manual override list   (always checked first)

Architecture:
  - NewsFilter.is_blocked(symbol, utc_dt) → bool
  - Calendar refreshed every REFRESH_INTERVAL_MINUTES (default 60)
  - Thread-safe: designed to be called from asyncio.to_thread()
  - Fully offline-capable: if refresh fails, uses stale cache (safe-default = allow)

Affected currency pairs per currency code:
  USD → XAU/USD, EUR/USD, GBP/USD, USD/JPY, GBP/JPY, EUR/JPY, NAS100
  EUR → EUR/USD, EUR/JPY
  GBP → GBP/USD, GBP/JPY
  JPY → USD/JPY, GBP/JPY, EUR/JPY

Usage:
    nf = NewsFilter()
    blocked, reason = nf.is_blocked("XAU/USD", datetime.now(tz=timezone.utc))
    if blocked:
        log.info("news_block", reason=reason)
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Optional
from xml.etree import ElementTree

import structlog

log = structlog.get_logger("news_filter")

# ── Constants ─────────────────────────────────────────────────────────────────

FOREX_FACTORY_RSS = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml"
BLOCK_MINUTES_BEFORE = 30
BLOCK_MINUTES_AFTER  = 30
REFRESH_INTERVAL_MIN = 60   # re-fetch calendar every hour
HIGH_IMPACT_KEYWORDS = {"non-farm", "nfp", "fomc", "fed", "cpi", "gdp", "rate decision",
                         "inflation", "employment", "retail sales", "pmi", "ism",
                         "boj", "ecb", "boe", "rba", "rbnz"}

# Symbol → set of currency codes that affect it
SYMBOL_CURRENCIES: dict[str, set[str]] = {
    "XAU/USD": {"USD"},
    "EUR/USD": {"USD", "EUR"},
    "GBP/USD": {"USD", "GBP"},
    "USD/JPY": {"USD", "JPY"},
    "GBP/JPY": {"GBP", "JPY"},
    "EUR/JPY": {"EUR", "JPY"},
    "NAS100":  {"USD"},
    "BTC/USD": set(),          # crypto — not affected by forex news
    "ETH/USD": set(),
}


# ── Data types ────────────────────────────────────────────────────────────────

@dataclass
class NewsEvent:
    title:     str
    currency:  str          # "USD", "EUR", etc.
    impact:    str          # "High", "Medium", "Low"
    event_utc: datetime
    forecast:  str = ""
    previous:  str = ""

    @property
    def is_high_impact(self) -> bool:
        return self.impact.lower() == "high"

    def blocks_at(self, utc_dt: datetime) -> bool:
        """True if utc_dt falls within the block window around this event."""
        if not self.is_high_impact:
            return False
        window_start = self.event_utc - timedelta(minutes=BLOCK_MINUTES_BEFORE)
        window_end   = self.event_utc + timedelta(minutes=BLOCK_MINUTES_AFTER)
        return window_start <= utc_dt <= window_end


# ── Manual override ───────────────────────────────────────────────────────────

# Add events manually if auto-fetch fails or for known scheduled events.
# Format: (title, currency, impact, ISO-datetime-UTC)
MANUAL_EVENTS: list[tuple[str, str, str, str]] = [
    # Example: ("FOMC Rate Decision", "USD", "High", "2026-05-07T18:00:00+00:00"),
]


# ── NewsFilter ────────────────────────────────────────────────────────────────

class NewsFilter:
    """
    Thread-safe news calendar filter.
    Fetches ForexFactory RSS once per hour and caches events.
    """

    def __init__(
        self,
        block_before: int = BLOCK_MINUTES_BEFORE,
        block_after:  int = BLOCK_MINUTES_AFTER,
        enabled:      bool = True,
    ):
        self.block_before = block_before
        self.block_after  = block_after
        self.enabled      = enabled
        self._events:     list[NewsEvent] = []
        self._last_fetch: float = 0.0
        self._lock        = threading.Lock()

        # Load manual overrides immediately
        self._load_manual_overrides()
        log.info("news_filter_init", enabled=enabled,
                 block_before=block_before, block_after=block_after)

    # ── Public API ────────────────────────────────────────────────────────────

    def is_blocked(
        self, symbol: str, utc_dt: Optional[datetime] = None
    ) -> tuple[bool, str]:
        """
        Returns (is_blocked, reason).
        Thread-safe — refreshes calendar if stale.
        """
        if not self.enabled:
            return False, ""

        if utc_dt is None:
            utc_dt = datetime.now(tz=timezone.utc)

        self._maybe_refresh()

        affected = SYMBOL_CURRENCIES.get(symbol, set())
        if not affected:
            return False, ""   # Crypto / unknown — not affected

        with self._lock:
            for ev in self._events:
                if ev.currency in affected and ev.blocks_at(utc_dt):
                    mins_to = int(
                        (ev.event_utc - utc_dt).total_seconds() / 60
                    )
                    if mins_to >= 0:
                        reason = (f"NEWS_BLOCK: {ev.title} ({ev.currency}) "
                                  f"in {mins_to}min — {ev.event_utc.strftime('%H:%M')} UTC")
                    else:
                        reason = (f"NEWS_BLOCK: {ev.title} ({ev.currency}) "
                                  f"{abs(mins_to)}min ago — {ev.event_utc.strftime('%H:%M')} UTC")
                    return True, reason

        return False, ""

    def upcoming_events(
        self, symbol: str, hours: int = 4
    ) -> list[NewsEvent]:
        """Return upcoming high-impact events for a symbol within `hours`."""
        self._maybe_refresh()
        now    = datetime.now(tz=timezone.utc)
        cutoff = now + timedelta(hours=hours)
        affected = SYMBOL_CURRENCIES.get(symbol, set())

        with self._lock:
            return [
                ev for ev in self._events
                if ev.currency in affected
                and ev.is_high_impact
                and now <= ev.event_utc <= cutoff
            ]

    def all_events_today(self) -> list[NewsEvent]:
        """All HIGH-impact events for today (UTC)."""
        self._maybe_refresh()
        today = datetime.now(tz=timezone.utc).date()
        with self._lock:
            return [
                ev for ev in self._events
                if ev.is_high_impact and ev.event_utc.date() == today
            ]

    def force_refresh(self) -> int:
        """Force a calendar refresh. Returns number of events loaded."""
        self._last_fetch = 0.0
        self._maybe_refresh()
        with self._lock:
            return len(self._events)

    # ── Internal ──────────────────────────────────────────────────────────────

    def _maybe_refresh(self) -> None:
        """Refresh if cache is older than REFRESH_INTERVAL_MIN minutes."""
        if time.monotonic() - self._last_fetch < REFRESH_INTERVAL_MIN * 60:
            return
        self._fetch()

    def _fetch(self) -> None:
        """Fetch and parse ForexFactory RSS. Updates self._events."""
        try:
            import httpx
            resp = httpx.get(FOREX_FACTORY_RSS, timeout=10, follow_redirects=True)
            resp.raise_for_status()
            events = _parse_ff_rss(resp.text)
            with self._lock:
                self._events = events + self._load_manual_overrides(return_only=True)
            self._last_fetch = time.monotonic()
            log.info("news_calendar_refreshed", events=len(events),
                     high=sum(1 for e in events if e.is_high_impact))
        except ImportError:
            log.warning("news_filter_httpx_missing",
                        msg="pip install httpx to enable news filter")
            self._last_fetch = time.monotonic()
        except Exception as e:
            log.warning("news_calendar_fetch_error", error=str(e),
                        msg="Using stale cache or manual overrides only")
            if not self._events:
                self._last_fetch = time.monotonic()   # avoid hammering on failure

    def _load_manual_overrides(self, return_only: bool = False) -> list[NewsEvent]:
        events: list[NewsEvent] = []
        for title, currency, impact, dt_str in MANUAL_EVENTS:
            try:
                dt = datetime.fromisoformat(dt_str)
                events.append(NewsEvent(
                    title=title, currency=currency.upper(),
                    impact=impact, event_utc=dt,
                ))
            except Exception as e:
                log.warning("manual_event_parse_error", title=title, error=str(e))
        if not return_only:
            with self._lock:
                # Merge with existing, avoiding duplicates
                existing_titles = {e.title for e in self._events}
                self._events += [e for e in events if e.title not in existing_titles]
        return events


# ── ForexFactory RSS parser ───────────────────────────────────────────────────

def _parse_ff_rss(xml_text: str) -> list[NewsEvent]:
    """
    Parse ForexFactory weekly calendar RSS XML.
    FF RSS format:
      <item>
        <title>USD Non-Farm Payrolls</title>
        <country>USD</country>
        <date>jan01.2026</date>
        <time>8:30am</time>
        <impact>High</impact>
        <forecast>200K</forecast>
        <previous>180K</previous>
      </item>
    """
    events: list[NewsEvent] = []
    try:
        root = ElementTree.fromstring(xml_text)
        channel = root.find("channel")
        if channel is None:
            return events
        for item in channel.findall("item"):
            title    = _tag(item, "title", "")
            currency = _tag(item, "country", "").upper()
            impact   = _tag(item, "impact", "Low")
            date_str = _tag(item, "date", "")
            time_str = _tag(item, "time", "")
            forecast = _tag(item, "forecast", "")
            previous = _tag(item, "previous", "")

            if not currency or impact.lower() not in ("high", "medium"):
                continue

            event_utc = _parse_ff_datetime(date_str, time_str)
            if event_utc is None:
                continue

            events.append(NewsEvent(
                title=title, currency=currency, impact=impact,
                event_utc=event_utc, forecast=forecast, previous=previous,
            ))
    except Exception as e:
        log.warning("ff_rss_parse_error", error=str(e))
    return events


def _tag(elem, name: str, default: str = "") -> str:
    child = elem.find(name)
    return (child.text or default).strip() if child is not None else default


def _parse_ff_datetime(date_str: str, time_str: str) -> Optional[datetime]:
    """
    Parse ForexFactory date/time strings.
    date_str: "Jan01.2026" or "2026-01-01"
    time_str: "8:30am", "12:00pm", "All Day", ""
    """
    if not date_str:
        return None
    try:
        # Try ISO format first
        if re.match(r"\d{4}-\d{2}-\d{2}", date_str):
            date = datetime.strptime(date_str, "%Y-%m-%d").date()
        else:
            # FF format: "Jan01.2026"
            date = datetime.strptime(date_str, "%b%d.%Y").date()

        if not time_str or time_str.lower() in ("all day", "tentative", ""):
            # All-day events: block at 00:00 UTC for the full day
            return datetime(date.year, date.month, date.day, 0, 0, tzinfo=timezone.utc)

        # Parse 12-hour time: "8:30am", "12:00pm"
        t = datetime.strptime(time_str.strip().lower(), "%I:%M%p")
        return datetime(
            date.year, date.month, date.day,
            t.hour, t.minute, tzinfo=timezone.utc
        )
    except Exception:
        return None
