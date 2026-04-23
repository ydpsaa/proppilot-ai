"""
PropPilot AI — Data Feed Module
Multi-source real-time OHLCV pipeline:
  • Binance WebSocket  → BTC/USD, ETH/USD
  • Twelve Data WS/REST → XAU/USD, forex pairs
  • Alpaca WS          → NAS100 (via QQQ proxy)
  • Demo mode          → synthetic candles for testing

All sources normalize to a unified Candle dataclass and feed a
per-symbol CandleStore that maintains M1/M5/M15/H1/H4/D1 histories.
"""

from __future__ import annotations

import asyncio
import json
import math
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional

import httpx
import structlog
import websockets
from tenacity import retry, stop_after_attempt, wait_exponential

import config

log = structlog.get_logger("data_feed")

# ─── Data Structures ──────────────────────────────────────────────────────────

@dataclass
class Candle:
    """Unified OHLCV candle."""
    symbol:    str
    timeframe: int          # minutes: 1, 5, 15, 60, 240, 1440
    ts:        int          # unix timestamp (open time), seconds
    open:      float
    high:      float
    low:       float
    close:     float
    volume:    float
    complete:  bool = True  # False = still forming (live candle)

    @property
    def dt(self) -> datetime:
        return datetime.fromtimestamp(self.ts, tz=timezone.utc)

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol, "timeframe": self.timeframe,
            "ts": self.ts, "open": self.open, "high": self.high,
            "low": self.low, "close": self.close, "volume": self.volume,
            "complete": self.complete,
        }


class CandleStore:
    """
    Aggregates M1 ticks into all higher timeframes.
    Maintains a fixed-size deque per (symbol, tf).
    """
    MAX_BARS = 500

    def __init__(self, symbol: str):
        self.symbol = symbol
        # { tf_minutes: deque[Candle] }
        self._bars: dict[int, deque[Candle]] = {
            tf: deque(maxlen=self.MAX_BARS) for tf in config.TIMEFRAMES
        }
        # Current (incomplete) bar per higher TF
        self._live: dict[int, Optional[Candle]] = {tf: None for tf in config.TIMEFRAMES}
        self._callbacks: list[Callable[[Candle], None]] = []

    def add_callback(self, fn: Callable[[Candle], None]) -> None:
        self._callbacks.append(fn)

    def bars(self, tf: int) -> list[Candle]:
        """Return completed bars for the given timeframe (oldest first)."""
        return list(self._bars[tf])

    def latest(self, tf: int, n: int = 1) -> list[Candle]:
        """Return the N most recent completed bars."""
        bars = list(self._bars[tf])
        return bars[-n:] if bars else []

    def current_price(self) -> Optional[float]:
        """Most recent close price from M1."""
        bars = self._bars[1]
        return bars[-1].close if bars else None

    def load_history(self, candles: list[Candle]) -> None:
        """Bulk-load historical bars. Candles must be M1, sorted ascending."""
        for c in candles:
            self._ingest_m1(c, notify=False)
        log.info("history_loaded", symbol=self.symbol, bars=len(candles))

    def push_m1(self, c: Candle) -> None:
        """Ingest a completed M1 candle and update all TFs."""
        self._ingest_m1(c, notify=True)

    def push_tick(self, price: float, ts: int, volume: float = 0.0) -> None:
        """Update the live (incomplete) M1 bar from a tick."""
        tf = 1
        slot = (ts // 60) * 60
        live = self._live[tf]
        if live is None or live.ts != slot:
            # New minute — close previous live bar
            if live is not None:
                live.complete = True
                self._bars[tf].append(live)
                self._propagate_m1(live)
                for fn in self._callbacks:
                    fn(live)
            self._live[tf] = Candle(
                symbol=self.symbol, timeframe=1, ts=slot,
                open=price, high=price, low=price, close=price,
                volume=volume, complete=False,
            )
        else:
            live.high  = max(live.high, price)
            live.low   = min(live.low,  price)
            live.close = price
            live.volume += volume

    # ── internal ───────────────────────────────────────────────────────────────

    def _ingest_m1(self, c: Candle, notify: bool) -> None:
        self._bars[1].append(c)
        self._propagate_m1(c)
        if notify:
            for fn in self._callbacks:
                fn(c)

    def _propagate_m1(self, m1: Candle) -> None:
        """Fold M1 into M5/M15/H1/H4/D1."""
        for tf in config.TIMEFRAMES[1:]:     # skip M1
            slot = (m1.ts // (tf * 60)) * (tf * 60)
            live = self._live[tf]
            if live is None or live.ts != slot:
                if live is not None:
                    live.complete = True
                    self._bars[tf].append(live)
                self._live[tf] = Candle(
                    symbol=self.symbol, timeframe=tf, ts=slot,
                    open=m1.open, high=m1.high, low=m1.low, close=m1.close,
                    volume=m1.volume, complete=False,
                )
            else:
                live.high   = max(live.high,  m1.high)
                live.low    = min(live.low,   m1.low)
                live.close  = m1.close
                live.volume += m1.volume


# ─── DataFeed (main class) ────────────────────────────────────────────────────

class DataFeed:
    """
    Manages connections for all active symbols.
    Usage:
        feed = DataFeed(symbols=["XAU/USD", "BTC/USD"])
        await feed.start()
        store = feed.store("XAU/USD")
        bars  = store.bars(15)   # list of M15 Candle objects
    """

    def __init__(self, symbols: list[str]):
        self.symbols  = symbols
        self.stores:  dict[str, CandleStore] = {s: CandleStore(s) for s in symbols}
        self._tasks:  list[asyncio.Task] = []
        self._running = False

    def store(self, symbol: str) -> CandleStore:
        return self.stores[symbol]

    async def start(self) -> None:
        """Load history then start all live WS connections."""
        self._running = True
        log.info("data_feed_starting", symbols=self.symbols)

        # Load historical bars concurrently
        await asyncio.gather(*(self._load_history(s) for s in self.symbols))

        # Start live feeds
        for sym in self.symbols:
            src = config.DATA_SOURCE.get(sym, "demo")
            if src == "binance":
                t = asyncio.create_task(self._binance_loop(sym), name=f"binance_{sym}")
            elif src == "twelvedata":
                t = asyncio.create_task(self._twelvedata_loop(sym), name=f"td_{sym}")
            elif src == "alpaca":
                t = asyncio.create_task(self._alpaca_loop(sym), name=f"alpaca_{sym}")
            else:
                t = asyncio.create_task(self._demo_loop(sym), name=f"demo_{sym}")
            self._tasks.append(t)

        log.info("data_feed_started", feeds=len(self._tasks))

    async def stop(self) -> None:
        self._running = False
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        log.info("data_feed_stopped")

    # ── History loading ────────────────────────────────────────────────────────

    async def _load_history(self, symbol: str) -> None:
        src = config.DATA_SOURCE.get(symbol, "demo")
        try:
            if src == "binance":
                candles = await self._fetch_binance_history(symbol)
            elif src == "twelvedata" and config.TWELVE_DATA_KEY:
                candles = await self._fetch_twelvedata_history(symbol)
            elif src == "alpaca" and config.ALPACA_API_KEY:
                candles = await self._fetch_alpaca_history(symbol)
            else:
                candles = self._generate_demo_history(symbol)
            self.stores[symbol].load_history(candles)
        except Exception as e:
            log.warning("history_load_failed", symbol=symbol, error=str(e))
            self.stores[symbol].load_history(self._generate_demo_history(symbol))

    async def _fetch_binance_history(self, symbol: str) -> list[Candle]:
        bsym = config.BINANCE_SYMBOL[symbol]
        url  = f"https://api.binance.com/api/v3/klines?symbol={bsym}&interval=1m&limit={config.HISTORY_BARS_M1}"
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(url)
            r.raise_for_status()
        return [
            Candle(symbol=symbol, timeframe=1, ts=int(k[0])//1000,
                   open=float(k[1]), high=float(k[2]), low=float(k[3]),
                   close=float(k[4]), volume=float(k[5]))
            for k in r.json()
        ]

    async def _fetch_twelvedata_history(self, symbol: str) -> list[Candle]:
        td_sym = config.TWELVE_DATA_SYMBOL.get(symbol, symbol.replace("/", ""))
        params = {
            "symbol": td_sym, "interval": "1min",
            "outputsize": config.HISTORY_BARS_M1,
            "apikey": config.TWELVE_DATA_KEY,
            "format": "JSON",
        }
        url = "https://api.twelvedata.com/time_series"
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(url, params=params)
            r.raise_for_status()
        data = r.json()
        if "values" not in data:
            raise ValueError(f"Twelve Data error: {data.get('message', data)}")
        candles = []
        for v in reversed(data["values"]):
            ts = int(datetime.strptime(v["datetime"], "%Y-%m-%d %H:%M:%S")
                     .replace(tzinfo=timezone.utc).timestamp())
            candles.append(Candle(
                symbol=symbol, timeframe=1, ts=ts,
                open=float(v["open"]), high=float(v["high"]),
                low=float(v["low"]), close=float(v["close"]),
                volume=float(v.get("volume", 0)),
            ))
        return candles

    async def _fetch_alpaca_history(self, symbol: str) -> list[Candle]:
        """Fetch M1 bars from Alpaca v2 API."""
        asym = config.ALPACA_SYMBOL.get(symbol, symbol)
        url = f"https://data.alpaca.markets/v2/stocks/{asym}/bars"
        headers = {
            "APCA-API-KEY-ID":     config.ALPACA_API_KEY,
            "APCA-API-SECRET-KEY": config.ALPACA_SECRET,
        }
        params = {"timeframe": "1Min", "limit": config.HISTORY_BARS_M1, "feed": "iex"}
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(url, headers=headers, params=params)
            r.raise_for_status()
        bars = r.json().get("bars", [])
        candles = []
        for b in bars:
            ts = int(datetime.fromisoformat(b["t"].replace("Z", "+00:00")).timestamp())
            candles.append(Candle(
                symbol=symbol, timeframe=1, ts=ts,
                open=float(b["o"]), high=float(b["h"]),
                low=float(b["l"]), close=float(b["c"]),
                volume=float(b.get("v", 0)),
            ))
        return sorted(candles, key=lambda c: c.ts)

    def _generate_demo_history(self, symbol: str, n: int = 500) -> list[Candle]:
        """Synthetic realistic candles for demo/testing."""
        import random
        seed_prices = {
            "XAU/USD": 2350.0, "NAS100": 19_000.0,
            "EUR/USD": 1.085, "GBP/USD": 1.27,
            "USD/JPY": 149.5, "BTC/USD": 65_000.0, "ETH/USD": 3_400.0,
        }
        price = seed_prices.get(symbol, 1.0)
        now   = int(time.time())
        now   = (now // 60) * 60 - n * 60
        candles = []
        rng = random.Random(hash(symbol))
        vol = price * 0.0005
        for i in range(n):
            o = price
            h = o + abs(rng.gauss(0, vol))
            l = o - abs(rng.gauss(0, vol))
            c = rng.gauss(o, vol * 0.3)
            c = max(l, min(h, c))
            price = c
            candles.append(Candle(
                symbol=symbol, timeframe=1, ts=now + i * 60,
                open=round(o, 5), high=round(h, 5),
                low=round(l, 5), close=round(c, 5),
                volume=round(abs(rng.gauss(100, 30)), 1),
            ))
        return candles

    # ── Live WebSocket loops ───────────────────────────────────────────────────

    async def _binance_loop(self, symbol: str) -> None:
        bsym = config.BINANCE_SYMBOL[symbol].lower()
        url  = f"wss://stream.binance.com:9443/ws/{bsym}@kline_1m"
        store = self.stores[symbol]
        log.info("binance_ws_connecting", symbol=symbol, url=url)
        while self._running:
            try:
                async with websockets.connect(url, ping_interval=20) as ws:
                    log.info("binance_ws_connected", symbol=symbol)
                    async for raw in ws:
                        if not self._running:
                            break
                        msg = json.loads(raw)
                        k = msg.get("k", {})
                        price = float(k["c"])
                        ts    = int(k["t"]) // 1000
                        vol   = float(k["v"])
                        store.push_tick(price, ts, vol)
                        if k.get("x"):   # closed candle
                            store.push_m1(Candle(
                                symbol=symbol, timeframe=1, ts=ts,
                                open=float(k["o"]), high=float(k["h"]),
                                low=float(k["l"]), close=price,
                                volume=vol,
                            ))
            except Exception as e:
                log.warning("binance_ws_error", symbol=symbol, error=str(e))
                await asyncio.sleep(5)

    async def _twelvedata_loop(self, symbol: str) -> None:
        """Twelve Data WebSocket (1min bars)."""
        td_sym = config.TWELVE_DATA_SYMBOL.get(symbol, symbol)
        url = "wss://ws.twelvedata.com/v1/quotes/price"
        store = self.stores[symbol]
        log.info("twelvedata_ws_connecting", symbol=symbol)
        while self._running:
            try:
                async with websockets.connect(url) as ws:
                    # Subscribe
                    await ws.send(json.dumps({
                        "action": "subscribe",
                        "params": {"symbols": td_sym, "apikey": config.TWELVE_DATA_KEY},
                    }))
                    log.info("twelvedata_ws_connected", symbol=symbol)
                    async for raw in ws:
                        if not self._running:
                            break
                        msg = json.loads(raw)
                        if msg.get("event") == "price":
                            price = float(msg.get("price", 0))
                            ts    = int(time.time())
                            if price > 0:
                                store.push_tick(price, ts, 0)
            except Exception as e:
                log.warning("twelvedata_ws_error", symbol=symbol, error=str(e))
                # Fallback: REST polling every 5s
                await self._twelvedata_poll(symbol)
                await asyncio.sleep(5)

    async def _twelvedata_poll(self, symbol: str) -> None:
        """REST fallback: poll latest price from Twelve Data."""
        td_sym = config.TWELVE_DATA_SYMBOL.get(symbol, symbol)
        url = "https://api.twelvedata.com/price"
        params = {"symbol": td_sym, "apikey": config.TWELVE_DATA_KEY}
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                r = await c.get(url, params=params)
                r.raise_for_status()
            data = r.json()
            price = float(data.get("price", 0))
            if price > 0:
                self.stores[symbol].push_tick(price, int(time.time()), 0)
        except Exception:
            pass

    async def _alpaca_loop(self, symbol: str) -> None:
        asym  = config.ALPACA_SYMBOL.get(symbol, symbol)
        store = self.stores[symbol]
        url = "wss://stream.data.alpaca.markets/v2/iex"
        log.info("alpaca_ws_connecting", symbol=symbol)
        while self._running:
            try:
                async with websockets.connect(url) as ws:
                    # Auth
                    await ws.send(json.dumps({
                        "action": "auth",
                        "key": config.ALPACA_API_KEY,
                        "secret": config.ALPACA_SECRET,
                    }))
                    # Subscribe to bars
                    await ws.send(json.dumps({
                        "action": "subscribe",
                        "bars": [asym],
                        "trades": [asym],
                    }))
                    log.info("alpaca_ws_connected", symbol=symbol)
                    async for raw in ws:
                        if not self._running:
                            break
                        msgs = json.loads(raw)
                        for msg in (msgs if isinstance(msgs, list) else [msgs]):
                            T = msg.get("T")
                            if T == "t":   # trade tick
                                price = float(msg.get("p", 0))
                                ts    = int(time.time())
                                if price > 0:
                                    store.push_tick(price, ts, float(msg.get("s", 0)))
                            elif T == "b":  # bar
                                ts = int(datetime.fromisoformat(
                                    msg["t"].replace("Z", "+00:00")).timestamp())
                                store.push_m1(Candle(
                                    symbol=symbol, timeframe=1, ts=ts,
                                    open=float(msg["o"]), high=float(msg["h"]),
                                    low=float(msg["l"]), close=float(msg["c"]),
                                    volume=float(msg.get("v", 0)),
                                ))
            except Exception as e:
                log.warning("alpaca_ws_error", symbol=symbol, error=str(e))
                await asyncio.sleep(5)

    async def _demo_loop(self, symbol: str) -> None:
        """Emit synthetic ticks every second for demo/testing."""
        import random
        store = self.stores[symbol]
        rng   = random.Random(hash(symbol) ^ int(time.time()))
        bars  = store.bars(1)
        price = bars[-1].close if bars else 1.0
        vol   = price * 0.0005
        log.info("demo_feed_started", symbol=symbol, price=price)
        while self._running:
            drift = rng.gauss(0, vol * 0.1)
            price = max(price * 0.5, price + drift)
            store.push_tick(round(price, 5), int(time.time()), round(abs(rng.gauss(1, 0.5)), 2))
            await asyncio.sleep(1)
