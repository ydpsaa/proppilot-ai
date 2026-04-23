/**
 * dataProvider.js — PropPilot AI Real-Time Market Data Provider
 * ─────────────────────────────────────────────────────────────────
 * Unified data fetching layer with automatic source selection:
 *   • Crypto (BTCUSDT, ETHUSDT …)  → Binance Public WebSocket
 *   • Forex / Gold (EURUSD, XAUUSD) → Twelve Data WS or REST polling
 *   • US Indices (NAS100, SPX)      → Alpaca WS or Twelve Data fallback
 *
 * All data normalised to: { time:unix, open, high, low, close, volume }
 * Multi-TF candles built by CandleAggregator from 1-min base stream.
 * Reconnect logic uses exponential back-off (5 s → 60 s max).
 * Demo Mode activates automatically when all real sources fail.
 *
 * Usage (global scope — no bundler required):
 *   const dp = new PropPilot.DataProvider({ twelveDataKey: 'YOUR_KEY' });
 *   const unsub = dp.subscribe('BTCUSDT', ['m5','m15','h1'], (evt) => {
 *     console.log(evt.symbol, evt.timeframe, evt.candle, evt.status);
 *   });
 *   const history = dp.getCandles('BTCUSDT', 'h1');
 *   unsub(); // stop subscription
 *
 * @version 2.0.0
 */
(function (global) {
  'use strict';

  // ─── Timeframe map ───────────────────────────────────────────────────────────
  const TF_MINUTES = { m1:1, m5:5, m15:15, m30:30, h1:60, h4:240, d1:1440 };

  // ─── Asset classification ─────────────────────────────────────────────────────
  function classifyAsset(symbol) {
    const s = symbol.toUpperCase().replace(/\//g, '');
    const CRYPTO_SUFFIXES = ['USDT','USDC','BTC','ETH','BNB','BUSD'];
    const INDICES  = ['NAS100','US100','SPX','SPX500','US500','DOW','US30','NDX','NDAQ'];
    const FOREX    = [
      'EURUSD','GBPUSD','USDJPY','USDCAD','AUDUSD','NZDUSD','USDCHF',
      'XAUUSD','GOLD','SILVER','XAGUSD','GBPJPY','EURJPY','EURGBP',
      'USDMXN','USDSGD','USDHKD',
    ];
    if (INDICES.includes(s)) return 'index';
    if (FOREX.includes(s))   return 'forex';
    if (CRYPTO_SUFFIXES.some(sfx => s.endsWith(sfx) && s.length > sfx.length)) return 'crypto';
    return 'unknown';
  }

  // ─── Candle Aggregator ────────────────────────────────────────────────────────
  /**
   * Builds higher-TF OHLCV candles from 1-min base ticks.
   * Each call to .feed(candle1m) returns a completed candle or null.
   */
  function CandleAggregator(tfMinutes) {
    this.tfMinutes    = tfMinutes;
    this.tfSeconds    = tfMinutes * 60;
    this.currentCandle = null;
  }

  CandleAggregator.prototype.feed = function (c1m) {
    const slotTime = Math.floor(c1m.time / this.tfSeconds) * this.tfSeconds;
    if (!this.currentCandle || this.currentCandle.time !== slotTime) {
      const completed = this.currentCandle ? Object.assign({}, this.currentCandle) : null;
      this.currentCandle = {
        time:   slotTime,
        open:   c1m.open,
        high:   c1m.high,
        low:    c1m.low,
        close:  c1m.close,
        volume: c1m.volume || 0,
      };
      return completed;
    }
    // Merge into current slot
    const cur = this.currentCandle;
    cur.high   = Math.max(cur.high, c1m.high);
    cur.low    = Math.min(cur.low,  c1m.low);
    cur.close  = c1m.close;
    cur.volume = (cur.volume || 0) + (c1m.volume || 0);
    return null;
  };

  CandleAggregator.prototype.getCurrent = function () {
    return this.currentCandle ? Object.assign({}, this.currentCandle) : null;
  };

  CandleAggregator.prototype.reset = function () {
    this.currentCandle = null;
  };

  // ─── Mock data helpers ────────────────────────────────────────────────────────
  function generateMockCandles(basePrice, count, tfMinutes) {
    const candles = [];
    let price     = basePrice;
    const now     = Math.floor(Date.now() / 1000);
    const step    = tfMinutes * 60;
    for (let i = count; i >= 0; i--) {
      const t     = now - i * step;
      const drift = (Math.random() - 0.488) * 0.007;  // slight bullish bias
      const rangeR = price * 0.004 * (0.4 + Math.random());
      const open   = price;
      const close  = price * (1 + drift);
      const high   = Math.max(open, close) + rangeR * Math.random();
      const low    = Math.min(open, close) - rangeR * Math.random();
      candles.push({
        time:   t,
        open:   +open.toFixed(8),
        high:   +high.toFixed(8),
        low:    +low.toFixed(8),
        close:  +close.toFixed(8),
        volume: Math.floor(Math.random() * 5000 + 200),
      });
      price = close;
    }
    return candles;
  }

  function createMockStream(basePrice, onTick, intervalMs) {
    intervalMs = intervalMs || 2000;
    let price = basePrice;
    const id  = setInterval(function () {
      const drift  = (Math.random() - 0.499) * 0.003;
      price        = price * (1 + drift);
      const spread = price * 0.0003;
      onTick({
        time:   Math.floor(Date.now() / 1000),
        open:   +(price - spread * 0.3).toFixed(8),
        high:   +(price + spread * Math.random()).toFixed(8),
        low:    +(price - spread * Math.random()).toFixed(8),
        close:  +price.toFixed(8),
        volume: Math.floor(Math.random() * 120 + 20),
      });
    }, intervalMs);
    return function () { clearInterval(id); };
  }

  // ─── DataProvider ─────────────────────────────────────────────────────────────
  /**
   * @param {Object} config
   * @param {string} [config.twelveDataKey]  — Twelve Data API key
   * @param {string} [config.alpacaKey]      — Alpaca API key ID
   * @param {string} [config.alpacaSecret]   — Alpaca API secret key
   * @param {boolean} [config.demoMode]      — Force demo mode (default false)
   * @param {number}  [config.maxCandlesPerTF] — Buffer size per TF (default 1000)
   */
  function DataProvider(config) {
    config = config || {};
    this.cfg = {
      twelveDataKey:    config.twelveDataKey   || '',
      alpacaKey:        config.alpacaKey       || '',
      alpacaSecret:     config.alpacaSecret    || '',
      demoMode:         config.demoMode        || false,
      maxCandles:       config.maxCandlesPerTF || 1000,
      pollIntervalMs:   config.pollIntervalMs  || 5000,
    };
    // Map<symbol, { ws, type, status, retries }>
    this._conns      = {};
    // Map<symbol, { m1:[], m5:[], ... }>
    this._store      = {};
    // Map<symbol, { m5: CandleAggregator, ... }>
    this._aggs       = {};
    // Map<symbol, Set<function>>
    this._subs       = {};
    // Map<symbol, function>  (cleanup for intervals / mock streams)
    this._cleanups   = {};
    // Map<symbol, number>    (reconnect timer IDs)
    this._retryTimers = {};
    // status-change listeners
    this._statusListeners = [];
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Subscribe to real-time OHLCV updates.
   * @param {string}   symbol     e.g. "BTCUSDT", "XAUUSD", "NAS100"
   * @param {string[]} timeframes e.g. ["m5","m15","h1"]
   * @param {function} callback   ({symbol, timeframe, candle, history, status}) => void
   * @returns {function} unsubscribe
   */
  DataProvider.prototype.subscribe = function (symbol, timeframes, callback) {
    const sym = symbol.toUpperCase();
    if (!this._subs[sym]) {
      this._subs[sym] = new Set();
      this._initStore(sym);
      this._connect(sym);
    }
    this._subs[sym].add(callback);
    // If we already have data, fire immediately with current state
    const self = this;
    (timeframes || ['m5']).forEach(function (tf) {
      const history = self._store[sym] && self._store[sym][tf];
      if (history && history.length > 0) {
        try {
          callback({ symbol: sym, timeframe: tf, candle: history[history.length - 1], history: history.slice(), status: self.getStatus(sym) });
        } catch (e) {}
      }
    });
    return function () { self.unsubscribe(sym, callback); };
  };

  DataProvider.prototype.unsubscribe = function (symbol, callback) {
    const sym = symbol.toUpperCase();
    if (this._subs[sym]) {
      this._subs[sym].delete(callback);
      if (this._subs[sym].size === 0) {
        this._disconnect(sym);
      }
    }
  };

  /** @returns {'live'|'delayed'|'demo'|'disconnected'} */
  DataProvider.prototype.getStatus = function (symbol) {
    const conn = this._conns[symbol.toUpperCase()];
    return conn ? conn.status : 'disconnected';
  };

  /** Get buffered candle history for a symbol+timeframe */
  DataProvider.prototype.getCandles = function (symbol, timeframe) {
    const store = this._store[symbol.toUpperCase()];
    return store ? (store[timeframe] || []).slice() : [];
  };

  /** Add a status-change listener: ({ symbol, status }) => void */
  DataProvider.prototype.onStatusChange = function (listener) {
    this._statusListeners.push(listener);
    return function () { this._statusListeners = this._statusListeners.filter(function (l) { return l !== listener; }); }.bind(this);
  };

  /**
   * Async: Force-fetch historical candles from the remote source.
   * Updates internal store and returns the array.
   */
  DataProvider.prototype.fetchHistory = function (symbol, timeframe, count) {
    const sym        = symbol.toUpperCase();
    count            = count || 500;
    const assetClass = classifyAsset(sym);
    const self       = this;
    var promise;
    if (assetClass === 'crypto') {
      promise = self._fetchBinanceHistory(sym, timeframe, count);
    } else {
      promise = self._fetchTwelveHistory(sym, timeframe, count);
    }
    return promise.then(function (candles) {
      if (candles.length > 0) {
        self._store[sym] = self._store[sym] || self._blankStore();
        self._store[sym][timeframe] = candles;
      }
      return candles;
    }).catch(function (err) {
      console.warn('[DataProvider] fetchHistory failed:', err.message);
      return [];
    });
  };

  /** Gracefully disconnect and clean up all subscriptions */
  DataProvider.prototype.destroy = function () {
    const self = this;
    Object.keys(this._conns).forEach(function (sym) { self._disconnect(sym); });
  };

  // ── Private: Connection management ───────────────────────────────────────────

  DataProvider.prototype._initStore = function (sym) {
    if (this._store[sym]) return;
    this._store[sym] = this._blankStore();
    this._aggs[sym]  = {};
    for (var tf in TF_MINUTES) {
      if (tf !== 'm1') this._aggs[sym][tf] = new CandleAggregator(TF_MINUTES[tf]);
    }
  };

  DataProvider.prototype._blankStore = function () {
    var s = {};
    for (var tf in TF_MINUTES) s[tf] = [];
    return s;
  };

  DataProvider.prototype._connect = function (sym) {
    if (this.cfg.demoMode) { this._startDemoMode(sym); return; }
    const assetClass = classifyAsset(sym);
    console.log('[DataProvider] Connecting', sym, '(' + assetClass + ')');
    if (assetClass === 'crypto') {
      this._connectBinance(sym);
    } else if (assetClass === 'index') {
      if (this.cfg.alpacaKey) this._connectAlpaca(sym);
      else if (this.cfg.twelveDataKey) this._connectTwelveData(sym);
      else this._startDemoMode(sym);
    } else if (assetClass === 'forex') {
      if (this.cfg.twelveDataKey) this._connectTwelveData(sym);
      else this._startDemoMode(sym);
    } else {
      this._startDemoMode(sym);
    }
  };

  DataProvider.prototype._disconnect = function (sym) {
    const conn = this._conns[sym];
    if (conn && conn.ws) {
      try { conn.ws.close(); } catch (e) {}
    }
    if (this._cleanups[sym]) {
      try { this._cleanups[sym](); } catch (e) {}
      delete this._cleanups[sym];
    }
    if (this._retryTimers[sym]) {
      clearTimeout(this._retryTimers[sym]);
      delete this._retryTimers[sym];
    }
    delete this._conns[sym];
  };

  DataProvider.prototype._scheduleReconnect = function (sym, baseDelay) {
    baseDelay = baseDelay || 5000;
    const conn = this._conns[sym];
    if (!conn) return;
    conn.retries = (conn.retries || 0) + 1;
    const delay  = Math.min(baseDelay * Math.pow(1.5, conn.retries - 1), 60000);
    console.log('[DataProvider] Reconnecting', sym, 'in', Math.round(delay / 1000) + 's', '(attempt', conn.retries + ')');
    const self   = this;
    this._retryTimers[sym] = setTimeout(function () {
      if (self._subs[sym] && self._subs[sym].size > 0) self._connect(sym);
    }, delay);
  };

  // ── Binance (Crypto) ──────────────────────────────────────────────────────────

  DataProvider.prototype._connectBinance = function (sym) {
    const s      = sym.toLowerCase();
    const wsUrl  = 'wss://stream.binance.com:9443/stream?streams=' + s + '@kline_1m/' + s + '@miniTicker';
    let ws;
    try { ws = new WebSocket(wsUrl); }
    catch (e) { console.warn('[DataProvider] Binance WS unavailable, starting demo mode'); this._startDemoMode(sym); return; }

    this._conns[sym] = { ws: ws, type: 'binance', status: 'connecting', retries: 0 };
    const self = this;

    ws.onopen = function () {
      console.log('[DataProvider] Binance connected:', sym);
      self._setStatus(sym, 'live');
      self._fetchBinanceHistory(sym, 'm1', 500).then(function (hist) {
        if (hist.length) {
          self._store[sym].m1 = hist;
          self._rebuildAggregated(sym, hist);
          // Notify all timeframes with initial data
          var tfs = Object.keys(TF_MINUTES);
          tfs.forEach(function (tf) {
            var store = self._store[sym][tf];
            if (store && store.length > 0) self._emit(sym, tf, store[store.length - 1]);
          });
        }
      });
    };

    ws.onmessage = function (e) {
      try {
        const msg = JSON.parse(e.data);
        if (!msg.data) return;
        if (msg.stream && msg.stream.indexOf('kline') !== -1) {
          const k = msg.data.k;
          self._onTick(sym, {
            time:   Math.floor(k.t / 1000),
            open:   parseFloat(k.o),
            high:   parseFloat(k.h),
            low:    parseFloat(k.l),
            close:  parseFloat(k.c),
            volume: parseFloat(k.v),
          }, k.x); // k.x = candle closed
        }
      } catch (err) {}
    };

    ws.onerror = function () { console.warn('[DataProvider] Binance WS error:', sym); };

    ws.onclose = function () {
      self._setStatus(sym, 'delayed');
      self._scheduleReconnect(sym);
    };
  };

  DataProvider.prototype._fetchBinanceHistory = function (sym, tf, limit) {
    const MAP = { m1:'1m', m5:'5m', m15:'15m', m30:'30m', h1:'1h', h4:'4h', d1:'1d' };
    const url = 'https://api.binance.com/api/v3/klines?symbol=' + sym + '&interval=' + (MAP[tf] || '1m') + '&limit=' + limit;
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      return data.map(function (k) {
        return { time: Math.floor(k[0] / 1000), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) };
      });
    }).catch(function (err) {
      console.warn('[DataProvider] Binance history error:', err.message);
      return [];
    });
  };

  // ── Alpaca (US Indices) ───────────────────────────────────────────────────────

  DataProvider.prototype._connectAlpaca = function (sym) {
    const alpSym = this._alpacaSymbol(sym);
    const ws     = new WebSocket('wss://stream.data.alpaca.markets/v2/iex');
    this._conns[sym] = { ws: ws, type: 'alpaca', status: 'connecting', retries: 0 };
    const self = this;

    ws.onopen = function () {
      ws.send(JSON.stringify({ action: 'auth', key: self.cfg.alpacaKey, secret: self.cfg.alpacaSecret }));
    };

    ws.onmessage = function (e) {
      let msgs;
      try { msgs = JSON.parse(e.data); } catch (e) { return; }
      if (!Array.isArray(msgs)) msgs = [msgs];
      msgs.forEach(function (msg) {
        if (msg.T === 'success' && msg.msg === 'authenticated') {
          self._setStatus(sym, 'live');
          ws.send(JSON.stringify({ action: 'subscribe', bars: [alpSym] }));
          self._fetchAlpacaHistory(sym, 'm1', 390).then(function (hist) {
            if (hist.length) {
              self._store[sym].m1 = hist;
              self._rebuildAggregated(sym, hist);
            }
          });
        } else if (msg.T === 'b') { // 1-min bar
          self._onTick(sym, {
            time:   Math.floor(new Date(msg.t).getTime() / 1000),
            open:   msg.o, high: msg.h, low: msg.l, close: msg.c, volume: msg.v,
          }, true);
        }
      });
    };

    ws.onerror = function () {
      console.warn('[DataProvider] Alpaca WS error, falling back to Twelve Data');
      self.cfg.twelveDataKey ? self._connectTwelveData(sym) : self._startDemoMode(sym);
    };

    ws.onclose = function () {
      self._setStatus(sym, 'delayed');
      self._scheduleReconnect(sym);
    };
  };

  DataProvider.prototype._alpacaSymbol = function (sym) {
    const map = { NAS100:'QQQ', US100:'QQQ', NDAQ:'QQQ', SPX:'SPY', SPX500:'SPY', US500:'SPY', DOW:'DIA', US30:'DIA' };
    return map[sym] || sym;
  };

  DataProvider.prototype._fetchAlpacaHistory = function (sym, tf, limit) {
    if (!this.cfg.alpacaKey) return Promise.resolve([]);
    const alpSym = this._alpacaSymbol(sym);
    const MAP = { m1:'1Min', m5:'5Min', m15:'15Min', m30:'30Min', h1:'1Hour', d1:'1Day' };
    const url = 'https://data.alpaca.markets/v2/stocks/' + alpSym + '/bars?timeframe=' + (MAP[tf] || '1Min') + '&limit=' + limit + '&feed=iex';
    return fetch(url, {
      headers: { 'APCA-API-KEY-ID': this.cfg.alpacaKey, 'APCA-API-SECRET-KEY': this.cfg.alpacaSecret },
    }).then(function (r) { return r.json(); }).then(function (data) {
      return (data.bars || []).map(function (b) {
        return { time: Math.floor(new Date(b.t).getTime() / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v };
      });
    }).catch(function () { return []; });
  };

  // ── Twelve Data (Forex / Gold / Indices fallback) ─────────────────────────────

  DataProvider.prototype._connectTwelveData = function (sym) {
    if (!this.cfg.twelveDataKey) { this._pollTwelveData(sym); return; }
    const ws = new WebSocket('wss://ws.twelvedata.com/v1/quotes/price?apikey=' + this.cfg.twelveDataKey);
    this._conns[sym] = { ws: ws, type: 'twelvedata-ws', status: 'connecting', retries: 0 };
    const self = this;
    let tickBuf = null;

    ws.onopen = function () {
      ws.send(JSON.stringify({ action: 'subscribe', params: { symbols: sym } }));
      self._setStatus(sym, 'live');
      self._fetchTwelveHistory(sym, 'm1', 400).then(function (hist) {
        if (hist.length) { self._store[sym].m1 = hist; self._rebuildAggregated(sym, hist); }
      });
    };

    ws.onmessage = function (e) {
      try {
        const msg   = JSON.parse(e.data);
        if (msg.event !== 'price') return;
        const price = parseFloat(msg.price);
        const slot  = Math.floor(Date.now() / 60000) * 60;
        if (!tickBuf || tickBuf.time !== slot) {
          if (tickBuf) self._onTick(sym, tickBuf, true);
          tickBuf = { time: slot, open: price, high: price, low: price, close: price, volume: 1 };
        } else {
          tickBuf.high  = Math.max(tickBuf.high, price);
          tickBuf.low   = Math.min(tickBuf.low,  price);
          tickBuf.close = price;
          tickBuf.volume++;
          self._onTick(sym, Object.assign({}, tickBuf), false);
        }
      } catch (err) {}
    };

    ws.onerror = function () { self._pollTwelveData(sym); };
    ws.onclose = function () { self._setStatus(sym, 'delayed'); self._scheduleReconnect(sym); };
  };

  DataProvider.prototype._pollTwelveData = function (sym) {
    if (!this.cfg.twelveDataKey) { this._startDemoMode(sym); return; }
    this._conns[sym] = { ws: null, type: 'rest-poll', status: 'delayed', retries: 0 };
    const self = this;
    let tickBuf = null;

    const poll = function () {
      const url = 'https://api.twelvedata.com/price?symbol=' + sym + '&apikey=' + self.cfg.twelveDataKey;
      fetch(url).then(function (r) { return r.json(); }).then(function (data) {
        if (!data.price) throw new Error(data.message || 'No price');
        const price = parseFloat(data.price);
        const slot  = Math.floor(Date.now() / 60000) * 60;
        if (!tickBuf || tickBuf.time !== slot) {
          if (tickBuf) self._onTick(sym, tickBuf, true);
          tickBuf = { time: slot, open: price, high: price, low: price, close: price, volume: 1 };
        } else {
          tickBuf.high  = Math.max(tickBuf.high, price);
          tickBuf.low   = Math.min(tickBuf.low,  price);
          tickBuf.close = price;
          tickBuf.volume++;
        }
        self._onTick(sym, Object.assign({}, tickBuf), false);
        self._setStatus(sym, 'delayed');
      }).catch(function (err) {
        console.warn('[DataProvider] Twelve Data poll error:', err.message);
        self._setStatus(sym, 'demo');
      });
    };

    // Load history once
    self._fetchTwelveHistory(sym, 'm1', 400).then(function (hist) {
      if (hist.length) { self._store[sym].m1 = hist; self._rebuildAggregated(sym, hist); }
    });

    poll();
    const id = setInterval(poll, this.cfg.pollIntervalMs);
    this._cleanups[sym] = function () { clearInterval(id); };
  };

  DataProvider.prototype._fetchTwelveHistory = function (sym, tf, count) {
    if (!this.cfg.twelveDataKey) return Promise.resolve([]);
    const MAP = { m1:'1min', m5:'5min', m15:'15min', m30:'30min', h1:'1h', h4:'4h', d1:'1day' };
    const url = 'https://api.twelvedata.com/time_series?symbol=' + sym + '&interval=' + (MAP[tf] || '1min') + '&outputsize=' + count + '&apikey=' + this.cfg.twelveDataKey;
    return fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      if (!data.values) throw new Error(data.message || 'No values');
      return data.values.slice().reverse().map(function (v) {
        return {
          time:   Math.floor(new Date(v.datetime.replace(' ', 'T') + 'Z').getTime() / 1000),
          open:   parseFloat(v.open), high: parseFloat(v.high),
          low:    parseFloat(v.low),  close: parseFloat(v.close),
          volume: parseFloat(v.volume) || 0,
        };
      });
    }).catch(function (err) {
      console.warn('[DataProvider] Twelve Data history error:', err.message);
      return [];
    });
  };

  // ── Demo Mode ─────────────────────────────────────────────────────────────────

  DataProvider.prototype._startDemoMode = function (sym, basePrice) {
    console.log('[DataProvider] Demo mode:', sym);
    this._conns[sym] = { ws: null, type: 'demo', status: 'demo', retries: 0 };
    this._setStatus(sym, 'demo');

    const PRICES = {
      BTCUSDT:67500, ETHUSDT:3500, XAUUSD:2320, EURUSD:1.0850,
      GBPUSD:1.2650, NAS100:18200, SPX:5200, US100:18200, XAGUSD:28.5,
    };
    const bp = basePrice || PRICES[sym] || 1000;

    // Pre-generate multi-TF historical data
    const self = this;
    Object.keys(TF_MINUTES).forEach(function (tf) {
      const mins  = TF_MINUTES[tf];
      const count = Math.min(500, Math.ceil(5 * 1440 / mins)); // ~5 days of data
      self._store[sym][tf] = generateMockCandles(bp, count, mins);
    });

    // Start live tick stream
    const stopStream = createMockStream(bp, function (tick) {
      self._onTick(sym, tick, false);
    }, 2000);
    this._cleanups[sym] = stopStream;

    // Fire initial data to all subscribers
    const tfs = Object.keys(TF_MINUTES);
    tfs.forEach(function (tf) {
      const store = self._store[sym][tf];
      if (store.length > 0) self._emit(sym, tf, store[store.length - 1]);
    });
  };

  // ── Data pipeline ─────────────────────────────────────────────────────────────

  DataProvider.prototype._onTick = function (sym, candle, isClosed) {
    const store = this._store[sym];
    const aggs  = this._aggs[sym];
    if (!store || !aggs) return;

    // ① Update M1 buffer
    this._updateBuffer(store.m1, candle, this.cfg.maxCandles);
    this._emit(sym, 'm1', candle);

    // ② Feed aggregators → higher TFs
    const self = this;
    if (isClosed) {
      Object.keys(aggs).forEach(function (tf) {
        const completed = aggs[tf].feed(candle);
        if (completed) {
          self._updateBuffer(store[tf], completed, self.cfg.maxCandles);
          self._emit(sym, tf, completed);
        }
        // Always push current (live/unclosed) higher-TF candle
        const cur = aggs[tf].getCurrent();
        if (cur) {
          self._updateBuffer(store[tf], cur, self.cfg.maxCandles);
          self._emit(sym, tf, cur);
        }
      });
    } else {
      // Update the last candle of each aggregator with the latest close
      Object.keys(aggs).forEach(function (tf) {
        const cur = aggs[tf].getCurrent();
        if (cur) {
          // Patch current open candle high/low/close with incoming tick
          cur.high  = Math.max(cur.high, candle.high);
          cur.low   = Math.min(cur.low,  candle.low);
          cur.close = candle.close;
          self._updateBuffer(store[tf], Object.assign({}, cur), self.cfg.maxCandles);
          self._emit(sym, tf, cur);
        }
      });
    }
  };

  DataProvider.prototype._updateBuffer = function (arr, candle, maxLen) {
    if (!arr.length) { arr.push(Object.assign({}, candle)); return; }
    const last = arr[arr.length - 1];
    if (last.time === candle.time) {
      arr[arr.length - 1] = Object.assign({}, candle);
    } else if (candle.time > last.time) {
      arr.push(Object.assign({}, candle));
      if (arr.length > maxLen) arr.splice(0, arr.length - Math.floor(maxLen * 0.8));
    }
  };

  DataProvider.prototype._rebuildAggregated = function (sym, m1Candles) {
    const store = this._store[sym];
    const aggs  = this._aggs[sym];
    if (!store || !aggs) return;
    // Reset
    Object.keys(TF_MINUTES).forEach(function (tf) { if (tf !== 'm1') store[tf] = []; });
    Object.keys(aggs).forEach(function (tf) { aggs[tf].reset(); });
    // Replay
    const self = this;
    m1Candles.forEach(function (c) {
      Object.keys(aggs).forEach(function (tf) {
        const completed = aggs[tf].feed(c);
        if (completed) store[tf].push(completed);
      });
    });
    // Push current unclosed candle
    Object.keys(aggs).forEach(function (tf) {
      const cur = aggs[tf].getCurrent();
      if (cur) store[tf].push(cur);
    });
  };

  DataProvider.prototype._emit = function (sym, tf, candle) {
    const subs = this._subs[sym];
    if (!subs || !subs.size) return;
    const store   = this._store[sym];
    const history = store ? (store[tf] || []) : [];
    const evt     = { symbol: sym, timeframe: tf, candle: candle, history: history, status: this.getStatus(sym) };
    subs.forEach(function (cb) { try { cb(evt); } catch (err) { console.error('[DataProvider] callback error:', err); } });
  };

  DataProvider.prototype._setStatus = function (sym, status) {
    const conn = this._conns[sym];
    if (conn) conn.status = status;
    const evt = { symbol: sym, status: status };
    this._statusListeners.forEach(function (l) { try { l(evt); } catch (e) {} });
  };

  // ── Expose to global ──────────────────────────────────────────────────────────
  global.PropPilot = global.PropPilot || {};
  global.PropPilot.DataProvider     = DataProvider;
  global.PropPilot.CandleAggregator = CandleAggregator;
  global.PropPilot.classifyAsset    = classifyAsset;
  global.PropPilot.TF_MINUTES       = TF_MINUTES;

})(typeof window !== 'undefined' ? window : this);
