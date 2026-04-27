import React from 'react';
import ReactDOM from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import * as LightweightCharts from 'lightweight-charts';
import './styles.css';

window.supabase = window.supabase || { createClient };
window.LightweightCharts = window.LightweightCharts || LightweightCharts;

const { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext } = React;

// ═══════════════════════════════════════════════════════════════════════════
// TOAST SYSTEM
// ═══════════════════════════════════════════════════════════════════════════
const ToastCtx = createContext({ show: () => {} });
function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const show = useCallback((msg, type = 'info', dur = 4200) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev.slice(-4), { id, msg, type, exiting: false }]);
    setTimeout(() => {
      setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 320);
    }, dur);
  }, []);
  const ICONS = { success:'✅', error:'❌', info:'🔔', warn:'⚠️', signal:'⚡', outcome:'📊' };
  const BG    = { success:'rgba(16,185,129,0.13)', error:'rgba(239,68,68,0.13)', info:'rgba(59,130,246,0.13)', warn:'rgba(245,158,11,0.13)', signal:'rgba(59,130,246,0.13)', outcome:'rgba(167,139,250,0.13)' };
  const BD    = { success:'rgba(16,185,129,0.3)',  error:'rgba(239,68,68,0.3)',  info:'rgba(59,130,246,0.3)',  warn:'rgba(245,158,11,0.3)',  signal:'rgba(59,130,246,0.3)',  outcome:'rgba(167,139,250,0.3)'  };
  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      <div className="pp-toast-wrap">
        {toasts.map(t => (
          <div key={t.id} className={`pp-toast${t.exiting ? ' exiting' : ''}`}
            style={{ background: BG[t.type]||BG.info, borderColor: BD[t.type]||BD.info }}>
            <span style={{ fontSize:20, lineHeight:1, flexShrink:0 }}>{ICONS[t.type]||ICONS.info}</span>
            <div>
              <div style={{ color:'#F1F5F9', fontSize:13, lineHeight:1.55, fontWeight:600 }}>{t.msg}</div>
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
const useToast = () => useContext(ToastCtx);

// ═══════════════════════════════════════════════════════════════════════════
// ANIMATED NUMBER COUNTER
// ═══════════════════════════════════════════════════════════════════════════
function AnimNum({ value, prefix = '', suffix = '', decimals = 0, color, style: extra }) {
  const [display, setDisplay] = useState(Number(value) || 0);
  const prev = useRef(Number(value) || 0);
  const raf  = useRef(null);
  useEffect(() => {
    const end = Number(value) || 0;
    const start = prev.current;
    prev.current = end;
    if (Math.abs(end - start) < 0.01) { setDisplay(end); return; }
    cancelAnimationFrame(raf.current);
    const dur = 900;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const ease = 1 - Math.pow(1 - p, 3);
      setDisplay(start + (end - start) * ease);
      if (p < 1) { raf.current = requestAnimationFrame(step); }
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);
  const fmt = decimals > 0 ? display.toFixed(decimals) : Math.round(display).toLocaleString('en-US');
  return <span style={{ color, ...extra }}>{prefix}{fmt}{suffix}</span>;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIDENCE RING
// ═══════════════════════════════════════════════════════════════════════════
function ConfRing({ score = 0, size = 44 }) {
  const r    = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, score)) / 100) * circ;
  const col  = score >= 70 ? '#10B981' : score >= 50 ? '#F59E0B' : '#EF4444';
  return (
    <div style={{ position:'relative', width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={5}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={col} strokeWidth={5}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{ transition:'stroke-dasharray 0.8s ease' }}/>
      </svg>
      <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontWeight:900, color:col }}>
        {score}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TP/SL PROGRESS BAR
// ═══════════════════════════════════════════════════════════════════════════
function TpSlBar({ entry, tp1, tp2, sl, currentPrice, direction }) {
  if (!entry || !sl) return null;
  const isLong = direction === 'LONG' || (tp1 && tp1 > entry);
  const slDist  = Math.abs(entry - sl);
  const tp1Dist = tp1 ? Math.abs(tp1 - entry) : slDist * 1.5;
  const tp2Dist = tp2 ? Math.abs(tp2 - entry) : slDist * 2.5;
  const total   = tp2Dist + slDist;
  const slPct   = (slDist / total) * 100;
  const tp1Pct  = (tp1Dist / total) * 100;
  const tp2Pct  = (tp2Dist / total) * 100;

  // Current price progress
  let curPct = 50; // entry = center
  if (currentPrice) {
    const fromEntry = isLong ? currentPrice - entry : entry - currentPrice;
    curPct = 50 + (fromEntry / total) * 100;
    curPct = Math.max(2, Math.min(98, curPct));
  }

  return (
    <div style={{ marginTop:10 }}>
      <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'rgba(148,163,184,0.7)', marginBottom:5 }}>
        <span style={{ color:'#EF4444' }}>SL {sl?.toFixed(2)}</span>
        <span style={{ color:'rgba(148,163,184,0.5)' }}>Entry {entry?.toFixed(2)}</span>
        {tp1 && <span style={{ color:'#34D399' }}>TP1 {tp1?.toFixed(2)}</span>}
        {tp2 && <span style={{ color:'#10B981' }}>TP2 {tp2?.toFixed(2)}</span>}
      </div>
      <div className="pp-tp-track">
        {/* SL zone */}
        <div className="pp-tp-fill" style={{ width:`${slPct}%`, background:'rgba(239,68,68,0.35)', left:0 }}/>
        {/* TP zone */}
        <div className="pp-tp-fill" style={{ width:`${tp2Pct}%`, background:'rgba(16,185,129,0.25)', right:0, left:'auto' }}/>
        {/* TP1 marker */}
        {tp1 && <div style={{ position:'absolute', top:0, bottom:0, left:`${slPct + (tp1Pct/(tp1Pct+tp2Pct))*(tp2Pct)}%`, width:2, background:'rgba(52,211,153,0.6)' }}/>}
        {/* Current price cursor */}
        {currentPrice && <div style={{ position:'absolute', top:-3, bottom:-3, left:`${curPct}%`, width:2, background:'#fff', borderRadius:1, boxShadow:'0 0 6px rgba(255,255,255,0.8)' }}/>}
      </div>
    </div>
  );
}

// ── localStorage helpers ──────────────────────────────────────────────────
const LS = {
  get: (key, fallback) => {
    try {
      const v = localStorage.getItem('pp_' + key);
      return v !== null ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  set: (key, val) => {
    try { localStorage.setItem('pp_' + key, JSON.stringify(val)); } catch {}
  },
};

// Pure SVG area chart — no external deps
function PriceChart({ data }) {
  const W = 560, H = 170, PL = 5, PR = 5, PT = 5, PB = 22;
  if (!data || data.length < 2) return null;
  const vals = data.map(d => d.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const rng = max - min || 1;
  const sx = i => PL + (i / (data.length - 1)) * (W - PL - PR);
  const sy = v => H - PB - ((v - min) / rng) * (H - PT - PB);
  const pts = data.map((d, i) => [sx(i), sy(d.v)]);
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length-1][0].toFixed(1)},${(H-PB).toFixed(1)} L${pts[0][0].toFixed(1)},${(H-PB).toFixed(1)} Z`;
  const tickIdxs = [0, Math.floor(data.length/4), Math.floor(data.length/2), Math.floor(data.length*3/4), data.length-1];
  const [hover, setHover] = useState(null);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'100%',overflow:'visible'}}
      onMouseMove={e => {
        const rect = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) * W;
        const idx = Math.round(Math.max(0, Math.min(data.length-1, (px - PL) / (W - PL - PR) * (data.length-1))));
        setHover({ idx, x: pts[idx][0], y: pts[idx][1], d: data[idx] });
      }}
      onMouseLeave={() => setHover(null)}>
      <defs>
        <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" stopColor="#F5A623" stopOpacity="0.3"/>
          <stop offset="95%" stopColor="#F5A623" stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={area} fill="url(#ag)"/>
      <path d={line} fill="none" stroke="#F5A623" strokeWidth="1.8"/>
      {tickIdxs.map(i => (
        <text key={i} x={pts[i][0]} y={H-4} fill="#475569" fontSize="9" textAnchor="middle">{data[i]?.t}</text>
      ))}
      {hover && <>
        <line x1={hover.x} y1={PT} x2={hover.x} y2={H-PB} stroke="rgba(255,255,255,0.15)" strokeWidth="1"/>
        <circle cx={hover.x} cy={hover.y} r="4" fill="#F5A623" stroke="#070810" strokeWidth="2"/>
        <rect x={hover.x > W*0.7 ? hover.x-110 : hover.x+8} y={hover.y-18} width="100" height="22" rx="5" fill="#0F1117" stroke="rgba(255,255,255,0.12)"/>
        <text x={hover.x > W*0.7 ? hover.x-60 : hover.x+58} y={hover.y-3} fill="#F5A623" fontSize="11" textAnchor="middle" fontWeight="700">{hover.d.v?.toFixed(2)}</text>
      </>}
    </svg>
  );
}

// ── API ENDPOINTS ────────────────────────────────────────────────────────────
const SB_URL = import.meta.env.VITE_SUPABASE_URL || 'https://nxiednydxyrtxpkmgtof.supabase.co';
const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im54aWVkbnlkeHlydHhwa21ndG9mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5MzMxMDAsImV4cCI6MjA5MjUwOTEwMH0.yPvkGuw6KPoBluEyTu7kFGJ0h6ClxbU6g_spn20XU68';
const SB_HDR = { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` };
const SB_JSON_HDR = { ...SB_HDR, 'Content-Type': 'application/json' };

// ── Supabase: user_challenges sync ────────────────────────────────────────
async function syncChallengeToSB(userId, challengeData) {
  if (!userId || !sbClient) return;
  try {
    const headers = await getAuthedJsonHeaders();
    await fetch(`${SB_URL}/rest/v1/user_challenges`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: userId, challenge_data: challengeData, updated_at: new Date().toISOString() }),
    });
  } catch(e) { console.warn('[sync] Challenge upload failed:', e); }
}

async function loadChallengeFromSB(userId) {
  if (!userId || !sbClient) return null;
  try {
    const token = await getSupabaseAccessToken();
    if (!token) return null;
    const r = await fetch(
      `${SB_URL}/rest/v1/user_challenges?user_id=eq.${userId}&select=challenge_data&limit=1`,
      { headers: { ...SB_HDR, Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    if (!r.ok) return null;
    const arr = await r.json();
    return arr?.[0]?.challenge_data || null;
  } catch { return null; }
}

// ── Supabase: user_profiles (plan + onboarding) ───────────────────────────
async function loadUserProfile(userId) {
  if (!userId || !sbClient) return { plan:'free', onboarding_done:false };
  try {
    const token = await getSupabaseAccessToken();
    if (!token) return { plan:'free', onboarding_done:false };
    const r = await fetch(
      `${SB_URL}/rest/v1/user_profiles?id=eq.${userId}&select=plan,onboarding_done&limit=1`,
      { headers: { ...SB_HDR, Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    if (!r.ok) return { plan:'free', onboarding_done:false };
    const arr = await r.json();
    return arr?.[0] || { plan:'free', onboarding_done:false };
  } catch { return { plan:'free', onboarding_done:false }; }
}

async function saveUserProfile(userId, updates) {
  if (!userId || !sbClient) return;
  try {
    const headers = await getAuthedJsonHeaders();
    await fetch(`${SB_URL}/rest/v1/user_profiles`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: userId, ...updates, updated_at: new Date().toISOString() }),
    });
  } catch(e) { console.warn('[profile] Save failed:', e); }
}

// ── Plan tier constants ────────────────────────────────────────────────────
const PLAN_ORDER = { free:0, pro:1, elite:2 };
const PLAN_META  = {
  free:  { label:'Free',  color:'#64748B', price:'$0/mo',  features:['Signal engine','Basic journal (10 trades)','Today dashboard'] },
  pro:   { label:'Pro',   color:'#6366F1', price:'$29/mo', features:['Everything in Free','Unlimited journal + AI coaching','Challenge sync across devices','Analyze tab','Risk calculator'] },
  elite: { label:'Elite', color:'#F59E0B', price:'$59/mo', features:['Everything in Pro','Automation & paper trading','Priority support','Multi-challenge tracking'] },
};
const sbClient = (() => {
  try { return window.supabase ? window.supabase.createClient(SB_URL, SB_KEY) : null; }
  catch (e) { console.warn('Supabase client unavailable', e); return null; }
})();

async function getSupabaseAccessToken() {
  if (!sbClient) return null;
  const session = (await sbClient.auth.getSession()).data.session;
  return session?.access_token || null;
}

async function getAuthedJsonHeaders() {
  const token = await getSupabaseAccessToken();
  if (!token) throw new Error('Sign in required for server-side changes.');
  return {
    ...SB_JSON_HDR,
    Authorization: `Bearer ${token}`,
  };
}

// Market data — Supabase Edge Function proxying Yahoo Finance (free, no app key)
const MD_URL = `${import.meta.env.VITE_SUPABASE_FUNCTIONS_URL || `${SB_URL}/functions/v1`}/market-data`;
// Helper: fetch OHLCV via market-data Edge Function (Yahoo Finance)
async function mdFetchOHLCV(sym, interval = '1h', bars = 200) {
  const enc = encodeURIComponent(sym);
  const r = await fetch(`${MD_URL}?type=ohlcv&symbol=${enc}&interval=${interval}&bars=${bars}`, {
    headers: { 'apikey': SB_KEY },
  });
  if (!r.ok) throw new Error(`market-data HTTP ${r.status}`);
  const json = await r.json();
  if (json.error) throw new Error(json.error);
  // Already in {v,h,l,o,t} format
  return json.candles;
}
// Helper: fetch live prices via market-data Edge Function
async function mdFetchPrices(syms) {
  const enc = syms.map(s => encodeURIComponent(s)).join(',');
  const r = await fetch(`${MD_URL}?type=price&symbol=${enc}`, {
    headers: { 'apikey': SB_KEY },
  });
  if (!r.ok) throw new Error(`market-data HTTP ${r.status}`);
  const json = await r.json();
  if (json.error) throw new Error(json.error);
  return json.prices; // { 'XAU/USD': 3320.5, ... }
}
const VERDICT_LABEL = { 'LONG_NOW':'LONG','SHORT_NOW':'SHORT','WAIT_LONG':'WAIT','WAIT_SHORT':'WAIT','NO_TRADE':'NO TRADE' };

// ═══════════════════════════════════════════════════════════════════════════
// STATIC REFERENCE DATA
// ═══════════════════════════════════════════════════════════════════════════

const PHASES = {
  s1: { label:'Step 1',       tag:'S1', target:0.10, dailyLimit:0.05, maxLoss:0.10, minDays:10, newsBlock:false, funded:false },
  s2: { label:'Step 2',       tag:'S2', target:0.05, dailyLimit:0.05, maxLoss:0.10, minDays:10, newsBlock:false, funded:false },
  fs: { label:'Funded Std',   tag:'FS', target:null,  dailyLimit:0.05, maxLoss:0.10, minDays:null, newsBlock:true,  funded:true  },
  sw: { label:'Funded Swing', tag:'SW', target:null,  dailyLimit:0.05, maxLoss:0.10, minDays:null, newsBlock:false, funded:true  },
};

// ═══════════════════════════════════════════════════════════════════════════
// PROP FIRM DATABASE
// ═══════════════════════════════════════════════════════════════════════════
const PROP_FIRMS = {
  ftmo: {
    name:'FTMO', color:'#00D4A8', logo:'🟢',
    sizes:[10000,25000,50000,100000,200000,400000],
    types:{
      standard:{
        label:'Standard', phases:['Step 1','Step 2','Funded'],
        rules:{
          'Step 1': { target:0.10, daily:0.05, maxDD:0.10, minDays:10, newsBlock:false, weekend:false, split:null },
          'Step 2': { target:0.05, daily:0.05, maxDD:0.10, minDays:10, newsBlock:false, weekend:false, split:null },
          Funded:   { target:null, daily:0.05, maxDD:0.10, minDays:null, newsBlock:true,  weekend:false, split:0.80 },
        },
        price:{ 10000:155, 25000:250, 50000:345, 100000:540, 200000:1080, 400000:2160 },
      },
      swing:{
        label:'Swing', phases:['Step 1','Step 2','Funded'],
        rules:{
          'Step 1': { target:0.10, daily:null, maxDD:0.10, minDays:10, newsBlock:false, weekend:true, split:null },
          'Step 2': { target:0.05, daily:null, maxDD:0.10, minDays:10, newsBlock:false, weekend:true, split:null },
          Funded:   { target:null, daily:null, maxDD:0.10, minDays:null, newsBlock:false, weekend:true, split:0.80 },
        },
        price:{ 10000:195, 25000:310, 50000:425, 100000:660, 200000:1320, 400000:2640 },
      },
    },
  },
  mff: {
    name:'MyFundedFx', color:'#8B5CF6', logo:'🟣',
    sizes:[5000,10000,25000,50000,100000,200000],
    types:{
      standard:{
        label:'Standard', phases:['Phase 1','Phase 2','Funded'],
        rules:{
          'Phase 1': { target:0.08, daily:0.05, maxDD:0.10, minDays:5,  newsBlock:false, weekend:false, split:null },
          'Phase 2': { target:0.05, daily:0.05, maxDD:0.10, minDays:5,  newsBlock:false, weekend:false, split:null },
          Funded:    { target:null, daily:0.05, maxDD:0.10, minDays:null,newsBlock:false, weekend:false, split:0.75 },
        },
        price:{ 5000:49, 10000:84, 25000:149, 50000:249, 100000:449, 200000:799 },
      },
      rapid:{
        label:'Rapid (1-Step)', phases:['Rapid Phase','Funded'],
        rules:{
          'Rapid Phase': { target:0.10, daily:0.05, maxDD:0.10, minDays:1,  newsBlock:false, weekend:false, split:null },
          Funded:         { target:null, daily:0.05, maxDD:0.10, minDays:null,newsBlock:false, weekend:false, split:0.75 },
        },
        price:{ 5000:39, 10000:69, 25000:119, 50000:199, 100000:379, 200000:699 },
      },
    },
  },
  the5ers: {
    name:'The5ers', color:'#F59E0B', logo:'🟡',
    sizes:[4000,20000,40000,80000,160000,320000],
    types:{
      hyc:{
        label:'High-Stakes', phases:['Phase 1','Phase 2','Funded'],
        rules:{
          'Phase 1': { target:0.08, daily:0.04, maxDD:0.06, minDays:3,  newsBlock:false, weekend:false, split:null },
          'Phase 2': { target:0.05, daily:0.04, maxDD:0.06, minDays:3,  newsBlock:false, weekend:false, split:null },
          Funded:    { target:null, daily:0.04, maxDD:0.06, minDays:null,newsBlock:false, weekend:false, split:0.80 },
        },
        price:{ 4000:39, 20000:159, 40000:229, 80000:359, 160000:589, 320000:989 },
      },
      bootcamp:{
        label:'Bootcamp', phases:['Bootcamp','Funded'],
        rules:{
          Bootcamp: { target:0.10, daily:0.04, maxDD:0.04, minDays:10, newsBlock:false, weekend:false, split:null },
          Funded:   { target:null, daily:0.04, maxDD:0.04, minDays:null,newsBlock:false, weekend:false, split:0.80 },
        },
        price:{ 4000:49, 20000:189, 40000:269, 80000:429 },
      },
    },
  },
  fundednext: {
    name:'FundedNext', color:'#3B82F6', logo:'🔵',
    sizes:[6000,15000,25000,50000,100000,200000],
    types:{
      stellar:{
        label:'Stellar (2-Step)', phases:['Phase 1','Phase 2','Funded'],
        rules:{
          'Phase 1': { target:0.10, daily:0.05, maxDD:0.10, minDays:5,  newsBlock:false, weekend:false, split:null },
          'Phase 2': { target:0.05, daily:0.05, maxDD:0.10, minDays:5,  newsBlock:false, weekend:false, split:null },
          Funded:    { target:null, daily:0.05, maxDD:0.10, minDays:null,newsBlock:false, weekend:false, split:0.90 },
        },
        price:{ 6000:49, 15000:89, 25000:149, 50000:249, 100000:449, 200000:849 },
      },
      express:{
        label:'Express (1-Step)', phases:['Express','Funded'],
        rules:{
          Express: { target:0.25, daily:0.05, maxDD:0.10, minDays:5,  newsBlock:false, weekend:false, split:null },
          Funded:  { target:null, daily:0.05, maxDD:0.10, minDays:null,newsBlock:false, weekend:false, split:0.90 },
        },
        price:{ 6000:59, 15000:109, 25000:189, 50000:329, 100000:619, 200000:1199 },
      },
    },
  },
  e8: {
    name:'E8 Markets', color:'#EF4444', logo:'🔴',
    sizes:[25000,50000,100000,250000],
    types:{
      standard:{
        label:'Standard', phases:['Phase 1','Phase 2','Funded'],
        rules:{
          'Phase 1': { target:0.08, daily:0.05, maxDD:0.08, minDays:1,  newsBlock:false, weekend:false, split:null },
          'Phase 2': { target:0.05, daily:0.05, maxDD:0.08, minDays:1,  newsBlock:false, weekend:false, split:null },
          Funded:    { target:null, daily:0.05, maxDD:0.08, minDays:null,newsBlock:false, weekend:false, split:0.80 },
        },
        price:{ 25000:228, 50000:388, 100000:588, 250000:988 },
      },
    },
  },
  tff: {
    name:'True Forex Funds', color:'#10B981', logo:'🟩',
    sizes:[10000,25000,50000,100000,200000],
    types:{
      standard:{
        label:'Standard', phases:['Phase 1','Phase 2','Funded'],
        rules:{
          'Phase 1': { target:0.10, daily:0.05, maxDD:0.10, minDays:10, newsBlock:false, weekend:false, split:null },
          'Phase 2': { target:0.05, daily:0.05, maxDD:0.10, minDays:10, newsBlock:false, weekend:false, split:null },
          Funded:    { target:null, daily:0.05, maxDD:0.10, minDays:null,newsBlock:false, weekend:false, split:0.80 },
        },
        price:{ 10000:95, 25000:195, 50000:295, 100000:495, 200000:945 },
      },
    },
  },
};

const RESULTS = {
  'XAU/USD|LONG':  { v:'LONG',     c:71, entry:'2,314–2,319', sl:'2,301', tp1:'2,345', tp2:'2,368', rr1:'1:2.0', rr2:'1:3.8', regime:'Bullish Trend · Consolidation', newsRisk:'MED',  newsNote:'Avoid overnight hold — CPI tomorrow.', comp:'COMPLIANT', compNote:'Use 0.7 lots on $910 risk.', body:'BOS confirmed on H4 above recent swing. OB aligns with consolidation. D1 bullish. M15 demand absorption at entry zone — LTF confirmation present.', inv:'H1 close below recent swing low invalidates.' },
  'XAU/USD|SHORT': { v:'NO TRADE', c:22, noReason:'Bullish structure on H4+D1. No CHoCH to justify short.', regime:'Bullish Trend · Counter-Direction', newsRisk:'MED', newsNote:'Shorting into bullish structure before news is double risk.', comp:'WARNING', compNote:'Structurally invalid.', body:'No bearish BOS or CHoCH on H1/H4/D1. Shorting against confirmed bullish structure with no justification.', inv:'Wait for H4 CHoCH before considering shorts.' },
  'EUR/USD|LONG':  { v:'WAIT',     c:48, entry:'1.0835–1.0842', sl:'1.0815', tp1:'1.0875', rr1:'1:1.9', regime:'Ranging · No Clear Direction', newsRisk:'HIGH', newsNote:'EU PPI imminent — wait for post-news structure.', comp:'WARNING', compNote:'Borderline — size down if entering.', body:'EUR/USD in H4 consolidation. No clear BOS or CHoCH. Price at midrange — low conviction. Wait for break after EU PPI.', inv:'Wait for post-news directional break.' },
  'EUR/USD|SHORT': { v:'SHORT',    c:62, entry:'1.0855–1.0862', sl:'1.0878', tp1:'1.0822', tp2:'1.0798', rr1:'1:1.5', rr2:'1:2.7', regime:'Bearish Pullback · HTF Downtrend', newsRisk:'HIGH', newsNote:'EU PPI soon — reduce size 50% or wait.', comp:'COMPLIANT', compNote:'Reduce size 50% for news risk.', body:'H4 bearish BOS below 1.0840. Distribution zone 1.0855–1.0865. D1 liquidity pool below 1.0800. M15 supply rejection candles present.', inv:'H1 close above 1.0880 invalidates.' },
  'GBP/USD|LONG':  { v:'LONG',     c:65, entry:'1.2748–1.2755', sl:'1.2731', tp1:'1.2785', tp2:'1.2810', rr1:'1:1.9', rr2:'1:3.2', regime:'Bullish Trend · Pullback Entry', newsRisk:'LOW', newsNote:'No major GBP news today. Clean window.', comp:'COMPLIANT', compNote:'All limits clear. Standard sizing.', body:'GBP/USD uptrend D1+H4. Pullback to H4 OB 1.2748–1.2755. CHoCH confirmed H1 after liquidity grab. Low news risk — one of the cleaner setups.', inv:'H4 close below 1.2720 invalidates.' },
  'GBP/USD|SHORT': { v:'NO TRADE', c:20, noReason:'Bullish trend all timeframes. No valid short structure.', regime:'Bullish Trend · Counter-Direction', newsRisk:'LOW', newsNote:'News clear — structure does not support shorts.', comp:'COMPLIANT', compNote:'Structurally invalid.', body:'D1+H4 bullish structure, CHoCH confirmed upside. No bearish BOS anywhere. Pure counter-trend with zero justification.', inv:'No valid short setup — check LONG instead.' },
  'NAS100|LONG':   { v:'NO TRADE', c:35, noReason:'High-impact news tomorrow. Overnight gap risk unacceptable.', regime:'High Volatility · Pre-News', newsRisk:'HIGH', newsNote:'Extreme overnight gap risk — SL cannot protect.', comp:'WARNING', compNote:'News risk overrides the setup.', body:'NAS100 H4 bullish but CPI+Powell tomorrow creates extreme gap risk. Any position is exposed to moves far beyond SL.', inv:'Wait until post-CPI. Re-evaluate with fresh data.' },
  'NAS100|SHORT':  { v:'NO TRADE', c:30, noReason:'Same — extreme news risk in both directions.', regime:'High Volatility · Pre-News', newsRisk:'HIGH', newsNote:'No direction is safe before CPI+Powell.', comp:'WARNING', compNote:'Not recommended in either direction.', body:'Bullish momentum but pre-CPI environment creates two-sided tail risk.', inv:'Post-CPI reassessment mandatory.' },
  'USD/JPY|LONG':  { v:'WAIT',     c:44, entry:'152.40–152.60', sl:'151.80', tp1:'153.80', rr1:'1:2.3', regime:'Ranging · BOJ Intervention Risk', newsRisk:'HIGH', newsNote:'BOJ intervention risk above 152. Extreme caution.', comp:'WARNING', compNote:'BOJ risk is unquantifiable — minimum size only.', body:'USD/JPY at historically sensitive BOJ zone (152+). Structure shows longs but tail risk from intervention is severe.', inv:'Any BOJ verbal intervention invalidates immediately.' },
  'USD/JPY|SHORT': { v:'SHORT',    c:58, entry:'152.80–153.10', sl:'153.50', tp1:'151.90', tp2:'151.20', rr1:'1:1.6', rr2:'1:2.6', regime:'Distribution Zone · Reversal Watch', newsRisk:'HIGH', newsNote:'BOJ intervention would accelerate this move.', comp:'COMPLIANT', compNote:'Minimum size mandatory — event risk.', body:'USD/JPY approaching key supply zone H4. Previous rejections from similar levels. BOJ intervention would accelerate. Conservative sizing mandatory.', inv:'Break above 153.55 H1 close invalidates.' },
};

const DEFAULT_HEATMAP = [
  { d:'18M', pnl:230  }, { d:'19M', pnl:-180 }, { d:'20M', pnl:310  }, { d:'21M', pnl:0    }, { d:'24M', pnl:145  },
  { d:'25M', pnl:-220 }, { d:'26M', pnl:180  }, { d:'27M', pnl:-90  }, { d:'28M', pnl:400  }, { d:'31M', pnl:280  },
  { d:'1A',  pnl:150  }, { d:'2A',  pnl:-310 }, { d:'3A',  pnl:0    }, { d:'4A',  pnl:190  }, { d:'7A',  pnl:220  },
  { d:'8A',  pnl:-150 }, { d:'9A',  pnl:270  }, { d:'10A', pnl:190  }, { d:'11A', pnl:-450 }, { d:'14A', pnl:130  },
  { d:'15A', pnl:-340 }, { d:'16A', pnl:273, today:true },
];

const DEFAULT_TRADES = [
  { id:1, date:'16 Apr', sym:'XAUUSD', dir:'LONG',  pnl:+273, rr:'1:2.1', score:87, win:true,  issue:null },
  { id:2, date:'15 Apr', sym:'EURUSD', dir:'SHORT', pnl:-190, rr:'1:1.5', score:42, win:false, issue:'FOMO entry — no LTF confirmation, chased the move' },
  { id:3, date:'15 Apr', sym:'XAUUSD', dir:'SHORT', pnl:+126, rr:'1:1.8', score:76, win:true,  issue:null },
  { id:4, date:'14 Apr', sym:'GBPUSD', dir:'LONG',  pnl:+280, rr:'1:1.5', score:81, win:true,  issue:null },
  { id:5, date:'14 Apr', sym:'EURUSD', dir:'LONG',  pnl:-150, rr:'1:1.3', score:38, win:false, issue:'Revenge trade — entered 18 min after previous loss, against H4 trend' },
];

// ═══════════════════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════════════════

const T = {
  amber:'#F59E0B', yellow:'#EAB308', indigo:'#3B82F6', blue:'#3B82F6', violet:'#8B5CF6',
  green:'#10B981', teal:'#14B8A6',   red:'#EF4444',    cyan:'#06B6D4',
  bg:'#05070f', text:'#F1F5F9', sub:'#94A3B8', muted:'#4B5A72',
  border:'rgba(255,255,255,0.1)', surf:'rgba(255,255,255,0.045)',
};
const card  = { background:'rgba(255,255,255,0.07)', border:'1px solid rgba(255,255,255,0.12)', borderRadius:16, padding:24, backdropFilter:'blur(24px) saturate(160%)', WebkitBackdropFilter:'blur(24px) saturate(160%)', boxShadow:'0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.14)' };
const cardS = { background:'rgba(255,255,255,0.07)', border:'1px solid rgba(255,255,255,0.12)', borderRadius:16, padding:16, backdropFilter:'blur(24px) saturate(160%)', WebkitBackdropFilter:'blur(24px) saturate(160%)', boxShadow:'0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.14)' };

// ═══════════════════════════════════════════════════════════════════════════
// ATOMS
// ═══════════════════════════════════════════════════════════════════════════

const Badge = ({ label, color }) => (
  <span style={{ background:`${color}20`, color, border:`1px solid ${color}40`, borderRadius:6, padding:'2px 9px', fontSize:11, fontWeight:700, letterSpacing:'0.06em', whiteSpace:'nowrap' }}>
    {label}
  </span>
);

const KVRow = ({ k, v, vc }) => (
  <div style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
    <span style={{ color:T.muted, fontSize:13 }}>{k}</span>
    <span style={{ color:vc||T.text, fontWeight:600, fontSize:13 }}>{v}</span>
  </div>
);

const Divider = () => <div style={{ height:1, background:T.border, margin:'16px 0' }} />;

function RiskBar({ label, value, max, sublabel }) {
  const pct = Math.min(value / max * 100, 100);
  const col = pct < 40 ? T.green : pct < 70 ? T.yellow : T.red;
  return (
    <div style={{ marginBottom:18 }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
        <span style={{ color:T.sub, fontSize:13 }}>{label}</span>
        <span style={{ color:col, fontSize:13, fontWeight:700 }}>{sublabel}</span>
      </div>
      <div style={{ height:8, background:'rgba(255,255,255,0.07)', borderRadius:4, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${pct}%`, background:col, borderRadius:4 }} />
      </div>
    </div>
  );
}

function safeNum(v, fallback = null) {
  return v == null || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v);
}

const INSTRUMENT_SPECS = {
  'XAU/USD': { contractSize: 100, pipSize: 0.01, label: 'lots' },
  XAUUSD: { contractSize: 100, pipSize: 0.01, label: 'lots' },
  NAS100: { contractSize: 20, pipSize: 1, label: 'lots' },
  'EUR/USD': { contractSize: 100000, pipSize: 0.0001, label: 'lots' },
  EURUSD: { contractSize: 100000, pipSize: 0.0001, label: 'lots' },
  'GBP/USD': { contractSize: 100000, pipSize: 0.0001, label: 'lots' },
  GBPUSD: { contractSize: 100000, pipSize: 0.0001, label: 'lots' },
  'USD/JPY': { contractSize: 100000, pipSize: 0.01, label: 'lots' },
  USDJPY: { contractSize: 100000, pipSize: 0.01, label: 'lots' },
  'GBP/JPY': { contractSize: 100000, pipSize: 0.01, label: 'lots' },
  GBPJPY: { contractSize: 100000, pipSize: 0.01, label: 'lots' },
  'BTC/USD': { contractSize: 1, pipSize: 1, label: 'coins' },
  BTCUSD: { contractSize: 1, pipSize: 1, label: 'coins' },
  'ETH/USD': { contractSize: 1, pipSize: 0.1, label: 'coins' },
  ETHUSD: { contractSize: 1, pipSize: 0.1, label: 'coins' },
};

function getInstrumentSpec(symbol) {
  const raw = String(symbol || '').toUpperCase();
  const compact = raw.replace(/\//g, '');
  return INSTRUMENT_SPECS[raw] || INSTRUMENT_SPECS[compact] || { contractSize: 100000, pipSize: compact.endsWith('JPY') ? 0.01 : 0.0001, label: 'lots' };
}

function fmtUsd(v, digits = 0) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function fmtR(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}R`;
}

function fmtPct(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)}%`;
}

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function sessionLabel(s) {
  if (!s) return 'Unknown';
  const raw = String(s);
  return raw
    .replace(/_/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function normalizeSignalRow(s) {
  return {
    ...s,
    signal_state: s.signal_state || s.verdict || 'NO_TRADE',
    direction: s.direction || (['LONG_NOW', 'WAIT_LONG'].includes(s.signal_state) ? 'LONG' : ['SHORT_NOW', 'WAIT_SHORT'].includes(s.signal_state) ? 'SHORT' : null),
    outcome: s.outcome || 'OPEN',
    confidence: safeNum(s.confidence, 0),
    price: safeNum(s.price),
    tp1: safeNum(s.tp1),
    tp2: safeNum(s.tp2),
    sl: safeNum(s.sl),
    pnl_r: safeNum(s.pnl_r),
    mfe_r: safeNum(s.mfe_r),
    mae_r: safeNum(s.mae_r),
    session_name: s.session_name || 'Unknown',
  };
}

function normalizeStatsRow(s) {
  return {
    ...s,
    total_signals: safeNum(s.total_signals, 0),
    open_signals: safeNum(s.open_signals, 0),
    wins: safeNum(s.wins, 0),
    losses: safeNum(s.losses, 0),
    expired: safeNum(s.expired, 0),
    win_rate: safeNum(s.win_rate, 0),
    avg_pnl_r: safeNum(s.avg_pnl_r),
    expectancy: safeNum(s.expectancy, 0),
    avg_mfe: safeNum(s.avg_mfe),
    avg_mae: safeNum(s.avg_mae),
    avg_confidence: safeNum(s.avg_confidence),
    best_hour: safeNum(s.best_hour),
  };
}

function deriveSyncState(rtStatus, loadState) {
  if (loadState === 'updating') return 'updating';
  if (rtStatus === 'live') return 'synced';
  if (rtStatus === 'error') return 'offline';
  return 'updating';
}

function useUnifiedAppData() {
  const [signals, setSignals] = useState([]);
  const [stats, setStats] = useState([]);
  const [account, setAccount] = useState(null);
  const [settings, setSettings] = useState(null);
  const [positions, setPositions] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [memory, setMemory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rtStatus, setRtStatus] = useState('connecting');
  const [loadState, setLoadState] = useState('idle');
  const [lastLoadAt, setLastLoadAt] = useState(null);
  const channelRef = useRef(null);
  const refreshRef = useRef(null);

  const refresh = useCallback(async (mode = 'updating') => {
    setLoadState(mode);
    try {
      const reqs = await Promise.all([
        fetch(`${SB_URL}/rest/v1/signal_analyses?select=*&order=created_at.desc&limit=250`, { headers: SB_HDR }),
        fetch(`${SB_URL}/rest/v1/strategy_stats?select=*&order=expectancy.desc,total_signals.desc&limit=80`, { headers: SB_HDR }),
        fetch(`${SB_URL}/rest/v1/paper_account?id=eq.1&select=*`, { headers: { ...SB_HDR, Accept: 'application/vnd.pgrst.object+json' } }),
        fetch(`${SB_URL}/rest/v1/bot_settings?id=eq.1&select=*`, { headers: { ...SB_HDR, Accept: 'application/vnd.pgrst.object+json' } }),
        fetch(`${SB_URL}/rest/v1/paper_positions?order=opened_at.desc&limit=60&select=*`, { headers: SB_HDR }),
        fetch(`${SB_URL}/rest/v1/equity_snapshots?order=created_at.asc&limit=240&select=*`, { headers: SB_HDR }),
        fetch(`${SB_URL}/rest/v1/bot_memory?order=run_at.desc&limit=6&select=*`, { headers: SB_HDR }),
      ]);
      const [
        sigRes, statRes, accountRes, settingsRes, positionsRes, snapshotsRes, memoryRes,
      ] = reqs;
      const [
        sigData, statData, accountData, settingsData, positionsData, snapshotsData, memoryData,
      ] = await Promise.all([
        sigRes.json(), statRes.json(), accountRes.json(), settingsRes.json(), positionsRes.json(), snapshotsRes.json(), memoryRes.json(),
      ]);
      setSignals(Array.isArray(sigData) ? sigData.map(normalizeSignalRow) : []);
      setStats(Array.isArray(statData) ? statData.map(normalizeStatsRow) : []);
      setAccount(accountData || null);
      setSettings(settingsData || null);
      setPositions(Array.isArray(positionsData) ? positionsData : []);
      setSnapshots(Array.isArray(snapshotsData) ? snapshotsData : []);
      setMemory(Array.isArray(memoryData) ? memoryData : []);
      setLastLoadAt(new Date());
      setRtStatus(status => (status === 'error' ? 'error' : status));
    } catch (e) {
      console.warn('Unified app load failed:', e);
      setRtStatus('error');
    } finally {
      setLoading(false);
      setLoadState('idle');
    }
  }, []);

  const scheduleRefresh = useCallback((mode = 'updating', delay = 400) => {
    clearTimeout(refreshRef.current);
    refreshRef.current = setTimeout(() => refresh(mode), delay);
  }, [refresh]);

  useEffect(() => {
    refresh('initial');
    const poll = setInterval(() => refresh('updating'), 180000);
    return () => {
      clearInterval(poll);
      clearTimeout(refreshRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (!sbClient) return;
    const ch = sbClient.channel('proppilot-shell-v1')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'paper_account', filter: 'id=eq.1' }, payload => {
        if (payload.new) setAccount(prev => ({ ...(prev || {}), ...payload.new }));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_settings', filter: 'id=eq.1' }, payload => {
        if (payload.new) setSettings(prev => ({ ...(prev || {}), ...payload.new }));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'paper_positions' }, () => scheduleRefresh())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'equity_snapshots' }, payload => {
        if (payload.new) setSnapshots(prev => [...prev, payload.new].slice(-240));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'signal_analyses' }, () => scheduleRefresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'strategy_stats' }, () => scheduleRefresh('updating', 900))
      .subscribe(status => {
        setRtStatus(status === 'SUBSCRIBED' ? 'live' : status === 'CHANNEL_ERROR' ? 'error' : 'connecting');
      });
    channelRef.current = ch;
    return () => {
      if (channelRef.current) sbClient.removeChannel(channelRef.current);
      channelRef.current = null;
    };
  }, [scheduleRefresh]);

  return {
    loading,
    signals,
    stats,
    account,
    settings,
    positions,
    snapshots,
    memory,
    rtStatus,
    loadState,
    syncState: deriveSyncState(rtStatus, loadState),
    lastLoadAt,
    refresh,
  };
}

// ── Price formatter — NAS100 uses 0 decimals ──────────────────────────────
function fmtPrice(key, price) {
  if (!price && price !== 0) return null;
  if (key === 'NAS100') return Math.round(price).toLocaleString('en-US');
  if (key === 'XAU/USD') return price.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  return price.toLocaleString('en-US', { minimumFractionDigits:4, maximumFractionDigits:4 });
}

// ═══════════════════════════════════════════════════════════════════════════
// SETUP MODAL
// ═══════════════════════════════════════════════════════════════════════════

function SetupModal({ account, setAccount, onClose }) {
  const [loc, setLoc] = useState({ ...account });
  const FIRMS = ['FTMO','MyFundedFx','The5ers','FundedNext','E8 Markets','True Forex Funds'];
  const SIZES = [10000,25000,50000,100000,200000];
  const inp = { width:'100%', padding:'10px 12px', background:'rgba(255,255,255,0.06)', border:`1px solid ${T.border}`, borderRadius:8, color:T.text, fontSize:14, outline:'none', boxSizing:'border-box' };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center' }} onClick={onClose}>
      <div className="pp-modal-inner" style={{ ...card, width:500, background:'rgba(5,7,15,0.92)', border:'1px solid rgba(245,166,35,0.3)' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight:900, fontSize:18, marginBottom:6 }}>Configure Account</div>
        <div style={{ color:T.muted, fontSize:13, marginBottom:24 }}>Enter your prop firm details. Risk Engine will use these values.</div>
        <div style={{ marginBottom:20 }}>
          <div style={{ color:T.muted, fontSize:11, marginBottom:10, textTransform:'uppercase', letterSpacing:'0.09em' }}>Prop Firm</div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            {FIRMS.map(f => (
              <button key={f} className="pp-firm-btn" onClick={() => setLoc(p => ({ ...p, firm:f }))} style={{ padding:'7px 13px', borderRadius:8, cursor:'pointer', border:`1px solid ${loc.firm===f?T.amber:'rgba(255,255,255,0.1)'}`, background:loc.firm===f?`${T.amber}1A`:'rgba(255,255,255,0.02)', color:loc.firm===f?T.amber:T.sub, fontSize:13, fontWeight:600 }}>
                {f}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom:20 }}>
          <div style={{ color:T.muted, fontSize:11, marginBottom:10, textTransform:'uppercase', letterSpacing:'0.09em' }}>Account Size</div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            {SIZES.map(s => (
              <button key={s} onClick={() => setLoc(p => ({ ...p, size:s }))} style={{ padding:'7px 14px', borderRadius:8, cursor:'pointer', border:`1px solid ${loc.size===s?T.amber:'rgba(255,255,255,0.1)'}`, background:loc.size===s?`${T.amber}1A`:'rgba(255,255,255,0.02)', color:loc.size===s?T.amber:T.sub, fontSize:13, fontWeight:600 }}>
                ${s.toLocaleString()}
              </button>
            ))}
          </div>
        </div>
        <div className="pp-log-grid" style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:24 }}>
          {[['currentPnL','Current P&L ($)'],['todayPnL','Today P&L ($)'],['tradingDays','Trading Days']].map(([key,label]) => (
            <div key={key}>
              <div style={{ color:T.muted, fontSize:11, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.09em' }}>{label}</div>
              <input type="number" value={loc[key]} onChange={e => setLoc(p => ({ ...p, [key]:+e.target.value }))} style={inp} />
            </div>
          ))}
        </div>
        <div style={{ display:'flex', gap:12 }}>
          <button onClick={onClose} style={{ flex:1, padding:12, background:'rgba(255,255,255,0.05)', border:`1px solid ${T.border}`, borderRadius:10, color:T.sub, fontSize:14, fontWeight:600, cursor:'pointer' }}>Cancel</button>
          <button onClick={() => { setAccount(loc); onClose(); }} style={{ flex:2, padding:12, background:`linear-gradient(135deg,${T.amber},#C96000)`, border:'none', borderRadius:10, color:'#000', fontSize:14, fontWeight:900, cursor:'pointer' }}>Save Account</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LOG TRADE MODAL
// ═══════════════════════════════════════════════════════════════════════════

function LogTradeModal({ onClose, onSave }) {
  const SYMS = ['XAUUSD','EURUSD','GBPUSD','NAS100','USDJPY','GBPJPY','AUDUSD','USDCAD'];
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-GB', { day:'numeric', month:'short' });

  const [form, setForm] = useState({
    sym: 'XAUUSD', dir: 'LONG', pnl: '', rr: '', notes: '', date: dateStr, score: 75,
  });

  const inp = { width:'100%', padding:'10px 12px', background:'rgba(255,255,255,0.06)', border:`1px solid ${T.border}`, borderRadius:8, color:T.text, fontSize:14, outline:'none', boxSizing:'border-box' };
  const set = k => e => setForm(p => ({ ...p, [k]: e.target.value }));

  const handleSave = () => {
    const pnlNum = parseFloat(form.pnl);
    if (!form.pnl || isNaN(pnlNum)) { alert('Enter a P&L value'); return; }
    const trade = {
      id: Date.now(),
      date: form.date || dateStr,
      sym: form.sym,
      dir: form.dir,
      pnl: pnlNum,
      rr: form.rr || '—',
      score: form.score,
      win: pnlNum > 0,
      issue: form.notes || null,
    };
    onSave(trade);
    onClose();
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', zIndex:300, display:'flex', alignItems:'center', justifyContent:'center' }} onClick={onClose}>
      <div className="pp-modal-inner" style={{ ...card, width:480, background:'rgba(5,7,15,0.92)', border:'1px solid rgba(52,211,153,0.3)' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight:900, fontSize:18, marginBottom:4 }}>Log Trade</div>
        <div style={{ color:T.muted, fontSize:13, marginBottom:24 }}>Record a completed trade for your journal.</div>

        {/* Symbol */}
        <div style={{ marginBottom:18 }}>
          <div style={{ color:T.muted, fontSize:11, marginBottom:10, textTransform:'uppercase', letterSpacing:'0.09em' }}>Instrument</div>
          <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
            {SYMS.map(s => (
              <button key={s} onClick={() => setForm(p => ({ ...p, sym:s }))}
                style={{ padding:'6px 11px', borderRadius:8, cursor:'pointer', border:`1px solid ${form.sym===s?T.green:'rgba(255,255,255,0.1)'}`, background:form.sym===s?`${T.green}18`:'rgba(255,255,255,0.02)', color:form.sym===s?T.green:T.sub, fontSize:12, fontWeight:600 }}>
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Direction */}
        <div style={{ marginBottom:18 }}>
          <div style={{ color:T.muted, fontSize:11, marginBottom:10, textTransform:'uppercase', letterSpacing:'0.09em' }}>Direction</div>
          <div style={{ display:'flex', gap:10 }}>
            {['LONG','SHORT'].map(d => (
              <button key={d} onClick={() => setForm(p => ({ ...p, dir:d }))}
                style={{ flex:1, padding:'10px 0', borderRadius:8, cursor:'pointer', border:`1px solid ${form.dir===d?(d==='LONG'?T.green:T.red):'rgba(255,255,255,0.1)'}`, background:form.dir===d?(d==='LONG'?`${T.green}18`:`${T.red}18`):'rgba(255,255,255,0.02)', color:form.dir===d?(d==='LONG'?T.green:T.red):T.sub, fontSize:13, fontWeight:800 }}>
                {d === 'LONG' ? '▲ LONG' : '▼ SHORT'}
              </button>
            ))}
          </div>
        </div>

        {/* P&L + R:R + Date */}
        <div className="pp-log-grid" style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:18 }}>
          <div>
            <div style={{ color:T.muted, fontSize:11, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.09em' }}>P&amp;L ($)</div>
            <input type="number" placeholder="+340 or -150" value={form.pnl} onChange={set('pnl')} style={{ ...inp }} />
          </div>
          <div>
            <div style={{ color:T.muted, fontSize:11, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.09em' }}>R:R Ratio</div>
            <input type="text" placeholder="1:2.1" value={form.rr} onChange={set('rr')} style={{ ...inp }} />
          </div>
          <div>
            <div style={{ color:T.muted, fontSize:11, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.09em' }}>Date</div>
            <input type="text" placeholder="16 Apr" value={form.date} onChange={set('date')} style={{ ...inp }} />
          </div>
        </div>

        {/* Quality Score */}
        <div style={{ marginBottom:18 }}>
          <div style={{ color:T.muted, fontSize:11, marginBottom:10, textTransform:'uppercase', letterSpacing:'0.09em' }}>
            Trade Quality Score: <span style={{ color: form.score >= 75 ? T.green : form.score >= 55 ? T.amber : T.red, fontWeight:800 }}>{form.score}/100</span>
          </div>
          <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
            {[20,35,50,65,75,85,95].map(s => (
              <button key={s} onClick={() => setForm(p => ({ ...p, score: s }))}
                style={{ padding:'5px 12px', borderRadius:7, cursor:'pointer', fontSize:12, fontWeight:700,
                  border:`1px solid ${form.score===s?(s>=75?T.green:s>=55?T.amber:T.red):'rgba(255,255,255,0.1)'}`,
                  background:form.score===s?(s>=75?`${T.green}20`:s>=55?`${T.amber}20`:`${T.red}20`):'rgba(255,255,255,0.02)',
                  color:form.score===s?(s>=75?T.green:s>=55?T.amber:T.red):T.sub }}>
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Notes */}
        <div style={{ marginBottom:24 }}>
          <div style={{ color:T.muted, fontSize:11, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.09em' }}>Notes / Issues (optional)</div>
          <textarea value={form.notes} onChange={set('notes')} placeholder="e.g. FOMO entry, chased the move after breakout…" rows={3}
            style={{ ...inp, resize:'vertical', lineHeight:1.6 }}/>
        </div>

        <div style={{ display:'flex', gap:12 }}>
          <button onClick={onClose} style={{ flex:1, padding:12, background:'rgba(255,255,255,0.05)', border:`1px solid ${T.border}`, borderRadius:10, color:T.sub, fontSize:14, fontWeight:600, cursor:'pointer' }}>Cancel</button>
          <button onClick={handleSave} style={{ flex:2, padding:12, background:`linear-gradient(135deg,${T.green},#059669)`, border:'none', borderRadius:10, color:'#000', fontSize:14, fontWeight:900, cursor:'pointer' }}>+ Save Trade</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════

function Dashboard({ account, phase }) {
  const [candles,  setCandles]  = useState([]);
  const [prices,   setPrices]   = useState({});
  const [news,     setNews]     = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [signals,  setSignals]  = useState({});
  const [aiRead,   setAiRead]   = useState('');

  const fetchCandles = useCallback(async () => {
    try {
      const cvt = await mdFetchOHLCV('XAU/USD', '1h', 50);
      setCandles(cvt.map(c => ({ t: (c.t || '').slice(11, 16), v: c.v })));
    } catch {}
  }, []);

  const fetchPrices = useCallback(async () => {
    try {
      const pm = await mdFetchPrices(['XAU/USD','EUR/USD','GBP/USD','USD/JPY']);
      const valid = Object.fromEntries(Object.entries(pm).filter(([,v]) => v != null));
      if (Object.keys(valid).length) setPrices(valid);
    } catch {}
  }, []);

  const fetchCalendar = useCallback(async () => {
    const CACHE_KEY = 'ff_cal_v2';
    const cached = LS.get(CACHE_KEY, null);
    if (cached && (Date.now() - cached.ts) < 3_600_000) { setNews(cached.data); return; }
    try {
      const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json?version=9');
      if (!r.ok) throw new Error('fetch');
      const data = await r.json();
      if (!Array.isArray(data)) throw new Error('bad');
      const todayISO = new Date().toISOString().slice(0, 10);
      const todayEvts = data.filter(e => e.date?.startsWith(todayISO) && ['High','Medium'].includes(e.impact));
      LS.set(CACHE_KEY, { data: todayEvts, ts: Date.now() });
      setNews(todayEvts);
    } catch {
      setNews([{ impact:'High', title:'CPI / NFP — check ForexFactory', country:'USD', time:'—', date: new Date().toISOString().slice(0,10) }]);
    }
  }, []);

  const fetchSignals = useCallback(async () => {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/smc_signals?select=symbol,verdict,confidence,session_name,created_at&order=created_at.desc&limit=60`, { headers: SB_HDR });
      const d = await r.json();
      if (Array.isArray(d)) {
        const latest = {};
        for (const s of d) { if (!latest[s.symbol]) latest[s.symbol] = s; }
        setSignals(latest);
      }
    } catch {}
  }, []);

  const fetchAiRead = useCallback(async () => {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/bot_memory?select=market_notes&order=run_at.desc&limit=1`, { headers: SB_HDR });
      const d = await r.json();
      if (Array.isArray(d) && d[0]?.market_notes) setAiRead(d[0].market_notes);
    } catch {}
  }, []);

  useEffect(() => {
    Promise.all([fetchCandles(), fetchPrices(), fetchCalendar(), fetchSignals(), fetchAiRead()]).finally(() => setLoading(false));
    const priceTimer   = setInterval(fetchPrices,   15000);
    const candleTimer  = setInterval(fetchCandles,  60000);
    const signalTimer  = setInterval(fetchSignals,  60000);
    const aiTimer      = setInterval(fetchAiRead,   120000);
    return () => { clearInterval(priceTimer); clearInterval(candleTimer); clearInterval(signalTimer); clearInterval(aiTimer); };
  }, [fetchCandles, fetchPrices, fetchCalendar, fetchSignals, fetchAiRead]);

  const ph        = PHASES[phase];
  const dailyLim  = account.size * ph.dailyLimit;
  const dailyUsed = Math.abs(account.todayPnL);
  const dailyUsedP = dailyUsed / dailyLim * 100;
  const allowRisk = Math.min(dailyLim - dailyUsed, account.size * 0.01);

  const verdict = dailyUsedP < 40 ? 'GO' : dailyUsedP < 70 ? 'CAUTION' : 'STOP';
  const vc = verdict === 'GO' ? T.green : verdict === 'CAUTION' ? T.yellow : T.red;

  const xauPrice = prices['XAU/USD'] ? fmtPrice('XAU/USD', prices['XAU/USD']) : '—';

  const INSTRUMENTS = [
    { key:'XAU/USD', label:'XAU/USD 🥇', def:'—' },
    { key:'EUR/USD', label:'EUR/USD €',   def:'—' },
    { key:'GBP/USD', label:'GBP/USD £',   def:'—' },
    { key:'NAS100',  label:'NAS100 📈',   def:'—' },
    { key:'BTC/USD', label:'BTC/USD ₿',   def:'—' },
  ].map(i => ({ ...i, sig: signals[i.key] ? (VERDICT_LABEL[signals[i.key].verdict] || signals[i.key].verdict) : (loading ? '…' : '—') }));
  const sigColor = s => s === 'LONG' ? T.green : s === 'SHORT' ? T.red : s === 'WAIT' ? T.yellow : T.muted;
  const validSetups = Object.values(signals).filter(s => s.verdict === 'LONG_NOW' || s.verdict === 'SHORT_NOW').length;

  return (
    <div>
      {/* Pre-Session Brief */}
      <div style={{ ...card, marginBottom:24, background:`${vc}07`, border:`1px solid ${vc}28` }}>
        <div className="pp-brief-inner" style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:24 }}>
          <div style={{ flex:1 }}>
            <div style={{ color:T.muted, fontSize:11, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:10 }}>
              Pre-Session Brief · {new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:20, marginBottom:12 }}>
              <div style={{ fontSize:40, fontWeight:900, color:vc, minWidth:90 }}>{verdict}</div>
              <p style={{ color:T.sub, fontSize:14, lineHeight:1.65, margin:0 }}>
                {verdict === 'GO'      && 'Daily buffer healthy. Market structure supports trading. XAUUSD and GBPUSD show valid setups.'}
                {verdict === 'CAUTION' && 'Daily buffer over 40% used. Reduce size. Only take A+ setups today.'}
                {verdict === 'STOP'    && 'Daily loss limit nearly reached. No new trades. Protect what remains.'}
              </p>
            </div>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              {Object.keys(signals).length > 0
                ? Object.entries(signals).map(([sym, s]) => {
                    const lbl = VERDICT_LABEL[s.verdict] || s.verdict;
                    const col = lbl === 'LONG' ? T.green : lbl === 'SHORT' ? T.red : lbl === 'WAIT' ? T.yellow : T.muted;
                    const icon = lbl === 'LONG' ? ' ✓' : lbl === 'SHORT' ? ' ✗' : '';
                    return <Badge key={sym} label={`${sym.replace('/USD','').replace('/','').slice(0,6)} — ${lbl}${icon}`} color={col} />;
                  })
                : <Badge label={loading ? 'Loading signals…' : 'No daemon signals yet'} color={T.muted} />
              }
            </div>
          </div>
          <div className="pp-brief-stats" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, minWidth:240 }}>
            {[
              { lbl:'Daily Buffer', val:`$${(dailyLim-dailyUsed).toLocaleString()}`, vc:T.green },
              { lbl:'Allowed Risk', val:`$${allowRisk.toFixed(0)}`,                  vc:T.amber },
              { lbl:'Live Prices',  val: loading ? 'Loading…' : 'LIVE',             vc: loading ? T.muted : T.green },
              { lbl:'Valid Setups', val: String(validSetups),                          vc: validSetups > 0 ? T.green : T.muted },
            ].map(st => (
              <div key={st.lbl} style={{ ...cardS, textAlign:'center', padding:12 }}>
                <div style={{ color:T.muted, fontSize:11 }}>{st.lbl}</div>
                <div style={{ color:st.vc, fontWeight:800, fontSize:15, marginTop:4 }}>{st.val}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Stat strip */}
      <div className="pp-grid-4" style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:16, marginBottom:24 }}>
        {[
          { lbl:'Current P&L',  val:`+$${account.currentPnL.toLocaleString()}`, sub:`+${(account.currentPnL/account.size*100).toFixed(2)}% of target`, vc:T.green  },
          { lbl:"Today's P&L",  val:`-$${Math.abs(account.todayPnL)}`,          sub:`${dailyUsedP.toFixed(0)}% of daily limit`,                         vc:T.red    },
          { lbl:'Trading Days', val:`${account.tradingDays} / ${ph.minDays||'—'}`, sub: ph.minDays && account.tradingDays < ph.minDays ? `${ph.minDays-account.tradingDays} more needed` : '✓ Met', vc: ph.minDays && account.tradingDays < ph.minDays ? T.yellow : T.green },
          { lbl:'Session Mode', val: verdict === 'GO' ? 'NORMAL' : verdict, sub:'Based on daily P&L', vc },
        ].map(st => (
          <div key={st.lbl} style={{ ...cardS }}>
            <div style={{ color:T.muted, fontSize:11, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.09em' }}>{st.lbl}</div>
            <div style={{ fontSize:24, fontWeight:800, color:st.vc }}>{st.val}</div>
            <div style={{ color:T.muted, fontSize:12, marginTop:4 }}>{st.sub}</div>
          </div>
        ))}
      </div>

      {/* Chart + sidebar */}
      <div className="pp-grid-2l" style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:24 }}>
        <div style={{ ...card }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, flexWrap:'wrap', gap:10 }}>
            <div>
              <span style={{ fontWeight:800, fontSize:20 }}>XAU / USD</span>
              <span style={{ color:T.muted, marginLeft:12, fontSize:13 }}>H1 · {loading ? 'Loading…' : 'Live'}</span>
            </div>
            <div style={{ display:'flex', gap:10, alignItems:'center' }}>
              <Badge label="BULLISH STRUCTURE" color={T.green} />
              <div style={{ width:8, height:8, borderRadius:4, background: loading ? T.yellow : T.green, boxShadow:`0 0 8px ${loading ? T.yellow : T.green}` }} />
            </div>
          </div>

          <div style={{ fontSize:34, fontWeight:900, marginBottom:4 }}>
            {xauPrice}
            {prices['XAU/USD'] && candles.length > 1 && (
              <span style={{ fontSize:15, color: candles[candles.length-1]?.c >= candles[0]?.c ? T.green : T.red, fontWeight:600, marginLeft:12 }}>
                {candles[candles.length-1]?.c >= candles[0]?.c ? '+' : ''}{((candles[candles.length-1]?.c - candles[0]?.c) / candles[0]?.c * 100).toFixed(2)}%
              </span>
            )}
          </div>

          {candles.length > 0 ? (
            <div style={{ width:'100%', height:170 }}>
              <PriceChart data={candles}/>
            </div>
          ) : (
            <div style={{ height:170, display:'flex', alignItems:'center', justifyContent:'center', color:T.muted, fontSize:14 }}>
              {loading ? 'Loading live data from Yahoo Finance…' : 'Chart data unavailable'}
            </div>
          )}

          <div style={{ marginTop:16, padding:'12px 16px', background:'rgba(129,140,248,0.06)', border:'1px solid rgba(129,140,248,0.18)', borderRadius:10 }}>
            <div style={{ fontSize:11, color:T.indigo, fontWeight:700, marginBottom:6, letterSpacing:'0.08em' }}>🧠 AI MARKET READ · Groq Llama 3.3</div>
            <p style={{ color:T.sub, fontSize:13, lineHeight:1.75, margin:0 }}>
              {aiRead || (loading ? 'Loading AI analysis…' : 'Waiting for daemon session summary. Run daemon to generate analysis.')}
            </p>
          </div>
        </div>

        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {INSTRUMENTS.map(m => {
            const livePrice = prices[m.key];
            const displayPrice = livePrice ? fmtPrice(m.key, livePrice) : m.def;
            return (
              <div key={m.key} style={{ ...cardS, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div>
                  <div style={{ fontWeight:700, fontSize:14 }}>{m.label}</div>
                  <div style={{ color:T.muted, fontSize:12, marginTop:2, display:'flex', alignItems:'center', gap:6 }}>
                    {displayPrice}
                    {livePrice && <span style={{ width:5, height:5, borderRadius:3, background:T.green, display:'inline-block' }}/>}
                  </div>
                </div>
                <Badge label={m.sig} color={sigColor(m.sig)}/>
              </div>
            );
          })}

          <div style={{ ...cardS, flex:1 }}>
            <div style={{ fontSize:11, color:T.muted, marginBottom:14, textTransform:'uppercase', letterSpacing:'0.09em' }}>News Impact</div>
            {(news.length > 0 ? news : [
              { impact:'HIGH', title:'Loading calendar…', currency:'—', dateLabel:'—' }
            ]).slice(0,4).map((n,i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', paddingBottom:10, marginBottom:10, borderBottom: i < 3 ? `1px solid ${T.border}` : 'none' }}>
                <div style={{ flex:1, marginRight:8 }}>
                  <div style={{ fontSize:12, fontWeight:600 }}>{n.title}</div>
                  <div style={{ fontSize:11, color:T.muted }}>{n.currency} · {n.dateLabel || n.date}</div>
                </div>
                <Badge label={n.impact} color={n.impact==='HIGH' ? T.red : T.yellow}/>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CHALLENGE MODE — FULL PROP TRADING OS
// ═══════════════════════════════════════════════════════════════════════════

function ChallengeSetupWizard({ onSave }) {
  const [step,    setStep]    = useState(0); // 0=firm 1=type 2=size 3=confirm
  const [firmId,  setFirmId]  = useState(null);
  const [typeId,  setTypeId]  = useState(null);
  const [size,    setSize]    = useState(null);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [curPnl,  setCurPnl]  = useState(0);
  const [tradeDays, setTradeDays] = useState(0);
  const [curPhase, setCurPhase] = useState(0);

  const firm  = firmId  ? PROP_FIRMS[firmId]  : null;
  const type  = (firm && typeId) ? firm.types[typeId] : null;

  const inp = { width:'100%', padding:'10px 14px', background:'rgba(255,255,255,0.06)', border:`1px solid ${T.border}`, borderRadius:9, color:T.text, fontSize:14, outline:'none', boxSizing:'border-box' };

  const canNext = [firmId, typeId, size].slice(0, step+1).every(Boolean);

  const handleSave = () => {
    onSave({ firmId, typeId, size, startDate, curPnl:+curPnl, tradeDays:+tradeDays, curPhaseIdx:+curPhase });
  };

  return (
    <div style={{ maxWidth:820, margin:'0 auto' }}>
      {/* Header */}
      <div style={{ ...card, marginBottom:28, background:'rgba(245,166,35,0.04)', border:'1px solid rgba(245,166,35,0.2)' }}>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          <div style={{ fontSize:40 }}>🚀</div>
          <div>
            <div style={{ fontWeight:900, fontSize:22, marginBottom:4 }}>Set Up Your Challenge</div>
            <div style={{ color:T.sub, fontSize:14 }}>Configure your prop firm challenge to unlock full tracking, risk limits & rules engine.</div>
          </div>
        </div>
        {/* Progress steps */}
        <div style={{ display:'flex', gap:0, marginTop:22, borderTop:`1px solid ${T.border}`, paddingTop:20 }}>
          {['Firm','Type','Account','Start'].map((s,i) => (
            <div key={s} style={{ flex:1, display:'flex', alignItems:'center' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, flex:1 }}>
                <div style={{ width:28, height:28, borderRadius:14, background: i<step ? T.green : i===step ? T.amber : 'rgba(255,255,255,0.08)', color: i<=step ? '#000' : T.muted, display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:800, flexShrink:0, transition:'all 0.3s' }}>
                  {i < step ? '✓' : i+1}
                </div>
                <span style={{ color: i<=step ? T.text : T.muted, fontSize:13, fontWeight: i===step ? 700 : 400 }}>{s}</span>
              </div>
              {i < 3 && <div style={{ width:24, height:2, background: i<step ? T.green : T.border, borderRadius:1, flexShrink:0, marginRight:8 }}/>}
            </div>
          ))}
        </div>
      </div>

      {/* Step 0: Choose Firm */}
      {step === 0 && (
        <div style={{ ...card }}>
          <div style={{ fontWeight:800, fontSize:17, marginBottom:20 }}>Select Prop Firm</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
            {Object.entries(PROP_FIRMS).map(([id, f]) => (
              <button key={id} onClick={() => { setFirmId(id); setTypeId(null); setSize(null); }}
                style={{ padding:'18px 16px', borderRadius:12, cursor:'pointer', border:`2px solid ${firmId===id ? f.color : T.border}`, background: firmId===id ? `${f.color}15` : 'rgba(255,255,255,0.02)', color:T.text, textAlign:'left', transition:'all 0.2s' }}>
                <div style={{ fontSize:24, marginBottom:8 }}>{f.logo}</div>
                <div style={{ fontWeight:800, fontSize:15, color: firmId===id ? f.color : T.text }}>{f.name}</div>
                <div style={{ color:T.muted, fontSize:12, marginTop:4 }}>
                  ${Math.min(...f.sizes).toLocaleString()} – ${Math.max(...f.sizes).toLocaleString()}
                </div>
                <div style={{ color:T.muted, fontSize:11, marginTop:2 }}>{Object.keys(f.types).length} plan{Object.keys(f.types).length>1?'s':''}</div>
              </button>
            ))}
          </div>
          <button disabled={!firmId} onClick={() => setStep(1)} style={{ marginTop:20, width:'100%', padding:13, border:'none', borderRadius:10, cursor:firmId?'pointer':'not-allowed', background:firmId?`linear-gradient(135deg,${T.amber},#C96000)`:'rgba(255,255,255,0.05)', color:firmId?'#000':T.muted, fontSize:14, fontWeight:800 }}>
            Next: Choose Plan →
          </button>
        </div>
      )}

      {/* Step 1: Choose Type */}
      {step === 1 && firm && (
        <div style={{ ...card }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:20 }}>
            <span style={{ fontSize:26 }}>{firm.logo}</span>
            <div style={{ fontWeight:800, fontSize:17 }}>{firm.name} — Choose Plan</div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:14 }}>
            {Object.entries(firm.types).map(([id, t]) => {
              const phases = t.phases;
              const lastPhase = phases[phases.length-1];
              const split = t.rules[lastPhase]?.split;
              return (
                <button key={id} onClick={() => setTypeId(id)}
                  style={{ padding:'20px 18px', borderRadius:12, cursor:'pointer', border:`2px solid ${typeId===id ? firm.color : T.border}`, background: typeId===id ? `${firm.color}12` : 'rgba(255,255,255,0.02)', color:T.text, textAlign:'left', transition:'all 0.2s' }}>
                  <div style={{ fontWeight:800, fontSize:16, color: typeId===id ? firm.color : T.text, marginBottom:10 }}>{t.label}</div>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:12 }}>
                    {phases.map((p,i) => <span key={p} style={{ background:`${firm.color}20`, color:firm.color, border:`1px solid ${firm.color}40`, borderRadius:5, padding:'2px 8px', fontSize:11, fontWeight:700 }}>{i+1}. {p}</span>)}
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                    {Object.entries(t.rules['Step 1'] || t.rules[phases[0]] || {}).filter(([k]) => ['target','daily','maxDD','minDays','split'].includes(k)).slice(0,4).map(([k,v]) => (
                      <div key={k} style={{ fontSize:11, color:T.sub }}>
                        <span style={{ color:T.muted }}>{k==='target'?'Target':k==='daily'?'Daily DD':k==='maxDD'?'Max DD':k==='minDays'?'Min Days':'Split'}: </span>
                        <strong>{v===null?'—':typeof v==='number'&&v<1?(k==='split'?`${(v*100).toFixed(0)}%`:`${(v*100).toFixed(0)}%`):v}</strong>
                      </div>
                    ))}
                    {split && <div style={{ fontSize:11, color:T.green }}><span style={{ color:T.muted }}>Payout: </span><strong>{(split*100).toFixed(0)}%</strong></div>}
                  </div>
                </button>
              );
            })}
          </div>
          <div style={{ display:'flex', gap:12, marginTop:20 }}>
            <button onClick={() => setStep(0)} style={{ padding:'12px 24px', border:`1px solid ${T.border}`, borderRadius:10, background:'transparent', color:T.sub, fontSize:13, fontWeight:600, cursor:'pointer' }}>← Back</button>
            <button disabled={!typeId} onClick={() => setStep(2)} style={{ flex:1, padding:13, border:'none', borderRadius:10, cursor:typeId?'pointer':'not-allowed', background:typeId?`linear-gradient(135deg,${T.amber},#C96000)`:'rgba(255,255,255,0.05)', color:typeId?'#000':T.muted, fontSize:14, fontWeight:800 }}>
              Next: Account Size →
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Choose Size */}
      {step === 2 && firm && type && (
        <div style={{ ...card }}>
          <div style={{ fontWeight:800, fontSize:17, marginBottom:20 }}>{firm.name} {type.label} — Account Size</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:20 }}>
            {firm.sizes.filter(s => type.price[s]).map(s => {
              const price = type.price[s];
              return (
                <button key={s} onClick={() => setSize(s)}
                  style={{ padding:'16px 12px', borderRadius:11, cursor:'pointer', border:`2px solid ${size===s ? firm.color : T.border}`, background: size===s ? `${firm.color}15` : 'rgba(255,255,255,0.02)', color:T.text, textAlign:'center', transition:'all 0.2s' }}>
                  <div style={{ fontWeight:900, fontSize:18, color: size===s ? firm.color : T.text }}>${s.toLocaleString()}</div>
                  <div style={{ color:T.muted, fontSize:12, marginTop:6 }}>Fee: <span style={{ color:T.amber, fontWeight:700 }}>${price}</span></div>
                  <div style={{ color:T.muted, fontSize:11, marginTop:3 }}>
                    Target: ${(s * (Object.values(type.rules)[0]?.target || 0)).toLocaleString()}
                  </div>
                </button>
              );
            })}
          </div>
          {size && (
            <div style={{ padding:'14px 16px', background:'rgba(245,166,35,0.06)', border:'1px solid rgba(245,166,35,0.2)', borderRadius:10, marginBottom:16 }}>
              <div style={{ fontWeight:700, fontSize:14, color:T.amber, marginBottom:10 }}>Challenge Summary</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
                {Object.entries(type.rules).map(([phase, rules]) => (
                  <div key={phase} style={{ padding:'10px 12px', background:'rgba(255,255,255,0.03)', borderRadius:8, border:`1px solid ${T.border}` }}>
                    <div style={{ fontWeight:700, fontSize:12, color:firm.color, marginBottom:6 }}>{phase}</div>
                    {rules.target  != null && <div style={{ fontSize:11, color:T.sub }}>Target: <strong style={{ color:T.text }}>${(size*rules.target).toLocaleString()}</strong></div>}
                    {rules.daily   != null && <div style={{ fontSize:11, color:T.sub }}>Daily max: <strong style={{ color:T.text }}>${(size*rules.daily).toLocaleString()}</strong></div>}
                    <div style={{ fontSize:11, color:T.sub }}>Max DD: <strong style={{ color:T.text }}>${(size*rules.maxDD).toLocaleString()}</strong></div>
                    {rules.minDays != null && <div style={{ fontSize:11, color:T.sub }}>Min days: <strong style={{ color:T.text }}>{rules.minDays}</strong></div>}
                    {rules.split   != null && <div style={{ fontSize:11, color:T.green }}>Payout split: <strong>{(rules.split*100).toFixed(0)}%</strong></div>}
                    <div style={{ fontSize:10, color:T.muted, marginTop:4 }}>{rules.newsBlock?'⚠ News block':'✓ News OK'} · {rules.weekend?'✓ Weekend OK':'✗ No weekend'}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ display:'flex', gap:12 }}>
            <button onClick={() => setStep(1)} style={{ padding:'12px 24px', border:`1px solid ${T.border}`, borderRadius:10, background:'transparent', color:T.sub, fontSize:13, fontWeight:600, cursor:'pointer' }}>← Back</button>
            <button disabled={!size} onClick={() => setStep(3)} style={{ flex:1, padding:13, border:'none', borderRadius:10, cursor:size?'pointer':'not-allowed', background:size?`linear-gradient(135deg,${T.amber},#C96000)`:'rgba(255,255,255,0.05)', color:size?'#000':T.muted, fontSize:14, fontWeight:800 }}>
              Next: Start Date →
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Confirm + current progress */}
      {step === 3 && firm && type && size && (
        <div style={{ ...card }}>
          <div style={{ fontWeight:800, fontSize:17, marginBottom:20 }}>Configure & Start</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:20 }}>
            <div>
              <div style={{ color:T.muted, fontSize:11, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.09em' }}>Challenge Start Date</div>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ ...inp }}/>
            </div>
            <div>
              <div style={{ color:T.muted, fontSize:11, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.09em' }}>Current Phase</div>
              <select value={curPhase} onChange={e => setCurPhase(e.target.value)} style={{ ...inp, cursor:'pointer' }}>
                {type.phases.map((p,i) => <option key={p} value={i}>{p}</option>)}
              </select>
            </div>
            <div>
              <div style={{ color:T.muted, fontSize:11, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.09em' }}>Current P&L ($)</div>
              <input type="number" value={curPnl} onChange={e => setCurPnl(e.target.value)} placeholder="0" style={{ ...inp }}/>
            </div>
            <div>
              <div style={{ color:T.muted, fontSize:11, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.09em' }}>Trading Days Completed</div>
              <input type="number" value={tradeDays} onChange={e => setTradeDays(e.target.value)} placeholder="0" style={{ ...inp }}/>
            </div>
          </div>
          <div style={{ padding:'14px 18px', background:'rgba(52,211,153,0.06)', border:'1px solid rgba(52,211,153,0.2)', borderRadius:10, marginBottom:20 }}>
            <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
              <div><span style={{ color:T.muted, fontSize:12 }}>Firm: </span><strong style={{ color:firm.color }}>{firm.name}</strong></div>
              <div><span style={{ color:T.muted, fontSize:12 }}>Plan: </span><strong>{type.label}</strong></div>
              <div><span style={{ color:T.muted, fontSize:12 }}>Size: </span><strong style={{ color:T.amber }}>${size.toLocaleString()}</strong></div>
              <div><span style={{ color:T.muted, fontSize:12 }}>Fee: </span><strong>${type.price[size]}</strong></div>
            </div>
          </div>
          <div style={{ display:'flex', gap:12 }}>
            <button onClick={() => setStep(2)} style={{ padding:'12px 24px', border:`1px solid ${T.border}`, borderRadius:10, background:'transparent', color:T.sub, fontSize:13, fontWeight:600, cursor:'pointer' }}>← Back</button>
            <button onClick={handleSave} style={{ flex:1, padding:13, border:'none', borderRadius:10, cursor:'pointer', background:`linear-gradient(135deg,${T.green},#059669)`, color:'#000', fontSize:14, fontWeight:900 }}>
              🚀 Start Challenge Tracker
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChallengeTracker({ cfg, account, onReset, userId }) {
  const firm    = PROP_FIRMS[cfg.firmId];
  const type    = firm.types[cfg.typeId];
  const phases  = type.phases;
  const [phaseIdx, setPhaseIdx] = useState(cfg.curPhaseIdx || 0);
  const [curPnl,   setCurPnl]   = useState(cfg.curPnl || 0);
  const [tradeDays,setTradeDays] = useState(cfg.tradeDays || 0);
  const [todayPnl, setTodayPnl] = useState(() => LS.get('ch_todaypnl_'+cfg.firmId, 0));
  const [editing,  setEditing]   = useState(false);

  useEffect(() => { LS.set('ch_todaypnl_'+cfg.firmId, todayPnl); }, [todayPnl, cfg.firmId]);

  const phaseName = phases[phaseIdx];
  const rules     = type.rules[phaseName] || {};
  const isFunded  = phaseIdx === phases.length - 1 && rules.split != null;
  const size      = cfg.size;

  const targetAmt  = rules.target ? size * rules.target : null;
  const dailyLim   = rules.daily  ? size * rules.daily  : null;
  const maxDD      = size * rules.maxDD;
  const dailyUsed  = Math.abs(todayPnl < 0 ? todayPnl : 0);
  const pnlPct     = curPnl / size * 100;
  const progress   = targetAmt ? Math.min(curPnl / targetAmt * 100, 100) : null;
  const daysNeeded = rules.minDays;
  const dailyLeft  = dailyLim ? dailyLim - dailyUsed : null;
  const allowRisk  = dailyLeft != null ? Math.min(dailyLeft, size * 0.01) : size * 0.01;

  const dayUsedPct = dailyLim ? (dailyUsed / dailyLim * 100) : 0;
  const dayMode    = dayUsedPct < 40 ? { l:'NORMAL',    c:T.green  }
                   : dayUsedPct < 70 ? { l:'CAUTION',   c:T.yellow }
                   : dayUsedPct < 90 ? { l:'DEFENSIVE', c:T.red    }
                   :                   { l:'STOP',       c:'#EF4444'};

  // Days elapsed since start
  const start   = new Date(cfg.startDate);
  const today   = new Date();
  const elapsed = Math.floor((today - start) / 86400000);

  // Build mini calendar (last 21 days)
  const calDays = Array.from({ length:21 }, (_,i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (20 - i));
    const isWeekend = [0,6].includes(d.getDay());
    const isTdy  = d.toDateString() === today.toDateString();
    const inChal = d >= start;
    return { d, isWeekend, isTdy, inChal };
  });

  const inp2 = { padding:'8px 12px', background:'rgba(255,255,255,0.06)', border:`1px solid ${T.border}`, borderRadius:8, color:T.text, fontSize:14, outline:'none', width:'100%', boxSizing:'border-box' };

  // ── Can I Trade Today? banner ───────────────────────────────────────────
  const allTodayTrades  = LS.get('trades', []);
  const todayStr2       = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short' });
  const todayPnlChk     = allTodayTrades.filter(t => t.date === todayStr2).reduce((s,t) => s + (t.pnl||0), 0);
  const todayLossChk    = Math.abs(Math.min(0, todayPnlChk));
  const dayUsedPctBanner= dailyLim ? (todayLossChk / dailyLim) * 100 : 0;
  const maxDDUsedBanner = Math.abs(Math.min(0, curPnl));
  const maxDDPctBanner  = (maxDD > 0) ? (maxDDUsedBanner / maxDD) * 100 : 0;
  const tradeBanner = (() => {
    if (dailyLim && todayLossChk >= dailyLim * 0.99)
      return { verdict:'STOP',    color:T.red,   icon:'🛑', msg:'Daily loss limit reached. No more trades today.' };
    if (maxDDUsedBanner >= maxDD * 0.99)
      return { verdict:'STOP',    color:T.red,   icon:'🛑', msg:'Max drawdown breached. Stop trading immediately.' };
    if (dailyLim && dayUsedPctBanner >= 70)
      return { verdict:'CAREFUL', color:T.amber, icon:'⚠️', msg:`${(100-dayUsedPctBanner).toFixed(0)}% of daily limit left. Reduce position size.` };
    if (maxDDPctBanner >= 60)
      return { verdict:'CAREFUL', color:T.amber, icon:'⚠️', msg:'Approaching max drawdown. Only top-grade setups.' };
    return { verdict:'YES', color:T.green, icon:'✅',
      msg: dailyLim ? `$${(dailyLim - todayLossChk).toFixed(0)} daily budget remaining.` : 'No limits hit. Clear to trade.' };
  })();

  return (
    <div style={{ maxWidth:980, margin:'0 auto' }}>

      {/* ── CAN I TRADE TODAY? BANNER ── */}
      <div style={{
        display:'flex', alignItems:'center', gap:20, padding:'18px 24px', borderRadius:14, marginBottom:24, flexWrap:'wrap', justifyContent:'space-between',
        background: tradeBanner.verdict === 'YES' ? 'rgba(16,185,129,0.07)' : tradeBanner.verdict === 'CAREFUL' ? 'rgba(245,166,35,0.07)' : 'rgba(239,68,68,0.08)',
        border: `1.5px solid ${tradeBanner.verdict === 'YES' ? 'rgba(16,185,129,0.3)' : tradeBanner.verdict === 'CAREFUL' ? 'rgba(245,166,35,0.35)' : 'rgba(239,68,68,0.4)'}`,
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <div style={{ fontSize:36 }}>{tradeBanner.icon}</div>
          <div>
            <div style={{ fontSize:10, color:T.muted, fontWeight:800, letterSpacing:'.1em', textTransform:'uppercase', marginBottom:4 }}>Can I Trade Today?</div>
            <div style={{ fontSize:26, fontWeight:900, color:tradeBanner.color, lineHeight:1 }}>{tradeBanner.verdict}</div>
          </div>
        </div>
        <div style={{ color:T.sub, fontSize:13, lineHeight:1.6, flex:1, minWidth:200 }}>{tradeBanner.msg}</div>
        <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
          {dailyLim && (
            <div style={{ textAlign:'center', padding:'8px 14px', background:'rgba(255,255,255,0.04)', borderRadius:9, border:`1px solid ${T.border}` }}>
              <div style={{ color:T.muted, fontSize:10, fontWeight:700, letterSpacing:'.07em' }}>DAILY USED</div>
              <div style={{ color: dayUsedPctBanner > 70 ? T.red : T.amber, fontWeight:800, fontSize:16 }}>{dayUsedPctBanner.toFixed(0)}%</div>
            </div>
          )}
          <div style={{ textAlign:'center', padding:'8px 14px', background:'rgba(255,255,255,0.04)', borderRadius:9, border:`1px solid ${T.border}` }}>
            <div style={{ color:T.muted, fontSize:10, fontWeight:700, letterSpacing:'.07em' }}>MAX DD</div>
            <div style={{ color: maxDDPctBanner > 70 ? T.red : T.amber, fontWeight:800, fontSize:16 }}>{maxDDPctBanner.toFixed(0)}%</div>
          </div>
        </div>
      </div>

      {/* Firm header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24, flexWrap:'wrap', gap:12 }}>
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <div style={{ width:48, height:48, borderRadius:14, background:`${firm.color}25`, border:`2px solid ${firm.color}60`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:26 }}>
            {firm.logo}
          </div>
          <div>
            <div style={{ fontWeight:900, fontSize:20, color:firm.color }}>{firm.name}</div>
            <div style={{ color:T.sub, fontSize:13 }}>{type.label} · ${size.toLocaleString()} · Started {start.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</div>
          </div>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={() => {
            setEditing(e => !e);
            // When closing editor, sync updated progress to Supabase
            if (editing && userId) {
              const updated = { ...cfg, curPnl, tradeDays, curPhaseIdx: phaseIdx };
              LS.set('challenge', updated);
              syncChallengeToSB(userId, updated);
            }
          }} style={{ padding:'7px 16px', borderRadius:8, border:`1px solid ${T.border}`, background:'rgba(255,255,255,0.04)', color:T.sub, fontSize:13, cursor:'pointer', fontWeight:600 }}>
            {editing ? '☁️ Save & Sync' : '✎ Edit'}
          </button>
          <button onClick={onReset} style={{ padding:'7px 16px', borderRadius:8, border:'1px solid rgba(239,68,68,0.4)', background:'rgba(239,68,68,0.08)', color:'#F87171', fontSize:13, cursor:'pointer', fontWeight:600 }}>
            Reset
          </button>
        </div>
      </div>

      {/* Phase selector */}
      <div style={{ display:'flex', gap:0, marginBottom:24, background:'rgba(255,255,255,0.03)', borderRadius:12, padding:4, border:`1px solid ${T.border}` }}>
        {phases.map((p,i) => {
          const done  = i < phaseIdx;
          const active= i === phaseIdx;
          const locked= i > phaseIdx;
          return (
            <button key={p} onClick={() => setPhaseIdx(i)}
              style={{ flex:1, padding:'11px 12px', borderRadius:9, border:'none', cursor:'pointer', background: active ? firm.color : 'transparent', color: active ? '#000' : done ? T.green : T.muted, fontWeight: active ? 900 : 600, fontSize:13, transition:'all 0.2s', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
              {done && <span>✓</span>}
              {locked && <span style={{ fontSize:10 }}>🔒</span>}
              {p}
            </button>
          );
        })}
      </div>

      {/* Editable fields row */}
      {editing && (
        <div style={{ ...card, marginBottom:20, background:'rgba(255,255,255,0.03)', border:'1px solid rgba(245,166,35,0.3)' }}>
          <div style={{ fontWeight:700, fontSize:14, marginBottom:14, color:T.amber }}>✎ Update Progress</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
            <div>
              <div style={{ color:T.muted, fontSize:11, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.09em' }}>Current P&L ($)</div>
              <input type="number" value={curPnl} onChange={e => setCurPnl(+e.target.value)} style={inp2}/>
            </div>
            <div>
              <div style={{ color:T.muted, fontSize:11, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.09em' }}>Trading Days</div>
              <input type="number" value={tradeDays} onChange={e => setTradeDays(+e.target.value)} style={inp2}/>
            </div>
            <div>
              <div style={{ color:T.muted, fontSize:11, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.09em' }}>Today's P&L ($)</div>
              <input type="number" value={todayPnl} onChange={e => setTodayPnl(+e.target.value)} placeholder="−150" style={inp2}/>
            </div>
          </div>
        </div>
      )}

      {/* ── Profit Target ── */}
      {!isFunded && targetAmt ? (
        <div style={{ ...card, marginBottom:20, background:`${firm.color}06`, border:`1px solid ${firm.color}30` }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end', marginBottom:16, flexWrap:'wrap', gap:10 }}>
            <div>
              <div style={{ color:T.muted, fontSize:11, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:8 }}>Profit Target — {phaseName}</div>
              <div style={{ fontSize:44, fontWeight:900, color: curPnl >= targetAmt ? T.green : firm.color }}>
                {curPnl >= 0 ? '+' : ''}${curPnl.toLocaleString()}
              </div>
              <div style={{ color:T.sub, fontSize:14, marginTop:4 }}>
                {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}% · Target: +${targetAmt.toLocaleString()} (+{(rules.target*100).toFixed(0)}%)
              </div>
            </div>
            <div style={{ textAlign:'right' }}>
              {curPnl >= targetAmt
                ? <Badge label="✓ TARGET HIT — PASS!" color={T.green}/>
                : <Badge label={`$${(targetAmt - curPnl).toLocaleString()} remaining`} color={firm.color}/>}
            </div>
          </div>
          <div style={{ height:14, background:'rgba(255,255,255,0.07)', borderRadius:7, overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${Math.max(0,progress||0).toFixed(1)}%`, background:`linear-gradient(90deg,${firm.color}88,${firm.color})`, borderRadius:7, position:'relative', transition:'width 0.6s ease' }}>
              <div style={{ position:'absolute', right:0, top:0, width:3, height:'100%', background:firm.color, boxShadow:`0 0 14px ${firm.color}` }}/>
            </div>
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:8 }}>
            <span style={{ color:T.muted, fontSize:13 }}>$0</span>
            <span style={{ color:firm.color, fontWeight:700, fontSize:13 }}>{(progress||0).toFixed(1)}% complete</span>
            <span style={{ color:T.muted, fontSize:13 }}>+${targetAmt.toLocaleString()}</span>
          </div>
        </div>
      ) : isFunded ? (
        <div style={{ ...card, marginBottom:20, background:'rgba(52,211,153,0.04)', border:'1px solid rgba(52,211,153,0.2)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:16 }}>
            <div>
              <div style={{ fontWeight:900, fontSize:22, color:T.green, marginBottom:6 }}>✓ Funded — {phaseName}</div>
              <div style={{ color:T.sub, fontSize:14 }}>Payout split: <strong style={{ color:T.green }}>{(rules.split*100).toFixed(0)}%</strong> · Focus: consistency & protection</div>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:34, fontWeight:900, color: curPnl >= 0 ? T.green : T.red }}>{curPnl >= 0 ? '+' : ''}${curPnl.toLocaleString()}</div>
              <div style={{ color:T.muted, fontSize:13 }}>This month's P&L</div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Risk Stats Row ── */}
      <div className="pp-grid-4" style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:20 }}>
        {[
          { lbl:'Session Mode',  val: dayMode.l,          sub:'Based on today P&L',     vc: dayMode.c },
          { lbl:'Daily Remaining', val: dailyLim ? `$${(dailyLim-dailyUsed).toLocaleString()}` : '∞', sub: dailyLim ? `of $${dailyLim.toLocaleString()} limit` : 'No daily limit', vc: dayUsedPct < 70 ? T.green : T.red },
          { lbl:'Max DD Left',   val: `$${(maxDD - Math.abs(Math.min(0,curPnl))).toLocaleString()}`, sub:`of $${maxDD.toLocaleString()} limit`, vc: curPnl > -maxDD*0.6 ? T.green : curPnl > -maxDD*0.8 ? T.yellow : T.red },
          { lbl:'Allowed Risk',  val: `$${allowRisk.toFixed(0)}`, sub: `${(allowRisk/size*100).toFixed(2)}% per trade`, vc: T.amber },
        ].map(st => (
          <div key={st.lbl} style={{ ...cardS, textAlign:'center' }}>
            <div style={{ color:T.muted, fontSize:11, marginBottom:6, textTransform:'uppercase', letterSpacing:'0.08em' }}>{st.lbl}</div>
            <div style={{ fontSize:20, fontWeight:800, color:st.vc }}>{st.val}</div>
            <div style={{ color:T.muted, fontSize:11, marginTop:4 }}>{st.sub}</div>
          </div>
        ))}
      </div>

      {/* ── Bottom 3-col ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1.3fr 1fr 1.2fr', gap:18 }} className="pp-grid-3">

        {/* Risk bars */}
        <div style={{ ...card }}>
          <div style={{ fontWeight:700, fontSize:14, marginBottom:20 }}>Risk Buffers</div>
          {dailyLim && (
            <RiskBar label="Daily Loss Used" value={dailyUsed} max={dailyLim} sublabel={`$${dailyUsed.toLocaleString()} / $${dailyLim.toLocaleString()}`}/>
          )}
          <RiskBar label="Max Drawdown Used" value={Math.abs(Math.min(0,curPnl))} max={maxDD} sublabel={`$${Math.abs(Math.min(0,curPnl)).toLocaleString()} / $${maxDD.toLocaleString()}`}/>
          <div style={{ padding:'12px 16px', background:'rgba(255,255,255,0.03)', borderRadius:9, marginTop:4 }}>
            <KVRow k="Account size"     v={`$${size.toLocaleString()}`}/>
            <KVRow k="Challenge fee"    v={`$${type.price[size] || '—'}`} vc={T.muted}/>
            {rules.split && <KVRow k="Payout split" v={`${(rules.split*100).toFixed(0)}% you`} vc={T.green}/>}
          </div>
        </div>

        {/* Trading days + calendar */}
        <div style={{ ...card }}>
          <div style={{ fontWeight:700, fontSize:14, marginBottom:16 }}>Trading Days</div>
          <div style={{ textAlign:'center', marginBottom:16 }}>
            <div style={{ fontSize:52, fontWeight:900, color: daysNeeded && tradeDays >= daysNeeded ? T.green : T.text }}>{tradeDays}</div>
            {daysNeeded
              ? <div style={{ color:T.muted, fontSize:13 }}>min {daysNeeded} required</div>
              : <div style={{ color:T.muted, fontSize:13 }}>no minimum</div>}
            <div style={{ marginTop:10 }}>
              {daysNeeded
                ? <Badge label={tradeDays >= daysNeeded ? '✓ DAYS MET' : `${daysNeeded - tradeDays} MORE NEEDED`} color={tradeDays >= daysNeeded ? T.green : T.yellow}/>
                : <Badge label="FUNDED — KEEP GOING" color={T.green}/>}
            </div>
          </div>
          {/* Mini calendar */}
          <div style={{ display:'flex', flexWrap:'wrap', gap:3 }}>
            {calDays.map((cd,i) => (
              <div key={i} style={{ width:26, height:26, borderRadius:5, background: cd.isTdy ? T.amber : cd.inChal && !cd.isWeekend ? 'rgba(255,255,255,0.06)' : 'transparent', border: cd.isTdy ? `1px solid ${T.amber}` : cd.inChal ? `1px solid ${T.border}` : 'none', display:'flex', alignItems:'center', justifyContent:'center', color: cd.isTdy ? '#000' : cd.isWeekend ? T.muted : cd.inChal ? T.sub : 'transparent', fontSize:9, fontWeight:cd.isTdy?900:400 }}>
                {cd.d.getDate()}
              </div>
            ))}
          </div>
          <div style={{ color:T.muted, fontSize:11, marginTop:8 }}>
            Day {elapsed >= 0 ? elapsed + 1 : '—'} of challenge
          </div>
        </div>

        {/* Firm Rules */}
        <div style={{ ...card }}>
          <div style={{ fontWeight:700, fontSize:14, marginBottom:16 }}>
            Rules — <span style={{ color:firm.color }}>{phaseName}</span>
          </div>
          {[
            ['Profit target',    rules.target != null ? `+${(rules.target*100).toFixed(0)}%  (+$${targetAmt ? targetAmt.toLocaleString() : '—'})` : '—',  rules.target != null ? T.amber : T.muted],
            ['Daily loss limit', dailyLim != null ? `-${(rules.daily*100).toFixed(0)}%  (-$${dailyLim.toLocaleString()})` : 'None',   dailyLim != null ? T.sub : T.green],
            ['Max drawdown',     `-${(rules.maxDD*100).toFixed(0)}%  (-$${maxDD.toLocaleString()})`,  T.sub],
            ['Min trading days', daysNeeded ?? 'None',    T.sub],
            ['Weekend holding',  rules.weekend ? 'Allowed ✓' : 'Not allowed ✗',  rules.weekend ? T.green : T.red],
            ['News trading',     rules.newsBlock ? 'RESTRICTED ✗' : 'Allowed ✓',  rules.newsBlock ? T.red : T.green],
            ['EA / robots',      'Permitted ✓',  T.green],
            ['Copy trading',     'Banned ✗',     T.red],
            ['Payout split',     rules.split ? `${(rules.split*100).toFixed(0)}% / ${(100 - rules.split*100).toFixed(0)}%` : '—',  rules.split ? T.green : T.muted],
          ].map(([k,v,vc]) => <KVRow key={k} k={k} v={v} vc={vc}/>)}

          {/* Phase pass conditions */}
          {!isFunded && targetAmt && (
            <div style={{ marginTop:16, padding:'10px 14px', background:'rgba(52,211,153,0.06)', border:'1px solid rgba(52,211,153,0.2)', borderRadius:9 }}>
              <div style={{ fontSize:11, color:T.green, fontWeight:700, marginBottom:8, letterSpacing:'0.07em' }}>TO PASS {phaseName.toUpperCase()}</div>
              {[
                [`Reach +${(rules.target*100).toFixed(0)}% (+$${targetAmt.toLocaleString()})`, curPnl >= targetAmt],
                daysNeeded ? [`Trade at least ${daysNeeded} days`, tradeDays >= daysNeeded] : null,
                [`Don't hit daily loss limit`, dailyLim == null || dailyUsed < dailyLim],
                [`Don't hit max drawdown`, curPnl > -maxDD],
              ].filter(Boolean).map(([cond, met]) => (
                <div key={cond} style={{ color: met ? T.green : T.sub, fontSize:12, lineHeight:1.9 }}>
                  {met ? '✓' : '○'} {cond}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChallengeMode({ account, phase, userId }) {
  const [challenge, setChallenge] = useState(() => LS.get('challenge', null));

  useEffect(() => {
    const onChallengeUpdated = () => setChallenge(LS.get('challenge', null));
    window.addEventListener('challenge:updated', onChallengeUpdated);
    return () => window.removeEventListener('challenge:updated', onChallengeUpdated);
  }, []);
  const { show: showToast } = useToast();

  const handleSave = async (cfg) => {
    LS.set('challenge', cfg);
    setChallenge(cfg);
    // Sync to Supabase in background
    if (userId) {
      await syncChallengeToSB(userId, cfg);
      showToast('☁️ Challenge synced to cloud', 'success', 2500);
    }
  };

  const handleReset = () => {
    if (window.confirm('Reset challenge tracker? This will clear all saved progress.')) {
      LS.set('challenge', null);
      setChallenge(null);
      if (userId) syncChallengeToSB(userId, null);
    }
  };

  if (!challenge) return <ChallengeSetupWizard onSave={handleSave}/>;
  return <ChallengeTracker cfg={challenge} account={account} onReset={handleReset} userId={userId}/>;
}

function parseTradeDateForChallenge(label) {
  if (!label) return null;
  const currentYear = new Date().getFullYear();
  const d = new Date(`${label} ${currentYear}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function deriveChallengeProgressFromTrades(challenge, trades) {
  if (!challenge) return null;
  const start = challenge.startDate ? new Date(challenge.startDate) : null;
  const validTrades = (trades || []).filter(t => {
    const d = parseTradeDateForChallenge(t.date);
    return d && (!start || d >= start);
  });
  const curPnl = validTrades.reduce((sum, t) => sum + safeNum(t.pnl, 0), 0);
  const tradeDays = new Set(validTrades.map(t => t.date).filter(Boolean)).size;
  const todayLabel = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short' });
  const todayPnl = validTrades
    .filter(t => t.date === todayLabel)
    .reduce((sum, t) => sum + safeNum(t.pnl, 0), 0);
  return {
    ...challenge,
    curPnl,
    tradeDays,
    lastJournalSyncAt: new Date().toISOString(),
    lastJournalTradeCount: validTrades.length,
    todayPnl,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TECHNICAL ANALYSIS ENGINE (inline, no deps)
// ═══════════════════════════════════════════════════════════════════════════

// ── Demo OHLCV generator — realistic synthetic data when API unavailable ──
const DEMO_PRICE_BASE = {
  'XAU/USD': 3320, 'EUR/USD': 1.0985, 'GBP/USD': 1.2750,
  'NAS100': 18200, 'GBP/JPY': 191.5, 'USD/JPY': 150.2,
};
function _seededRand(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function () {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function _generateDemoOHLCV(sym, bars = 200) {
  const base = DEMO_PRICE_BASE[sym] || 1.0;
  const volatility = base * 0.002; // 0.2% per bar
  const candles = [];
  const hourBucket = Math.floor(Date.now() / 3600000);
  const rand = _seededRand(`${sym}:${bars}:${hourBucket}`);
  let price = base * (0.98 + rand() * 0.04);
  // Inject a mild trend so EMA signals are interesting
  const trendDir = rand() > 0.5 ? 1 : -1;
  for (let i = 0; i < bars; i++) {
    const trend = trendDir * volatility * 0.15;
    const move = (rand() - 0.48) * volatility + trend;
    price = Math.max(base * 0.9, price + move);
    const range = volatility * (0.5 + rand() * 1.5);
    const o = price - move * 0.5;
    const h = Math.max(o, price) + rand() * range * 0.5;
    const l = Math.min(o, price) - rand() * range * 0.5;
    const ts = new Date(Date.now() - (bars - i) * 3600000).toISOString().slice(0, 16).replace('T', ' ');
    candles.push({ v: price, h, l, o, t: ts });
  }
  return candles;
}

function _ema(arr, p) {
  const k = 2/(p+1); let r = arr[0];
  for (let i=1;i<arr.length;i++) r = arr[i]*k + r*(1-k);
  return r;
}
function _emaArr(arr, p) {
  const k = 2/(p+1); const out = [arr[0]];
  for (let i=1;i<arr.length;i++) out.push(arr[i]*k + out[i-1]*(1-k));
  return out;
}
function _rsi(closes, p=14) {
  if (closes.length < p+2) return 50;
  let g=0,l=0;
  for (let i=closes.length-p;i<closes.length;i++) {
    const d=closes[i]-closes[i-1]; if(d>0)g+=d; else l+=Math.abs(d);
  }
  const ag=g/p, al=l/p;
  return al===0 ? 100 : 100 - 100/(1+ag/al);
}
function _macd(closes) {
  if (closes.length < 36) return { macd:0,signal:0,histogram:0,bullish:false,bearish:false,prevHist:0 };
  const e12=_emaArr(closes,12), e26=_emaArr(closes,26);
  const ml=e12.map((v,i)=>v-e26[i]);
  const sl=_emaArr(ml,9);
  const hist=ml.map((v,i)=>v-sl[i]);
  const n=closes.length-1;
  return { macd:ml[n], signal:sl[n], histogram:hist[n], prevHist:hist[n-1]||0,
    bullish: hist[n]>0 && hist[n]>(hist[n-1]||0),
    bearish: hist[n]<0 && hist[n]<(hist[n-1]||0) };
}
function _bb(closes, p=20) {
  if (closes.length < p) return { upper:0,middle:0,lower:0,percentB:0.5,squeeze:false };
  const sl=closes.slice(-p), sma=sl.reduce((a,b)=>a+b)/p;
  const std=Math.sqrt(sl.map(v=>(v-sma)**2).reduce((a,b)=>a+b)/p);
  const up=sma+2*std, lo=sma-2*std, cur=closes[closes.length-1];
  return { upper:up, middle:sma, lower:lo,
    percentB: std>0 ? Math.max(0,Math.min(1,(cur-lo)/(up-lo))) : 0.5,
    squeeze: std>0 ? (up-lo)/sma < 0.015 : false };
}
function _atr(candles, p=14) {
  if (candles.length < p+1) return 0;
  const trs=candles.slice(1).map((c,i)=>{
    const prev=candles[i], h=c.h||c.v, l=c.l||c.v, pc=prev.v;
    return Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
  });
  return trs.slice(-p).reduce((a,b)=>a+b)/p;
}

function _runAnalysis({ candles, dir, sym, account, phase, newsEvents }) {
  const closes = candles.map(c => parseFloat(c.v));
  const price   = closes[closes.length-1];
  const rsi     = _rsi(closes);
  const macd    = _macd(closes);
  const ema20   = _ema(closes, 20);
  const ema50   = _ema(closes, 50);
  const ema200  = closes.length >= 200 ? _ema(closes, 200) : 0;
  const bb      = _bb(closes);
  const atr     = _atr(candles);

  // ── Trend bias ──
  const bull20_50    = ema20 > ema50;
  const aboveEma20   = price > ema20;
  const aboveEma50   = price > ema50;
  const aboveEma200  = ema200 > 0 ? price > ema200 : null;
  const htfBullish   = bull20_50 && aboveEma50 && (aboveEma200 === null || aboveEma200);
  const htfBearish   = !bull20_50 && !aboveEma50 && (aboveEma200 === null || !aboveEma200);

  // ── Score ──
  let score = 0;
  const factors = [];

  // RSI
  if (rsi <= 30)      { score+=22; factors.push({ k:'RSI', v:`${rsi.toFixed(1)} — oversold`,        c:T.green }); }
  else if (rsi >= 70) { score-=22; factors.push({ k:'RSI', v:`${rsi.toFixed(1)} — overbought`,      c:T.red }); }
  else if (rsi < 45)  { score+=10; factors.push({ k:'RSI', v:`${rsi.toFixed(1)} — mild bullish`,    c:T.sub }); }
  else if (rsi > 55)  { score-=10; factors.push({ k:'RSI', v:`${rsi.toFixed(1)} — mild bearish`,    c:T.sub }); }
  else                {            factors.push({ k:'RSI', v:`${rsi.toFixed(1)} — neutral`,          c:T.muted }); }

  // MACD
  if (macd.bullish)       { score+=25; factors.push({ k:'MACD', v:'Bullish expansion',   c:T.green }); }
  else if (macd.bearish)  { score-=25; factors.push({ k:'MACD', v:'Bearish expansion',   c:T.red }); }
  else if (macd.macd > 0) { score+=12; factors.push({ k:'MACD', v:'Positive bias',       c:T.sub }); }
  else                    { score-=12; factors.push({ k:'MACD', v:'Negative bias',        c:T.sub }); }

  // EMA trend
  if (htfBullish)       { score+=28; factors.push({ k:'Structure', v:'Confirmed uptrend',       c:T.green }); }
  else if (htfBearish)  { score-=28; factors.push({ k:'Structure', v:'Confirmed downtrend',     c:T.red }); }
  else if (bull20_50)   { score+=12; factors.push({ k:'Structure', v:'Bullish, consolidating',  c:T.sub }); }
  else                  { score-=12; factors.push({ k:'Structure', v:'Bearish, consolidating',  c:T.sub }); }

  // BB
  if (bb.percentB <= 0.1)      { score+=18; factors.push({ k:'BB', v:'Lower band — oversold',   c:T.green }); }
  else if (bb.percentB >= 0.9) { score-=18; factors.push({ k:'BB', v:'Upper band — overbought', c:T.red }); }
  if (bb.squeeze)              { factors.push({ k:'BB', v:'⚡ Squeeze — breakout imminent', c:T.amber }); }

  // ── Verdict ──
  const taScore   = Math.min(100, Math.max(0, 50 + score));
  const dirMult   = dir === 'LONG' ? 1 : dir === 'SHORT' ? -1 : 0;
  const alignment = score * dirMult;
  const confidence= Math.round(Math.min(91, Math.max(38, 50 + Math.abs(alignment) * 0.55)));

  let verdict = 'WAIT';
  if (dir === 'NO BIAS')           verdict = 'NO BIAS';
  else if (alignment >= 20)        verdict = dir;
  else if (alignment <= -15)       verdict = 'NO TRADE';
  else                             verdict = 'WAIT';

  // ── News risk ──
  const symCcys = { 'XAU/USD':['USD','XAU'], 'EUR/USD':['EUR','USD'], 'GBP/USD':['GBP','USD'], 'NAS100':['USD'], 'USD/JPY':['USD','JPY'] };
  const ccys = symCcys[sym] || ['USD'];
  const now   = Date.now();
  const relevant = (newsEvents||[]).filter(ev => {
    const evMs = new Date(ev.date || ev.dateLabel || 0).getTime();
    const inWindow = Math.abs(evMs - now) < 6 * 3600000;
    return inWindow && ccys.some(c => (ev.currency||'').includes(c));
  });
  const hasHigh   = relevant.some(e => e.impact === 'HIGH');
  const hasMed    = relevant.some(e => e.impact === 'MEDIUM' || e.impact === 'MED');
  const newsRisk  = hasHigh ? 'HIGH' : hasMed ? 'MED' : 'LOW';
  const newsNote  = hasHigh
    ? `HIGH-impact event for ${ccys.join('/')} within 6 h. Size down 50% or skip.`
    : hasMed
    ? `Medium-impact news upcoming. Use standard size, avoid holding.`
    : `No major news in the window. Clean trading environment.`;

  // ── Trade parameters (ATR-based) ──
  const ph = PHASES[phase];
  const pip   = sym === 'NAS100' ? 1 : sym === 'XAU/USD' ? 0.1 : 0.0001;
  const atrPips = atr / pip;
  const slPips  = Math.round(atrPips * 1.2);
  const tp1Pips = Math.round(slPips * 2.0);
  const tp2Pips = Math.round(slPips * 3.2);
  const fmt = v => fmtPrice(sym, v);

  const slDist  = slPips * pip;
  const tp1Dist = tp1Pips * pip;
  const tp2Dist = tp2Pips * pip;
  const slPrice  = dir === 'LONG' ? price - slDist  : price + slDist;
  const tp1Price = dir === 'LONG' ? price + tp1Dist : price - tp1Dist;
  const tp2Price = dir === 'LONG' ? price + tp2Dist : price - tp2Dist;
  const entryLo  = dir === 'LONG' ? price - atr*0.3 : price;
  const entryHi  = dir === 'LONG' ? price           : price + atr*0.3;

  // ── Position size ──
  const dailyLim  = account.size * ph.dailyLimit;
  const dailyUsed = Math.abs(account.todayPnL);
  const allowRisk = Math.min(dailyLim - dailyUsed, account.size * 0.01);
  const riskDollar= hasHigh ? allowRisk * 0.5 : allowRisk;

  // ── Compliance ──
  const newsOK    = !ph.newsBlock || newsRisk !== 'HIGH';
  const bufferOK  = dailyUsed < dailyLim * 0.8;
  const compliance= (!newsOK || !bufferOK) ? 'WARNING' : 'COMPLIANT';
  const compNote  = !newsOK
    ? 'News restriction active for this phase. Wait for event to pass.'
    : !bufferOK
    ? 'Over 80% of daily buffer used. Minimum size only.'
    : `Risk $${riskDollar.toFixed(0)} — within ${(riskDollar/account.size*100).toFixed(2)}% limit.`;

  // ── Rationale ──
  const trendDir  = htfBullish ? 'bullish' : htfBearish ? 'bearish' : 'ranging';
  const sessionHr = new Date().getUTCHours();
  const session   = sessionHr >= 8 && sessionHr < 12 ? 'London open'
                  : sessionHr >= 12 && sessionHr < 17 ? 'NY session'
                  : sessionHr >= 2 && sessionHr < 8  ? 'Asian/pre-London'
                  : 'off-hours / overnight';

  const rationale = verdict === dir
    ? `${sym} shows ${trendDir} structure with ${alignment >= 35 ? 'strong' : 'moderate'} confluence. EMA ${bull20_50?'stack confirms upside':'stack confirms downside'}. RSI at ${rsi.toFixed(0)} with MACD ${macd.bullish?'expanding bullish':'in positive territory'}. Currently in ${session} — ${hasHigh?'reduce size due to nearby news':'clean window for execution'}. ATR-based SL gives ${slPips} pip buffer with ${(tp1Pips/slPips).toFixed(1)}:1 R:R to TP1.`
    : verdict === 'WAIT'
    ? `${sym} structure is ${trendDir} but not yet at optimal entry. ${dir === 'LONG' ? `Price needs to pull back to the ${fmt(entryLo)}–${fmt(entryHi)} demand zone for a valid entry.` : `Price needs to push up to the ${fmt(entryHi)}–${fmt(entryLo)} supply zone.`} RSI at ${rsi.toFixed(0)} — ${rsi > 50 ? 'still elevated, wait for reset' : 'approaching demand'}. Set an alert and wait for LTF confirmation.`
    : `${sym} structure conflicts with the ${dir} bias. EMA alignment is ${htfBullish?'bullish':htfBearish?'bearish':'unclear'} — going ${dir} here means trading against the dominant ${sessionHr > 8 ? 'institutional' : 'momentum'} flow. RSI at ${rsi.toFixed(0)}, MACD ${macd.macd > 0 ? 'positive' : 'negative'}. No structural justification for this direction.`;

  const invalidation = verdict === dir
    ? dir === 'LONG'
      ? `Close below ${fmt(slPrice)} (SL) on H1 invalidates. Watch for CHoCH below entry zone.`
      : `Close above ${fmt(slPrice)} (SL) on H1 invalidates. Watch for CHoCH above entry zone.`
    : `Wait for ${dir==='LONG'?'bullish CHoCH on H1':'bearish CHoCH on H1'} and RSI reset before re-evaluating.`;

  return {
    verdict, confidence, taScore, factors, rsi, macd, ema20, ema50, bb, atr,
    price, newsRisk, newsNote, relevant,
    entry:  verdict === dir ? `${fmt(entryLo)} – ${fmt(entryHi)}` : null,
    sl:     verdict === dir ? fmt(slPrice)  : null,
    tp1:    verdict === dir ? fmt(tp1Price) : null,
    tp2:    verdict === dir ? fmt(tp2Price) : null,
    rr1:    verdict === dir ? `1:${(tp1Pips/slPips).toFixed(1)}` : null,
    rr2:    verdict === dir ? `1:${(tp2Pips/slPips).toFixed(1)}` : null,
    riskDollar, allowRisk, compliance, compNote,
    rationale, invalidation,
    lotNote: `$${riskDollar.toFixed(0)} risk · ~${(riskDollar/(slPips*pip*100000)*100).toFixed(2)} lots`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CHECK TRADE — LIVE ANALYSIS ENGINE
// ── Shared chart component (TradingView Lightweight Charts) ──────────────
// Shows candlesticks + EMA20/50 + BB bands + SL/Entry/TP price lines
function TradeChart({ candles, levels, dir, tf }) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !candles?.length) return;
    if (!window.LightweightCharts) return;
    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; }

    const { createChart } = window.LightweightCharts;
    const chart = createChart(containerRef.current, {
      width:  containerRef.current.offsetWidth,
      height: 340,
      layout: { background:{ color:'#070810' }, textColor:'#64748B', fontSize:11 },
      grid: { vertLines:{ color:'rgba(255,255,255,0.04)' }, horzLines:{ color:'rgba(255,255,255,0.04)' } },
      crosshair: { mode:1 },
      rightPriceScale: { borderColor:'rgba(255,255,255,0.08)', scaleMargins:{ top:0.08, bottom:0.05 } },
      timeScale: { borderColor:'rgba(255,255,255,0.08)', timeVisible:true, secondsVisible:false },
      handleScroll: true, handleScale: true,
    });
    chartRef.current = chart;

    // Parse timestamps
    const iSec = tf==='1day'?86400:tf==='4h'?14400:3600;
    const parseT = (c, i) => {
      if (c.t) {
        const raw = typeof c.t==='number' ? c.t : Number(c.t);
        if (raw > 1e9 && raw < 2e10) return raw;
        if (raw > 1e12) return Math.floor(raw/1000);
        const d = new Date(c.t); if (!isNaN(d)) return Math.floor(d/1000);
      }
      return Math.floor(Date.now()/1000) - (candles.length - i) * iSec;
    };

    const seen = new Set();
    const data = candles
      .map((c, i) => ({
        time:  parseT(c, i),
        open:  parseFloat(c.o || c.v),
        high:  parseFloat(c.h || c.v),
        low:   parseFloat(c.l || c.v),
        close: parseFloat(c.v || c.c),
      }))
      .filter(d => {
        if (isNaN(d.close) || isNaN(d.time) || seen.has(d.time)) return false;
        seen.add(d.time); return true;
      })
      .sort((a, b) => a.time - b.time);

    if (!data.length) { chart.remove(); chartRef.current = null; return; }

    // Candlestick series
    const cs = chart.addCandlestickSeries({
      upColor:'#34D399', downColor:'#F87171', borderVisible:false,
      wickUpColor:'rgba(52,211,153,0.75)', wickDownColor:'rgba(248,113,113,0.75)',
    });
    cs.setData(data);

    const closes = data.map(d => d.close);
    const times  = data.map(d => d.time);

    // EMA 20
    const e20 = _emaArr(closes, 20);
    const ema20s = chart.addLineSeries({ color:'#F5A623', lineWidth:2, priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false, title:'EMA20' });
    ema20s.setData(times.slice(20).map((t, i) => ({ time:t, value:e20[i+20] })));

    // EMA 50
    const e50 = _emaArr(closes, 50);
    const ema50s = chart.addLineSeries({ color:'#818CF8', lineWidth:1.5, priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:false, title:'EMA50' });
    ema50s.setData(times.slice(50).map((t, i) => ({ time:t, value:e50[i+50] })));

    // BB upper/lower bands
    const mkBBs = () => chart.addLineSeries({ color:'rgba(99,102,241,0.4)', lineWidth:1, lineStyle:2, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
    const bbu = mkBBs(), bbl = mkBBs();
    const bbuD=[], bblD=[];
    for (let i=20; i<closes.length; i++) {
      const sl=closes.slice(i-20,i), sma=sl.reduce((a,b)=>a+b)/20;
      const std=Math.sqrt(sl.map(v=>(v-sma)**2).reduce((a,b)=>a+b)/20);
      if (times[i]) { bbuD.push({time:times[i],value:sma+2*std}); bblD.push({time:times[i],value:sma-2*std}); }
    }
    bbu.setData(bbuD); bbl.setData(bblD);

    // Price lines from levels object
    if (levels) {
      const addPL = (price, color, title, style=2) => {
        const p = typeof price==='string' ? parseFloat(price.replace(/[^0-9.]/g,'')) : parseFloat(price);
        if (!p || isNaN(p)) return;
        cs.createPriceLine({ price:p, color, lineWidth:1, lineStyle:style, axisLabelVisible:true, title });
      };
      // levels can be numeric (from signal.html) or formatted strings (from CheckTrade)
      if (levels.sl)    addPL(levels.sl,    '#F87171', '✕ SL',    2);
      if (levels.entry) addPL(levels.entry,  '#F5A623', '→ ENTRY', 0);
      if (levels.tp1)   addPL(levels.tp1,   '#34D399', '✦ TP1',   2);
      if (levels.tp2)   addPL(levels.tp2,   '#10B981', '✦ TP2',   2);
    }

    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width:containerRef.current.offsetWidth });
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [candles, levels]);

  return (
    <div style={{ position:'relative' }}>
      <div style={{ position:'absolute', top:10, left:14, display:'flex', gap:6, flexWrap:'wrap', pointerEvents:'none', zIndex:10 }}>
        {[['EMA20','#F5A623'],['EMA50','#818CF8'],['BB','rgba(99,102,241,0.65)']].map(([l,c])=>(
          <span key={l} style={{ background:'rgba(7,8,16,0.88)', padding:'3px 8px', borderRadius:5, fontSize:11, color:c, fontWeight:700 }}>{l}</span>
        ))}
        {levels && [['SL','#F87171'],['ENTRY','#F5A623'],['TP1','#34D399'],['TP2','#10B981']].map(([l,c])=>(
          <span key={l} style={{ background:'rgba(7,8,16,0.88)', padding:'3px 8px', borderRadius:5, fontSize:11, color:c, fontWeight:700, border:`1px solid ${c}30` }}>── {l}</span>
        ))}
      </div>
      <div ref={containerRef} style={{ width:'100%', overflow:'hidden' }}/>
    </div>
  );
}

// ── Log-Plan shortcut button (used inside CheckTrade result) ─────────────
function LogPlanButton({ sym, dir, r, onNavigate }) {
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    const plan = {
      sym: sym.replace('/',''),
      dir,
      entry: r.entry || '—',
      sl:    r.sl    || '—',
      tp1:   r.tp1   || '—',
      rr:    r.rr1   || '—',
      confidence: r.confidence,
      savedAt: Date.now(),
    };
    LS.set('pendingPlan', plan);
    setSaved(true);
    // Auto-navigate to Journal after short delay so user sees confirmation
    if (onNavigate) setTimeout(() => onNavigate('journal'), 900);
    else setTimeout(() => setSaved(false), 3000);
  };

  if (saved) return (
    <div style={{ padding:'10px 14px', background:'rgba(52,211,153,0.1)', border:'1px solid rgba(52,211,153,0.3)', borderRadius:9, fontSize:13, color:T.green, fontWeight:700 }}>
      ✓ Plan saved — opening Journal…
    </div>
  );

  return (
    <button onClick={handleSave}
      style={{ width:'100%', padding:'12px 0', background:`linear-gradient(135deg,rgba(52,211,153,0.15),rgba(16,185,129,0.12))`, border:'1px solid rgba(52,211,153,0.3)', borderRadius:9, color:'#34D399', fontSize:13, fontWeight:700, cursor:'pointer' }}>
      📝 Log This Trade in Journal →
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════

function CheckTrade({ account, phase, onNavigate }) {
  // Auto-fill from Signals tab ("Validate Setup" button) or Today tab
  const pendingSig = LS.get('pendingSignal', null);
  const [sym,       setSym]    = useState(() => { if (pendingSig?.sym) { LS.set('pendingSignal', null); return pendingSig.sym; } return 'XAU/USD'; });
  const [dir,          setDir]         = useState(() => pendingSig?.dir || 'LONG');
  const [loading,      setLoading]     = useState(false);
  const [result,       setResult]      = useState(null);
  const [loadStep,     setStep]        = useState('');
  const [prices,       setPrices]      = useState({});
  const [chartCandles, setChartCandles]= useState([]);

  const SYMBOLS = ['XAU/USD','EUR/USD','GBP/USD','NAS100','USD/JPY'];
  const ph        = PHASES[phase];
  const dailyLim  = account.size * ph.dailyLimit;
  const dailyUsed = Math.abs(account.todayPnL);
  const allowRisk = Math.min(dailyLim - dailyUsed, account.size * 0.01);
  const dirColor  = d => d==='LONG'?T.green:d==='SHORT'?T.red:T.yellow;

  const [demoMode, setDemoMode] = useState(false);

  // Live price via Yahoo Finance (same as Dashboard)
  useEffect(() => {
    mdFetchPrices([sym]).then(pm => {
      if (pm[sym]) setPrices(prev => ({ ...prev, [sym]: pm[sym] }));
    }).catch(() => {});
  }, [sym]);

  const livePrice = prices[sym];
  const livePriceDisplay = livePrice ? fmtPrice(sym, livePrice) : null;

  const runAnalysis = async () => {
    setLoading(true); setResult(null); setDemoMode(false);
    let newsEvents = [];
    let usedFallbackData = false;

    // ── Fetch news calendar (best-effort)
    try {
      const calR = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json?version=9');
      if (calR.ok) {
        const calData = await calR.json();
        const todayISO = new Date().toISOString().slice(0, 10);
        newsEvents = Array.isArray(calData)
          ? calData.filter(e => e.date?.startsWith(todayISO) && e.impact === 'High')
          : [];
      }
    } catch {}

    // ── Fetch OHLCV — Yahoo Finance via market-data Edge Function
    let candles = null;
    try {
      setStep('Fetching live market data…');
      candles = await mdFetchOHLCV(sym, '1h', 80);
    } catch {
      // Try 4h cache
      const CACHE_KEY = `ohlcv_${sym}_1h`;
      const cached = LS.get(CACHE_KEY, null);
      if (cached && (Date.now() - cached.ts) < 4 * 3600000) {
        candles = cached.data;
        usedFallbackData = true;
      }
    }

    // ── Final fallback: seeded synthetic data with visible warning
    if (!candles || candles.length < 20) {
      candles = _generateDemoOHLCV(sym, 80);
      usedFallbackData = true;
    }
    setDemoMode(usedFallbackData);

    setStep('Running TA analysis…');
    setChartCandles(candles);

    // Cache successful live data
    if (!usedFallbackData) {
      LS.set(`ohlcv_${sym}_1h`, { data: candles, ts: Date.now() });
    }

    await new Promise(r => setTimeout(r, 300));
    const res = _runAnalysis({ candles, dir, sym, account, phase, newsEvents });
    setResult(res);
    setLoading(false);
  };

  const r  = result;
  const vd = r?.verdict;
  const sigCol  = !r ? T.green : vd===dir ? (dir==='LONG'?T.green:T.red) : vd==='NO TRADE'?T.red:T.yellow;
  const compCol = !r ? T.green : r.compliance==='COMPLIANT'?T.green:T.yellow;

  const LoadingSteps = ['Fetching live candles…','Checking news calendar…','Running technical analysis…','Calculating entries, SL/TP, risk…','Generating AI rationale…'];
  const [stepIdx, setStepIdx] = useState(0);
  useEffect(() => {
    if (!loading) { setStepIdx(0); return; }
    const t = setInterval(() => setStepIdx(i => (i+1) % LoadingSteps.length), 900);
    return () => clearInterval(t);
  }, [loading]);

  return (
    <div className="pp-grid-ct" style={{ display:'grid', gridTemplateColumns:'1fr 1.5fr', gap:24, maxWidth:1080, margin:'0 auto' }}>
      {/* LEFT */}
      <div>
        <div style={{ ...card, marginBottom:16 }}>
          <div style={{ fontWeight:800, fontSize:16, marginBottom:20 }}>Pre-Trade Analyzer</div>

          <div style={{ marginBottom:20 }}>
            <div style={{ color:T.muted, fontSize:11, marginBottom:10, textTransform:'uppercase', letterSpacing:'0.09em' }}>Instrument</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
              {SYMBOLS.map(s => (
                <button key={s} onClick={() => { setSym(s); setResult(null); }}
                  style={{ padding:'7px 13px', borderRadius:8, cursor:'pointer', border:`1px solid ${sym===s?T.amber:'rgba(255,255,255,0.1)'}`, background:sym===s?`${T.amber}1A`:'rgba(255,255,255,0.02)', color:sym===s?T.amber:T.sub, fontSize:13, fontWeight:600 }}>
                  {s}
                </button>
              ))}
            </div>
            {livePriceDisplay && (
              <div style={{ marginTop:10, display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ fontSize:22, fontWeight:900, color:T.amber }}>{livePriceDisplay}</span>
                <span style={{ width:7, height:7, borderRadius:4, background:T.green, boxShadow:`0 0 6px ${T.green}`, display:'inline-block' }}/>
                <span style={{ color:T.muted, fontSize:12 }}>live</span>
              </div>
            )}
          </div>

          <div style={{ marginBottom:24 }}>
            <div style={{ color:T.muted, fontSize:11, marginBottom:10, textTransform:'uppercase', letterSpacing:'0.09em' }}>Your Directional Bias</div>
            <div style={{ display:'flex', gap:10 }}>
              {['LONG','SHORT','NO BIAS'].map(d => (
                <button key={d} onClick={() => { setDir(d); setResult(null); }}
                  style={{ flex:1, padding:'12px 0', borderRadius:9, cursor:'pointer', border:`2px solid ${dir===d?dirColor(d):'rgba(255,255,255,0.08)'}`, background:dir===d?`${dirColor(d)}18`:'rgba(255,255,255,0.02)', color:dir===d?dirColor(d):T.sub, fontSize:13, fontWeight:800, transition:'all 0.15s' }}>
                  {d==='LONG'?'▲ LONG':d==='SHORT'?'▼ SHORT':'— NO BIAS'}
                </button>
              ))}
            </div>
          </div>

          <button onClick={runAnalysis} disabled={loading}
            style={{ width:'100%', padding:15, border:'none', borderRadius:11, cursor:loading?'not-allowed':'pointer', background:loading?`${T.amber}22`:`linear-gradient(135deg,${T.amber},#C96000)`, color:loading?T.amber:'#000', fontSize:15, fontWeight:900, letterSpacing:'0.04em', transition:'all 0.2s' }}>
            {loading ? `⏳  ${LoadingSteps[stepIdx]}` : '🔍  ANALYZE THIS TRADE'}
          </button>

          {ph.newsBlock && (
            <div style={{ marginTop:12, padding:'10px 14px', background:'rgba(251,191,36,0.08)', border:'1px solid rgba(251,191,36,0.25)', borderRadius:8 }}>
              <div style={{ color:T.yellow, fontSize:12, fontWeight:700 }}>⚠ NEWS RESTRICTION ACTIVE</div>
              <div style={{ color:T.sub, fontSize:12, marginTop:4 }}>Avoid trades 2 min before/after HIGH-impact events.</div>
            </div>
          )}
        </div>

        {/* TA factors panel (shown after analysis) */}
        {r && (
          <div style={{ ...card, marginBottom:16 }}>
            <div style={{ fontSize:11, color:T.indigo, fontWeight:700, marginBottom:14, letterSpacing:'0.09em' }}>📊 CONFLUENCE FACTORS</div>
            {r.factors.map((f,i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'7px 0', borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
                <span style={{ color:T.muted, fontSize:12 }}>{f.k}</span>
                <span style={{ color:f.c, fontSize:12, fontWeight:700 }}>{f.v}</span>
              </div>
            ))}
            <div style={{ marginTop:12, display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              <div style={{ padding:'8px 10px', background:'rgba(255,255,255,0.03)', borderRadius:8, textAlign:'center' }}>
                <div style={{ color:T.muted, fontSize:10 }}>TA Score</div>
                <div style={{ color: r.taScore>60?T.green:r.taScore<40?T.red:T.yellow, fontWeight:800, fontSize:16 }}>{r.taScore}/100</div>
              </div>
              <div style={{ padding:'8px 10px', background:'rgba(255,255,255,0.03)', borderRadius:8, textAlign:'center' }}>
                <div style={{ color:T.muted, fontSize:10 }}>ATR</div>
                <div style={{ color:T.amber, fontWeight:800, fontSize:16 }}>{fmtPrice(sym, r.atr)}</div>
              </div>
            </div>
          </div>
        )}

        <div style={{ ...card }}>
          <div style={{ color:T.sub, fontSize:13, fontWeight:700, marginBottom:14 }}>Account Snapshot</div>
          <KVRow k="Daily buffer left"  v={`$${(dailyLim-dailyUsed).toLocaleString()}`} vc={T.green}/>
          <KVRow k="Max risk/trade"     v={`$${allowRisk.toFixed(0)} (${(allowRisk/account.size*100).toFixed(2)}%)`} vc={T.amber}/>
          <KVRow k="Phase"              v={ph.label} vc={T.sub}/>
          <KVRow k="News trading"       v={ph.newsBlock?'RESTRICTED':'ALLOWED'} vc={ph.newsBlock?T.red:T.green}/>
        </div>
      </div>

      {/* RIGHT */}
      <div>
        {!result && !loading && (
          <div style={{ ...card, minHeight:460, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
            <div style={{ fontSize:60, marginBottom:20 }}>🎯</div>
            <div style={{ color:T.sub, fontSize:16, textAlign:'center', lineHeight:1.75, maxWidth:320 }}>
              Select instrument & bias,<br/>hit <strong style={{ color:T.amber }}>Analyze This Trade</strong><br/>
              <span style={{ fontSize:13, color:T.muted }}>Live candles · TA engine · News check · Risk calc</span>
            </div>
          </div>
        )}
        {loading && (
          <div style={{ ...card, minHeight:460, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:20 }}>
            <div style={{ fontSize:56 }}>🧠</div>
            <div style={{ color:T.amber, fontSize:16, fontWeight:700 }}>{LoadingSteps[stepIdx]}</div>
            <div style={{ display:'flex', gap:6 }}>
              {LoadingSteps.map((_,i) => (
                <div key={i} style={{ width:6, height:6, borderRadius:3, background: i===stepIdx?T.amber:'rgba(255,255,255,0.15)', transition:'background 0.3s' }}/>
              ))}
            </div>
            <div style={{ color:T.muted, fontSize:13, textAlign:'center', maxWidth:280, lineHeight:1.6 }}>
              Fetching real-time data<br/>Running EMA · RSI · MACD · Bollinger Bands<br/>Checking phase rules
            </div>
          </div>
        )}
        {r && (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {/* Demo mode banner */}
            {demoMode && (
              <div style={{ padding:'10px 16px', borderRadius:10, background:'rgba(245,158,11,0.07)', border:'1px solid rgba(245,158,11,0.25)', display:'flex', alignItems:'center', gap:10 }}>
                <span>🔶</span>
                <div>
                  <span style={{ color:T.amber, fontWeight:800, fontSize:12 }}>DEMO MODE</span>
                  <span style={{ color:T.sub, fontSize:12 }}> — TA logic is real, price data is synthetic. Analysis valid for structure study.</span>
                </div>
              </div>
            )}
            {/* Main verdict */}
            <div style={{ ...card, background:`${sigCol}08`, border:`2px solid ${sigCol}30` }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:16 }}>
                <div>
                  <div style={{ fontSize:40, fontWeight:900, color:sigCol }}>
                    {vd===dir&&dir==='LONG'?'▲':vd===dir&&dir==='SHORT'?'▼':vd==='NO TRADE'?'⛔':'⏸'} {vd}
                  </div>
                  <div style={{ color:T.muted, fontSize:13, marginTop:4 }}>
                    {sym} · Confidence {r.confidence}%{livePriceDisplay?` · ${livePriceDisplay}`:''}
                  </div>
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:8, alignItems:'flex-end' }}>
                  <Badge label={r.compliance} color={compCol}/>
                  <Badge label={`NEWS: ${r.newsRisk}`} color={r.newsRisk==='HIGH'?T.red:r.newsRisk==='MED'?T.yellow:T.green}/>
                </div>
              </div>

              {/* Confidence bar */}
              <div style={{ height:6, background:'rgba(255,255,255,0.06)', borderRadius:3, overflow:'hidden', marginBottom:16 }}>
                <div style={{ height:'100%', width:`${r.confidence}%`, background:`linear-gradient(90deg,${sigCol}60,${sigCol})`, borderRadius:3, transition:'width 0.8s ease' }}/>
              </div>

              {/* Entry params */}
              {vd === dir && r.entry && (
                <>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:12 }}>
                    {[['Entry Zone',r.entry,T.text],['Stop Loss',r.sl,T.red],['TP1',r.tp1,T.green],['R:R TP1',r.rr1,T.amber],['TP2',r.tp2,T.green],['R:R TP2',r.rr2,T.amber]].map(([lbl,val,col]) => (
                      <div key={lbl} style={{ padding:'10px 12px', background:'rgba(255,255,255,0.04)', borderRadius:9 }}>
                        <div style={{ color:T.muted, fontSize:10, marginBottom:4 }}>{lbl}</div>
                        <div style={{ color:col, fontWeight:800, fontSize:13 }}>{val||'—'}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ padding:'10px 14px', background:'rgba(245,166,35,0.07)', border:'1px solid rgba(245,166,35,0.2)', borderRadius:9 }}>
                    <span style={{ color:T.amber, fontSize:12, fontWeight:700 }}>💰 POSITION SIZE: </span>
                    <span style={{ color:T.sub, fontSize:12 }}>{r.lotNote}</span>
                  </div>
                </>
              )}

              {/* No trade reason */}
              {vd === 'NO TRADE' && (
                <div style={{ padding:'12px 16px', background:'rgba(239,68,68,0.07)', border:'1px solid rgba(239,68,68,0.18)', borderRadius:10 }}>
                  <div style={{ color:T.red, fontSize:12, fontWeight:700, marginBottom:6 }}>⛔ STRUCTURAL CONFLICT</div>
                  <p style={{ color:T.sub, fontSize:13, lineHeight:1.75, margin:0 }}>{r.rationale}</p>
                </div>
              )}
              {vd === 'WAIT' && (
                <div style={{ padding:'12px 16px', background:'rgba(251,191,36,0.07)', border:'1px solid rgba(251,191,36,0.2)', borderRadius:10 }}>
                  <div style={{ color:T.yellow, fontSize:12, fontWeight:700, marginBottom:6 }}>⏸ NOT YET — WAIT</div>
                  <p style={{ color:T.sub, fontSize:13, lineHeight:1.75, margin:0 }}>{r.rationale}</p>
                </div>
              )}
            </div>

            {/* ── Live Chart ── */}
            {chartCandles.length > 0 && (
              <div style={{ borderRadius:12, border:`1px solid ${T.border}`, overflow:'hidden', marginBottom:0 }}>
                <div style={{ padding:'12px 16px', borderBottom:`1px solid ${T.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <div style={{ fontWeight:700, fontSize:14 }}>📊 H1 Chart — {sym}</div>
                  <div style={{ display:'flex', gap:6, fontSize:11 }}>
                    {r?.entry && [['SL','#F87171'],['ENTRY','#F5A623'],['TP1','#34D399']].map(([l,c])=>(
                      <span key={l} style={{ padding:'2px 8px', borderRadius:4, background:`${c}15`, color:c, fontWeight:700 }}>── {l}</span>
                    ))}
                  </div>
                </div>
                <TradeChart
                  candles={chartCandles}
                  tf="1h"
                  dir={dir}
                  levels={r?.entry ? {
                    entry: parseFloat(r.entry),
                    sl:    parseFloat(r.sl),
                    tp1:   parseFloat(r.tp1),
                    tp2:   parseFloat(r.tp2),
                  } : null}
                />
              </div>
            )}

            {/* AI Rationale (only for valid trades) */}
            {vd === dir && (
              <div style={{ ...card }}>
                <div style={{ fontSize:11, color:T.indigo, fontWeight:700, marginBottom:12, letterSpacing:'0.09em' }}>🧠 AI RATIONALE</div>
                <p style={{ color:T.sub, fontSize:13, lineHeight:1.82, margin:'0 0 14px' }}>{r.rationale}</p>
                <div style={{ padding:'10px 14px', background:'rgba(248,113,113,0.07)', border:'1px solid rgba(248,113,113,0.18)', borderRadius:8, marginBottom:14 }}>
                  <span style={{ color:T.red, fontSize:12, fontWeight:700 }}>⚠ INVALIDATION: </span>
                  <span style={{ color:T.sub, fontSize:12 }}>{r.invalidation}</span>
                </div>
                {/* Log Trade Plan shortcut */}
                <LogPlanButton sym={sym} dir={dir} r={r} onNavigate={onNavigate}/>
              </div>
            )}

            {/* News + Compliance row */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
              <div style={{ ...cardS, background: r.newsRisk==='HIGH'?'rgba(248,113,113,0.06)':'rgba(251,191,36,0.05)', border:`1px solid ${r.newsRisk==='HIGH'?'rgba(248,113,113,0.22)':'rgba(251,191,36,0.18)'}` }}>
                <div style={{ fontSize:11, color:r.newsRisk==='HIGH'?T.red:T.yellow, fontWeight:700, marginBottom:8 }}>📰 NEWS: {r.newsRisk}</div>
                <p style={{ color:T.sub, fontSize:12, lineHeight:1.65, margin:0 }}>{r.newsNote}</p>
              </div>
              <div style={{ ...cardS, background:`${compCol}06`, border:`1px solid ${compCol}20` }}>
                <div style={{ fontSize:11, color:compCol, fontWeight:700, marginBottom:8 }}>🛡 COMPLIANCE: {r.compliance}</div>
                <p style={{ color:T.sub, fontSize:12, lineHeight:1.65, margin:0 }}>{r.compNote}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AI JOURNAL
// ═══════════════════════════════════════════════════════════════════════════

// ── Dynamic AI coaching — generates real feedback from trade data ──────────
function generateCoachFeedback(trade, allTrades) {
  if (!trade) return { body: 'Select a trade to see analysis.', rec: null };

  const issues = [];
  const recs   = [];

  // ── Detect issue keywords from trade.issue field
  const issue = (trade.issue || '').toLowerCase();
  const isFomo    = issue.includes('fomo');
  const isRevenge = issue.includes('revenge');
  const isAgainst = issue.includes('against') || issue.includes('plan');
  const isEarly   = issue.includes('early');
  const isLate    = issue.includes('late') || issue.includes('past');
  const hasIssue  = isFomo || isRevenge || isAgainst || isEarly || isLate || issue.length > 0;

  // ── Score analysis
  const score = trade.score || 50;
  const scoreLabel = score >= 75 ? 'high-quality A+ setup'
                   : score >= 60 ? 'above-average setup'
                   : score >= 45 ? 'marginal setup'
                   : 'low-quality entry — below your minimum threshold';

  // ── R:R analysis
  const rr = parseFloat(trade.rr) || 0;
  const rrNote = rr >= 2.0 ? `R:R of ${rr} is excellent — this is the target.`
               : rr >= 1.5 ? `R:R of ${rr} is acceptable but aim for 2+.`
               : rr > 0    ? `R:R of ${rr} is below ideal. Minimum should be 1.5.`
               : 'No R:R recorded.';

  // ── Win/Loss specific feedback
  if (trade.win) {
    issues.push(`This was a winning ${trade.dir || ''} trade on ${trade.sym || 'unknown'} scored ${score}/100 — ${scoreLabel}.`);
    if (rr >= 2) issues.push(rrNote);
    else issues.push(`${rrNote} On winners, always let the trade breathe to TP2.`);
    if (!hasIssue) issues.push('No execution issues detected. Clean entry, managed well.');
  } else {
    issues.push(`Loss on ${trade.sym || 'unknown'} ${trade.dir || ''} — AI score was ${score}/100 (${scoreLabel}).`);
    if (score < 50) issues.push('The AI score below 50 at entry was a warning sign. This trade should have been skipped.');
    if (rr > 0 && rr < 1.5) issues.push(`R:R was ${rr} — insufficient reward for the risk taken. Minimum 1.5:1 before entry.`);
  }

  // ── Emotional pattern detection
  if (isFomo) {
    issues.push('FOMO pattern detected. Price had moved past the optimal entry zone before the order was placed.');
    recs.push('Set price alerts at your zone. If price has left — skip it. A missed trade costs $0; a FOMO trade costs real money.');
  }
  if (isRevenge) {
    // Check if there's a prior loss in close sequence
    const sortedAll = [...allTrades].sort((a,b) => b.id - a.id);
    const idx = sortedAll.findIndex(t => t.id === trade.id);
    const prevTrade = sortedAll[idx + 1];
    const prevWasLoss = prevTrade && !prevTrade.win;
    issues.push(prevWasLoss
      ? `Revenge trade signature — opened shortly after a ${prevTrade.sym} loss. No cooling off between trades.`
      : 'Revenge trade flag. Review your emotional state at time of entry.');
    recs.push('Mandatory 30-minute cooldown after every loss. Two emotional entries in sequence are the #1 cause of blown funded accounts.');
  }
  if (isAgainst) {
    issues.push('Entry was against the original trade plan or HTF trend direction. Plan deviation is a discipline failure.');
    recs.push('Write your plan before the session. If price does not reach your zone — no trade. Discipline over opportunity.');
  }
  if (isEarly) {
    issues.push('Early entry — entered before confirmation. Patience is a trading edge.');
    recs.push('Wait for the candle to close as confirmation. Early entries reduce R:R and increase failure rate.');
  }
  if (isLate) {
    issues.push('Late entry — price had moved past the optimal zone. R:R was compromised before entry.');
    recs.push('Use limit orders at your zone rather than market orders chasing price.');
  }

  // ── Clean trade
  if (!hasIssue && trade.win) {
    recs.push('Use this trade as your reference template. Review it before sessions to reinforce the pattern.');
  } else if (!hasIssue && !trade.win) {
    recs.push('Sometimes clean setups lose. Review the setup objectively — if the entry was correct, the process was right even if the outcome was not.');
  }

  // ── P&L feedback
  if (trade.pnl !== undefined) {
    const pnlNote = Math.abs(trade.pnl) > 500
      ? ` P&L of ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl} is above your typical trade size — check position sizing.`
      : '';
    if (pnlNote) issues.push(pnlNote);
  }

  return {
    body: issues.join(' ') || 'Entry data is minimal — add more detail when logging trades for better coaching.',
    rec:  recs.length > 0 ? recs.join(' ') : null,
  };
}

// ── Equity curve SVG ────────────────────────────────────────────────────────
function EquityCurve({ trades }) {
  const W=480, H=100, PL=8, PR=8, PT=6, PB=16;
  const sorted = [...trades].sort((a,b) => a.id - b.id);
  if (sorted.length < 2) return (
    <div style={{ height:H, display:'flex', alignItems:'center', justifyContent:'center', color:T.muted, fontSize:13 }}>Log 2+ trades to see equity curve</div>
  );
  let cum = 0;
  const pts = [{ i:0, v:0 }, ...sorted.map((t,i)=>{ cum+=t.pnl; return { i:i+1, v:cum }; })];
  const vals = pts.map(p=>p.v), n=pts.length;
  const min=Math.min(...vals), max=Math.max(...vals), rng=max-min||1;
  const sx = i => PL + (i/(n-1))*(W-PL-PR);
  const sy = v => H-PB-((v-min)/rng)*(H-PT-PB);
  const pp = pts.map((p,i)=>[sx(i), sy(p.v)]);
  const line = pp.map((p,i)=>`${i===0?'M':'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${pp[n-1][0].toFixed(1)},${(H-PB).toFixed(1)} L${pp[0][0].toFixed(1)},${(H-PB).toFixed(1)} Z`;
  const col  = cum >= 0 ? T.green : T.red;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:H,overflow:'visible'}}>
      <defs>
        <linearGradient id="ecg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.3"/>
          <stop offset="100%" stopColor={col} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={area} fill="url(#ecg)"/>
      <path d={line} fill="none" stroke={col} strokeWidth="2"/>
      {pp.map((p,i)=>(
        <circle key={i} cx={p[0]} cy={p[1]} r="3" fill={sorted[i-1]?.win?T.green:T.red} opacity="0.8"/>
      ))}
    </svg>
  );
}

// ── Journal Analytics sub-tab ────────────────────────────────────────────────
function JournalAnalytics({ trades }) {
  if (trades.length === 0) {
    return (
      <div style={{ textAlign:'center', padding:'60px 24px', color:T.muted }}>
        <div style={{ fontSize:40, marginBottom:14 }}>▦</div>
        <div style={{ fontWeight:800, fontSize:16, color:T.sub, marginBottom:8 }}>No trades logged yet</div>
        <div style={{ fontSize:13 }}>Log at least one trade to see analytics.</div>
      </div>
    );
  }

  // ── Compute win-rate by symbol
  const bySymbol = {};
  trades.forEach(t => {
    if (!bySymbol[t.sym]) bySymbol[t.sym] = { w:0, l:0 };
    t.win ? bySymbol[t.sym].w++ : bySymbol[t.sym].l++;
  });
  const symRows = Object.entries(bySymbol).map(([sym, v]) => {
    const total = v.w + v.l;
    return { sym, total, wr: total ? (v.w/total)*100 : 0 };
  }).sort((a,b) => b.wr - a.wr);

  // ── Win-rate by direction
  const byDir = { LONG:{ w:0,l:0 }, SHORT:{ w:0,l:0 } };
  trades.forEach(t => {
    const d = t.dir || (t.win ? 'LONG' : 'SHORT');
    if (byDir[d]) { t.win ? byDir[d].w++ : byDir[d].l++; }
  });
  const dirWR = (d) => { const v = byDir[d]; const tot = v.w+v.l; return tot ? (v.w/tot*100) : 0; };

  // ── P&L by day of week
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const byDow = [0,1,2,3,4,5,6].map(() => ({ pnl:0, count:0 }));
  trades.forEach(t => {
    if (!t.date) return;
    // t.date format: "16 Apr"
    try {
      const d = new Date(t.date + ' ' + new Date().getFullYear());
      if (!isNaN(d)) { byDow[d.getDay()].pnl += (t.pnl||0); byDow[d.getDay()].count++; }
    } catch {}
  });

  // ── Score distribution buckets (0-25, 26-50, 51-75, 76-100)
  const scoreBuckets = [
    { lbl:'0–25',  min:0,  max:25 },
    { lbl:'26–50', min:26, max:50 },
    { lbl:'51–75', min:51, max:75 },
    { lbl:'76–100',min:76, max:100 },
  ].map(b => {
    const inRange = trades.filter(t => t.score >= b.min && t.score <= b.max);
    const wins = inRange.filter(t => t.win).length;
    return { ...b, count: inRange.length, wr: inRange.length ? (wins/inRange.length)*100 : 0 };
  });

  // ── Best & worst trades
  const sorted = [...trades].sort((a,b) => b.pnl - a.pnl);
  const best  = sorted[0];
  const worst = sorted[sorted.length-1];

  // ── Monthly P&L (last 6 months grouping)
  const byMonth = {};
  trades.forEach(t => {
    if (!t.date) return;
    try {
      const d = new Date(t.date + ' ' + new Date().getFullYear());
      if (!isNaN(d)) {
        const key = d.toLocaleDateString('en-GB', { month:'short', year:'2-digit' });
        byMonth[key] = (byMonth[key] || 0) + (t.pnl || 0);
      }
    } catch {}
  });
  const monthRows = Object.entries(byMonth).slice(-6);

  return (
    <div className="pp-grid" style={{ gap:18 }}>

      {/* ── Top KPIs ── */}
      <div className="pp-grid pp-grid-4x">
        {[
          { lbl:'Best Symbol', val: symRows[0]?.sym || '—', sub:`${symRows[0]?.wr.toFixed(0)}% WR`, vc: T.green },
          { lbl:'LONG Win Rate', val:`${dirWR('LONG').toFixed(0)}%`, sub:`${byDir.LONG.w+byDir.LONG.l} trades`, vc: dirWR('LONG') >= 50 ? T.green : T.red },
          { lbl:'SHORT Win Rate', val:`${dirWR('SHORT').toFixed(0)}%`, sub:`${byDir.SHORT.w+byDir.SHORT.l} trades`, vc: dirWR('SHORT') >= 50 ? T.green : T.red },
          { lbl:'Best Trade', val:`+$${best?.pnl||0}`, sub: best ? `${best.sym} ${best.dir||''}` : '—', vc: T.green },
        ].map(st => (
          <ShellKpi key={st.lbl} label={st.lbl} value={st.val} sub={st.sub} color={st.vc}/>
        ))}
      </div>

      {/* ── Symbol + Direction breakdown ── */}
      <div className="pp-grid pp-grid-2x">
        <div className="pp-panel" style={{ padding:20 }}>
          <div style={{ fontWeight:800, fontSize:15, marginBottom:14 }}>Win Rate by Symbol</div>
          <div className="pp-grid" style={{ gap:10 }}>
            {symRows.map(row => (
              <div key={row.sym}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
                  <span style={{ color:T.sub, fontSize:12, fontWeight:700 }}>{row.sym}</span>
                  <span style={{ color: row.wr >= 50 ? T.green : T.red, fontWeight:800, fontSize:12 }}>
                    {row.wr.toFixed(0)}% <span style={{ color:T.muted, fontWeight:400 }}>({row.total} trades)</span>
                  </span>
                </div>
                <div style={{ height:8, background:'rgba(255,255,255,.06)', borderRadius:999, overflow:'hidden' }}>
                  <div style={{ height:'100%', width:`${row.wr}%`, background: row.wr >= 50 ? T.green : T.red, borderRadius:999, transition:'width .4s ease' }}/>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="pp-panel" style={{ padding:20 }}>
          <div style={{ fontWeight:800, fontSize:15, marginBottom:14 }}>Win Rate by Direction</div>
          {['LONG','SHORT'].map(d => {
            const v = byDir[d]; const tot = v.w+v.l; const wr = tot ? v.w/tot*100 : 0;
            return (
              <div key={d} style={{ marginBottom:18 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                  <span style={{ color: d==='LONG'?T.green:T.red, fontWeight:800, fontSize:14 }}>{d==='LONG'?'🟢':'🔴'} {d}</span>
                  <span style={{ fontWeight:900, fontSize:16, color: wr>=50?T.green:T.red }}>{wr.toFixed(0)}%</span>
                </div>
                <div style={{ height:10, background:'rgba(255,255,255,.06)', borderRadius:999, overflow:'hidden' }}>
                  <div style={{ height:'100%', width:`${wr}%`, background: wr>=50?T.green:T.red, borderRadius:999 }}/>
                </div>
                <div style={{ color:T.muted, fontSize:11, marginTop:4 }}>{v.w}W · {v.l}L of {tot} trades</div>
              </div>
            );
          })}

          <div style={{ borderTop:`1px solid ${T.border}`, paddingTop:14, marginTop:4 }}>
            <div style={{ color:T.muted, fontSize:11, marginBottom:8 }}>Best/Worst Trades</div>
            {[['Best', best, T.green], ['Worst', worst, T.red]].map(([lbl, tr, col]) => tr ? (
              <div key={lbl} style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                <span style={{ color:T.sub, fontSize:12 }}>{lbl}: <b style={{color:T.text}}>{tr.sym} {tr.dir||''}</b></span>
                <span style={{ color:col, fontWeight:800, fontSize:12 }}>{tr.pnl>0?'+':''}${tr.pnl}</span>
              </div>
            ) : null)}
          </div>
        </div>
      </div>

      {/* ── P&L by day of week ── */}
      <div className="pp-panel" style={{ padding:20 }}>
        <div style={{ fontWeight:800, fontSize:15, marginBottom:14 }}>P&L by Day of Week</div>
        <div style={{ display:'flex', gap:8, alignItems:'flex-end', flexWrap:'wrap' }}>
          {[1,2,3,4,5].map(dow => { // Mon–Fri only
            const d = byDow[dow];
            const maxPnl = Math.max(...[1,2,3,4,5].map(i => Math.abs(byDow[i].pnl))) || 1;
            const barH = Math.round((Math.abs(d.pnl) / maxPnl) * 80);
            return (
              <div key={dow} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:6 }}>
                <div style={{ color: d.pnl>=0?T.green:T.red, fontWeight:800, fontSize:11 }}>
                  {d.pnl>=0?'+':''}${d.pnl}
                </div>
                <div style={{ width:'100%', height:80, display:'flex', alignItems:'flex-end', justifyContent:'center' }}>
                  <div style={{ width:'60%', height: barH||4, background: d.pnl>=0?T.green:T.red, borderRadius:'4px 4px 0 0', opacity:0.8 }}/>
                </div>
                <div style={{ color:T.sub, fontSize:12, fontWeight:700 }}>{DOW[dow]}</div>
                <div style={{ color:T.muted, fontSize:10 }}>{d.count}tr</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Score distribution ── */}
      <div className="pp-panel" style={{ padding:20 }}>
        <div style={{ fontWeight:800, fontSize:15, marginBottom:14 }}>Quality Score vs Win Rate</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
          {scoreBuckets.map(b => (
            <div key={b.lbl} style={{ background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:12, padding:'14px 16px', textAlign:'center' }}>
              <div style={{ color:T.muted, fontSize:11, marginBottom:6 }}>Score {b.lbl}</div>
              <div style={{ fontWeight:900, fontSize:24, color: b.wr>=60?T.green:b.wr>=40?T.amber:T.red }}>{b.wr.toFixed(0)}%</div>
              <div style={{ color:T.muted, fontSize:11, marginTop:4 }}>WR · {b.count} trades</div>
            </div>
          ))}
        </div>
        <div style={{ color:T.muted, fontSize:11, marginTop:12 }}>
          Higher quality scores should correlate with higher win rates. If not, review your entry criteria.
        </div>
      </div>

      {/* ── Monthly P&L ── */}
      {monthRows.length > 1 && (
        <div className="pp-panel" style={{ padding:20 }}>
          <div style={{ fontWeight:800, fontSize:15, marginBottom:14 }}>Monthly P&L</div>
          <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
            {monthRows.map(([month, pnl]) => (
              <div key={month} style={{ flex:'1 1 120px', background:'rgba(255,255,255,0.03)', border:`1px solid ${pnl>=0?'rgba(16,185,129,0.2)':'rgba(239,68,68,0.2)'}`, borderRadius:10, padding:'12px 16px', textAlign:'center' }}>
                <div style={{ color:T.muted, fontSize:11, marginBottom:4 }}>{month}</div>
                <div style={{ fontWeight:900, fontSize:18, color:pnl>=0?T.green:T.red }}>{pnl>=0?'+':''}${pnl}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Journal({ trades, setTrades, plan }) {
  const [journalView, setJournalView] = useState('trades'); // 'trades' | 'analytics'
  const [sel,      setSel]      = useState(trades[1] || trades[0]);
  const [showLog,  setShowLog]  = useState(false);
  const [pending,  setPending]  = useState(() => LS.get('pendingPlan', null));

  const hmColor = pnl => pnl > 200 ? '#34D39988' : pnl > 0 ? '#34D39944' : pnl < -200 ? '#F8717188' : pnl < 0 ? '#F8717144' : 'rgba(255,255,255,0.06)';

  const wins     = trades.filter(t => t.win).length;
  const losses   = trades.filter(t => !t.win).length;
  const totalPnL = trades.reduce((a, t) => a + t.pnl, 0);
  const winRate  = trades.length ? Math.round(wins/trades.length*100) : 0;
  const avgWin   = wins   ? trades.filter(t=>t.win).reduce((a,t)=>a+t.pnl,0)/wins   : 0;
  const avgLoss  = losses ? trades.filter(t=>!t.win).reduce((a,t)=>a+t.pnl,0)/losses: 0;
  const expectancy = trades.length ? ((winRate/100)*avgWin + (1-winRate/100)*avgLoss) : 0;
  const avgScore = trades.length ? Math.round(trades.reduce((a,t)=>a+t.score,0)/trades.length) : 0;

  // Current streak
  let streak = 0, streakType = '';
  const sorted = [...trades].sort((a,b) => b.id - a.id);
  if (sorted.length) {
    streakType = sorted[0].win ? 'W' : 'L';
    for (const t of sorted) {
      if ((t.win && streakType==='W') || (!t.win && streakType==='L')) streak++;
      else break;
    }
  }

  const handleSaveTrade = (trade) => {
    const updated = [trade, ...trades];
    setTrades(updated);
    setSel(trade);
  };

  const handleDelete = (id) => {
    const updated = trades.filter(t => t.id !== id);
    setTrades(updated);
    if (sel?.id === id) setSel(updated[0] || null);
  };

  // Build heatmap dynamically from trades — last 30 weekdays
  const heatmap = useMemo(() => {
    // Build a map of date-label → summed P&L
    const byDate = {};
    trades.forEach(t => {
      const key = t.date || '';
      byDate[key] = (byDate[key] || 0) + (t.pnl || 0);
    });

    // Generate the last 30 calendar days, skip weekends
    const days = [];
    const todayDate = new Date();
    const todayLabel = todayDate.toLocaleDateString('en-GB', { day:'numeric', month:'short' }).replace(/ /g, '').replace('Jan','J').replace('Feb','F').replace('Mar','M').replace('Apr','A').replace('May','My').replace('Jun','Jn').replace('Jul','Jl').replace('Aug','Au').replace('Sep','S').replace('Oct','O').replace('Nov','N').replace('Dec','D');

    for (let offset = 29; offset >= 0; offset--) {
      const d = new Date(todayDate);
      d.setDate(d.getDate() - offset);
      const dow = d.getDay();
      if (dow === 0 || dow === 6) continue; // skip weekends
      const label = d.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
      // Short label: "16 Apr" → "16A"
      const parts = label.split(' ');
      const shortLbl = parts[0] + parts[1][0];
      const pnl = byDate[label] !== undefined ? byDate[label] : 0;
      const isToday = offset === 0;
      days.push({ d: shortLbl, fullDate: label, pnl, today: isToday });
    }
    return days;
  }, [trades]);

  return (
    <div>
      {showLog && <LogTradeModal onClose={() => setShowLog(false)} onSave={handleSaveTrade}/>}

      {/* ── Sub-tab bar ── */}
      <div style={{ display:'flex', gap:6, marginBottom:20, padding:'4px', background:'rgba(255,255,255,0.04)', borderRadius:12, border:'1px solid rgba(255,255,255,0.07)', width:'fit-content' }}>
        {[['trades','▦ Trades'],['analytics','◈ Analytics']].map(([id,lbl]) => (
          <button key={id} onClick={() => setJournalView(id)}
            style={{ padding:'7px 20px', borderRadius:9, border:'none', cursor:'pointer', fontWeight:700, fontSize:13,
              background: journalView===id ? 'rgba(99,102,241,0.22)' : 'transparent',
              color: journalView===id ? '#818CF8' : T.muted,
              boxShadow: journalView===id ? '0 0 0 1px rgba(99,102,241,0.35)' : 'none',
            }}>
            {lbl}
          </button>
        ))}
        <button onClick={() => setShowLog(true)}
          style={{ padding:'7px 16px', borderRadius:9, border:'none', cursor:'pointer', fontWeight:700, fontSize:13,
            background:`linear-gradient(135deg,${T.green},#059669)`, color:'#000', marginLeft:4 }}>
          + Log Trade
        </button>
      </div>

      {journalView === 'analytics' && (
        <JournalAnalytics trades={trades}/>
      )}

      {journalView === 'trades' && (<>

      {/* ── Free plan soft limit banner ── */}
      {PLAN_ORDER[plan || 'free'] < PLAN_ORDER['pro'] && trades.length >= 8 && (
        <div style={{ marginBottom:20, padding:'14px 18px', background:'rgba(99,102,241,0.07)', border:'1px solid rgba(99,102,241,0.28)', borderRadius:12, display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:14, color:'#818CF8', marginBottom:4 }}>
              {trades.length >= 10 ? '🔒 Trade limit reached (10/10)' : `📈 ${trades.length}/10 trades used on Free plan`}
            </div>
            <div style={{ color:T.sub, fontSize:13 }}>
              {trades.length >= 10
                ? 'Upgrade to Pro for unlimited trades, AI coaching, and cloud sync.'
                : `${10 - trades.length} trades remaining. Upgrade to Pro for unlimited journaling.`}
            </div>
          </div>
          <button onClick={() => { LS.set('show_upgrade', true); window.dispatchEvent(new Event('show_upgrade')); }}
            style={{ padding:'9px 20px', background:'linear-gradient(135deg,#6366F1,#4F46E5)', border:'none', borderRadius:9, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer', whiteSpace:'nowrap' }}>
            Upgrade to Pro →
          </button>
        </div>
      )}

      {/* ── Pending plan banner from Check Trade ── */}
      {pending && (
        <div style={{ ...card, marginBottom:20, background:'rgba(99,102,241,0.07)', border:'1px solid rgba(99,102,241,0.32)', display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12 }}>
          <div>
            <div style={{ color:'#818CF8', fontWeight:800, fontSize:14, marginBottom:4 }}>📝 Pending Trade Plan from Check Trade</div>
            <div style={{ color:T.sub, fontSize:13 }}>
              {pending.sym} · <span style={{ color:pending.dir==='LONG'?T.green:T.red, fontWeight:700 }}>{pending.dir}</span>
              {' · '}Entry {pending.entry} · SL {pending.sl} · TP {pending.tp1} · R:R {pending.rr}
            </div>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={() => {
              const todayStr = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short' });
              const trade = {
                id: Date.now(), date: todayStr, sym: pending.sym, dir: pending.dir,
                pnl: 0, rr: pending.rr, score: pending.confidence || 75, win: false,
                issue: 'Pending — update P&L after close',
              };
              handleSaveTrade(trade);
              LS.set('pendingPlan', null);
              setPending(null);
            }} style={{ padding:'8px 16px', background:'linear-gradient(135deg,#6366F1,#4F46E5)', border:'none', borderRadius:8, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer' }}>
              ✓ Log It
            </button>
            <button onClick={() => { LS.set('pendingPlan', null); setPending(null); }}
              style={{ padding:'8px 12px', background:'transparent', border:`1px solid ${T.border}`, borderRadius:8, color:T.muted, fontSize:13, cursor:'pointer' }}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div style={{ ...card, marginBottom:24 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, flexWrap:'wrap', gap:12 }}>
          <div style={{ fontWeight:700, fontSize:15 }}>Performance Heatmap · Last 30 Days</div>
          <div style={{ display:'flex', gap:16, fontSize:12, color:T.muted, flexWrap:'wrap' }}>
            {[['#34D399','Win'],['#F87171','Loss'],['rgba(255,255,255,0.12)','No trade']].map(([bg,label]) => (
              <span key={label} style={{ display:'flex', alignItems:'center', gap:5 }}>
                <span style={{ width:10, height:10, borderRadius:2, background:bg, display:'inline-block' }}/>{label}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
          {heatmap.map((day,i) => (
            <div key={i} className="pp-heatmap-day" title={`${day.fullDate || day.d}: ${day.pnl>0?'+':''}$${day.pnl||'no trade'}`}
              style={{ width:44, height:44, borderRadius:8, background:hmColor(day.pnl), display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', border:day.today?`2px solid ${T.amber}`:'1px solid rgba(255,255,255,0.06)', position:'relative' }}>
              <div className="hm-date" style={{ fontSize:9, color:'rgba(255,255,255,0.45)', marginBottom:1 }}>{day.d}</div>
              <div className="hm-val" style={{ fontSize:10, fontWeight:700, color:day.pnl>0?T.green:day.pnl<0?T.red:T.muted }}>
                {day.pnl===0?'—':day.pnl>0?`+${day.pnl}`:`${day.pnl}`}
              </div>
              {day.today && <div style={{ position:'absolute', top:-7, right:-4, background:T.amber, borderRadius:4, padding:'1px 4px', fontSize:8, color:'#000', fontWeight:900 }}>NOW</div>}
            </div>
          ))}
        </div>
        <div style={{ marginTop:16, display:'flex', gap:24, flexWrap:'wrap' }}>
          {[
            { lbl:'Best day',  val:`+$${Math.max(...heatmap.map(d=>d.pnl))}`, vc:T.green },
            { lbl:'Worst day', val:`-$${Math.abs(Math.min(...heatmap.map(d=>d.pnl)))}`, vc:T.red },
            { lbl:'Green days',val:`${heatmap.filter(d=>d.pnl>0).length}`, vc:T.green },
            { lbl:'Red days',  val:`${heatmap.filter(d=>d.pnl<0).length}`, vc:T.red   },
            { lbl:'No trade',  val:`${heatmap.filter(d=>d.pnl===0).length}`, vc:T.muted },
          ].map(st => (
            <div key={st.lbl}>
              <div style={{ color:T.muted, fontSize:11 }}>{st.lbl}</div>
              <div style={{ color:st.vc, fontWeight:700, fontSize:14 }}>{st.val}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="pp-grid-2l" style={{ display:'grid', gridTemplateColumns:'1.5fr 1fr', gap:24 }}>
        <div>
          {/* Equity Curve */}
          <div style={{ ...card, marginBottom:20 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <div style={{ fontWeight:700, fontSize:14 }}>Equity Curve</div>
              <div style={{ color:totalPnL>=0?T.green:T.red, fontWeight:800, fontSize:16 }}>{totalPnL>=0?'+':''}${totalPnL}</div>
            </div>
            <EquityCurve trades={trades}/>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:20 }}>
            {[
              { lbl:'Win Rate',    val: trades.length ? `${winRate}%` : '—',       vc: winRate>=60?T.green:winRate>=50?T.yellow:T.red },
              { lbl:'Expectancy',  val: trades.length ? `${expectancy>=0?'+':''}$${expectancy.toFixed(0)}` : '—', vc: expectancy>=0?T.green:T.red },
              { lbl:'Streak',      val: trades.length ? `${streak}${streakType}` : '—', vc: streakType==='W'?T.green:T.red },
              { lbl:'Avg Score',   val: trades.length ? `${avgScore}/100` : '—',   vc: avgScore>70?T.green:avgScore>50?T.yellow:T.red },
            ].map(st => (
              <div key={st.lbl} style={{ ...cardS, textAlign:'center' }}>
                <div style={{ color:T.muted, fontSize:11, marginBottom:6 }}>{st.lbl}</div>
                <div style={{ color:st.vc, fontWeight:800, fontSize:18 }}>{st.val}</div>
              </div>
            ))}
          </div>
          <div style={{ ...card }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <div style={{ fontWeight:800, fontSize:15 }}>Trade History</div>
              <button onClick={() => setShowLog(true)} style={{ padding:'7px 16px', background:`linear-gradient(135deg,${T.green},#059669)`, border:'none', borderRadius:8, color:'#000', fontSize:13, fontWeight:800, cursor:'pointer' }}>
                + Log Trade
              </button>
            </div>
            {trades.length === 0 && (
              <div style={{ textAlign:'center', padding:'32px 0', color:T.muted, fontSize:14 }}>
                No trades yet. Hit <strong style={{color:T.green}}>+ Log Trade</strong> to add your first.
              </div>
            )}
            {trades.map(tr => (
              <div key={tr.id} onClick={() => setSel(tr)} style={{ padding:'12px 14px', borderRadius:10, marginBottom:8, cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center', border:`1px solid ${sel?.id===tr.id?'rgba(129,140,248,0.38)':'transparent'}`, background:sel?.id===tr.id?'rgba(129,140,248,0.07)':'rgba(255,255,255,0.02)' }}>
                <div style={{ display:'flex', gap:14, alignItems:'center' }}>
                  <Badge label={tr.win?'WIN':'LOSS'} color={tr.win?T.green:T.red}/>
                  <div>
                    <div style={{ fontWeight:700, fontSize:14 }}>{tr.sym} <span style={{ color:tr.dir==='LONG'?T.green:T.red, fontSize:12 }}>{tr.dir}</span></div>
                    <div style={{ color:T.muted, fontSize:12 }}>{tr.date} · R:R {tr.rr}</div>
                  </div>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ color:tr.pnl>0?T.green:T.red, fontWeight:800, fontSize:14 }}>{tr.pnl>0?'+':''}${tr.pnl}</div>
                    <div style={{ fontSize:11, color:T.muted }}>AI <span style={{ color:tr.score>70?T.green:tr.score>50?T.yellow:T.red, fontWeight:700 }}>{tr.score}</span></div>
                  </div>
                  <button onClick={e => { e.stopPropagation(); handleDelete(tr.id); }}
                    style={{ background:'transparent', border:'none', color:T.muted, cursor:'pointer', fontSize:16, padding:'2px 6px', borderRadius:4, lineHeight:1 }}
                    title="Delete trade">×</button>
                </div>
              </div>
            ))}
          </div>
        </div>
        {sel ? (
          <div>
            <div style={{ ...card, background:'rgba(99,102,241,0.05)', border:'1px solid rgba(99,102,241,0.22)', marginBottom:16 }}>
              <div style={{ fontSize:11, color:T.indigo, fontWeight:700, letterSpacing:'0.09em', marginBottom:12 }}>🧠 AI COACH</div>
              <div style={{ fontWeight:800, fontSize:15, marginBottom:8 }}>{sel.sym} {sel.dir} · {sel.date}</div>
              <div style={{ display:'flex', gap:8, marginBottom:16 }}>
                <Badge label={sel.win?'WIN':'LOSS'} color={sel.win?T.green:T.red}/>
                <span style={{ color:T.muted, fontSize:13 }}>Score: <span style={{ color:sel.score>70?T.green:sel.score>50?T.yellow:T.red, fontWeight:700 }}>{sel.score}</span>/100</span>
              </div>
              {sel.issue && (
                <div style={{ padding:'10px 14px', background:'rgba(248,113,113,0.08)', border:'1px solid rgba(248,113,113,0.22)', borderRadius:10, marginBottom:14 }}>
                  <div style={{ color:T.red, fontSize:11, fontWeight:700, marginBottom:4 }}>⚠ ISSUE DETECTED</div>
                  <div style={{ color:T.sub, fontSize:13 }}>{sel.issue}</div>
                </div>
              )}
              <PlanGate minPlan="pro" plan={plan} feature="AI coaching analyses every trade's R:R, patterns, and gives recommendations">
                {(() => {
                  const coaching = generateCoachFeedback(sel, trades);
                  return (
                    <>
                      <p style={{ color:T.sub, fontSize:13, lineHeight:1.82, margin:'0 0 14px' }}>{coaching.body}</p>
                      {coaching.rec && (
                        <div style={{ padding:'10px 14px', background:'rgba(251,191,36,0.07)', border:'1px solid rgba(251,191,36,0.22)', borderRadius:8 }}>
                          <span style={{ color:T.yellow, fontSize:12, fontWeight:700 }}>💡 REC: </span>
                          <span style={{ color:T.sub, fontSize:12 }}>{coaching.rec}</span>
                        </div>
                      )}
                    </>
                  );
                })()}
              </PlanGate>
            </div>
            <div style={{ ...card }}>
              <div style={{ color:T.sub, fontSize:13, fontWeight:700, marginBottom:14 }}>Week Discipline Scan</div>
              {[
                ['FOMO entries',        `${trades.filter(t=>t.issue&&t.issue.toLowerCase().includes('fomo')).length}`,    T.yellow],
                ['Revenge trades',      `${trades.filter(t=>t.issue&&t.issue.toLowerCase().includes('revenge')).length}`, T.red   ],
                ['Against-plan entries',`${trades.filter(t=>t.issue&&t.issue.toLowerCase().includes('against')).length}`, T.red   ],
                ['Clean setups',        `${trades.filter(t=>!t.issue).length}`,                                           T.green ],
                ['Risk limits kept',    `${trades.length}/${trades.length}`,                                              T.green ],
              ].map(([k,v,vc]) => (
                <KVRow key={k} k={k} v={v} vc={vc}/>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ ...card, display:'flex', alignItems:'center', justifyContent:'center', color:T.muted, fontSize:14, minHeight:200 }}>
            Select a trade to see AI coaching
          </div>
        )}
      </div>
      </>)}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// RISK CALCULATOR — Position Sizer
// ═══════════════════════════════════════════════════════════════════════════

const INST_MAP = {
  XAUUSD: { label:'XAU/USD', group:'metals',  pipVal:1,  pipUnit:'pips ($0.01)',  defSL:300,  icon:'🥇' },
  XAGUSD: { label:'XAG/USD', group:'metals',  pipVal:50, pipUnit:'pips ($0.01)',  defSL:50,   icon:'⚪' },
  EURUSD: { label:'EUR/USD', group:'forex',   pipVal:10, pipUnit:'pips (0.0001)', defSL:25,   icon:'💶' },
  GBPUSD: { label:'GBP/USD', group:'forex',   pipVal:10, pipUnit:'pips (0.0001)', defSL:30,   icon:'💷' },
  USDJPY: { label:'USD/JPY', group:'forex',   pipVal:1000, pipUnit:'pips (0.01)',   defSL:25,   icon:'¥'  },
  GBPJPY: { label:'GBP/JPY', group:'forex',   pipVal:1000, pipUnit:'pips (0.01)',   defSL:40,   icon:'¥'  },
  AUDUSD: { label:'AUD/USD', group:'forex',   pipVal:10, pipUnit:'pips (0.0001)', defSL:20,   icon:'🦘' },
  USDCAD: { label:'USD/CAD', group:'forex',   pipVal:10, pipUnit:'pips (0.0001)', defSL:25,   icon:'🍁' },
  NAS100: { label:'NAS100',  group:'indices', pipVal:20, pipUnit:'points',        defSL:30,   icon:'📈' },
  US30:   { label:'US30',    group:'indices', pipVal:1,  pipUnit:'points',        defSL:50,   icon:'🏦' },
  US500:  { label:'S&P500',  group:'indices', pipVal:1,  pipUnit:'points',        defSL:15,   icon:'📊' },
  BTCUSD: { label:'BTC/USD', group:'crypto',  pipVal:1,  pipUnit:'$1 moves',      defSL:1000, icon:'₿'  },
};
const INST_GROUPS = [
  { id:'metals', label:'Metals' },
  { id:'forex', label:'Forex' },
  { id:'indices', label:'Indices' },
  { id:'crypto', label:'Crypto' },
];

function RiskCalc({ account }) {
  // ── Read challenge for real-time account data ─────────────────────────────
  const ch        = LS.get('challenge', null);
  const chFirm    = ch ? PROP_FIRMS[ch.firmId] : null;
  const chType    = (chFirm && ch.typeId) ? chFirm.types[ch.typeId] : null;
  const phIdx     = ch?.curPhaseIdx ?? 0;
  const phaseName = chType ? chType.phases[phIdx] : null;
  const chRules   = (phaseName && chType) ? chType.rules[phaseName] : null;
  const chSize    = ch ? ch.size : (account?.size || 100000);

  // Daily loss tracking (from journal trades logged today)
  const allTrades   = LS.get('trades', []);
  const todayStr    = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short' });
  const todayPnl    = allTrades.filter(t => t.date === todayStr).reduce((s,t) => s + (t.pnl||0), 0);
  const todayLoss   = Math.abs(Math.min(0, todayPnl));
  const dailyLimAmt = chRules?.daily ? chSize * chRules.daily : null;
  const dailyUsed   = dailyLimAmt ? Math.min(dailyLimAmt, todayLoss) : todayLoss;
  const dailyRemain = dailyLimAmt ? Math.max(0, dailyLimAmt - dailyUsed) : null;

  // ── UI state ──────────────────────────────────────────────────────────────
  const [sym,     setSym]     = useState('XAUUSD');
  const [riskPct, setRiskPct] = useState('1');
  const [slPips,  setSlPips]  = useState('');
  const [tpPips,  setTpPips]  = useState('');
  const [dir,     setDir]     = useState('LONG');
  const [manual,  setManual]  = useState(false);
  const [custSz,  setCustSz]  = useState(() => chSize.toString());
  const [instGroup, setInstGroup] = useState(() => INST_MAP.XAUUSD.group);

  const inst      = INST_MAP[sym];
  const size      = manual ? (parseFloat(custSz) || chSize) : chSize;
  const riskPctN  = Math.max(0, Math.min(5, parseFloat(riskPct) || 0));
  const riskAmt   = size * riskPctN / 100;
  const slN       = parseFloat(slPips) || 0;
  const tpN       = parseFloat(tpPips) || 0;
  const lotSize   = (slN > 0 && inst) ? riskAmt / (slN * inst.pipVal) : 0;
  const tpAmt     = (tpN > 0 && lotSize > 0 && inst) ? tpN * inst.pipVal * lotSize : 0;
  const rrRatio   = (tpN > 0 && slN > 0) ? tpN / slN : 0;
  const overDaily = dailyLimAmt != null && riskAmt > (dailyRemain || 0);
  const safeMaxLots = overDaily && riskAmt > 0 ? lotSize * ((dailyRemain || 0) / riskAmt) : 0;
  const riskLevel = riskPctN < 0.5  ? { l:'Conservative', c:T.green  }
                  : riskPctN <= 1   ? { l:'Normal',        c:T.green  }
                  : riskPctN <= 2   ? { l:'Aggressive',    c:T.yellow }
                  :                   { l:'Dangerous',     c:T.red    };

  // Group instruments by category
  const grouped = Object.entries(INST_MAP).reduce((acc, [id, v]) => {
    (acc[v.group] = acc[v.group] || []).push([id, v]);
    return acc;
  }, {});
  const activeGroupItems = grouped[instGroup] || [];

  const inpSt = { width:'100%', padding:'10px 12px', background:'rgba(255,255,255,0.06)', border:`1px solid ${T.border}`, borderRadius:8, color:T.text, fontSize:14, outline:'none', fontFamily:'inherit', boxSizing:'border-box' };

  return (
    <div style={{ maxWidth:980, margin:'0 auto' }}>

      {/* ── Header ── */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end', marginBottom:24, flexWrap:'wrap', gap:12 }}>
        <div>
          <div style={{ fontWeight:900, fontSize:22, marginBottom:4 }}>⚖️ Position Sizer</div>
          <div style={{ color:T.sub, fontSize:14 }}>Calculate exact lot size for any risk & stop. Synced with your active challenge.</div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          {['LONG','SHORT'].map(d => (
            <button key={d} onClick={() => setDir(d)}
              style={{ padding:'8px 20px', border:`1px solid ${dir===d?(d==='LONG'?T.green:T.red):T.border}`, background:dir===d?(d==='LONG'?`${T.green}18`:`${T.red}18`):'transparent', borderRadius:8, color:dir===d?(d==='LONG'?T.green:T.red):T.sub, fontSize:13, fontWeight:800, cursor:'pointer' }}>
              {d === 'LONG' ? '▲ LONG' : '▼ SHORT'}
            </button>
          ))}
        </div>
      </div>

      <div className="pp-grid-ct" style={{ display:'grid', gridTemplateColumns:'1.1fr 0.9fr', gap:24 }}>

        {/* ── LEFT — inputs ── */}
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

          {/* Instrument picker */}
          <div style={{ ...card }}>
            <div style={{ color:T.muted, fontSize:11, fontWeight:700, letterSpacing:'0.09em', marginBottom:14, textTransform:'uppercase' }}>Instrument</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,minmax(0,1fr))', gap:6, marginBottom:12 }}>
              {INST_GROUPS.map(g => {
                const isActive = instGroup === g.id;
                return (
                  <button key={g.id} onClick={() => setInstGroup(g.id)}
                    style={{ minHeight:34, padding:'7px 8px', borderRadius:8, cursor:'pointer', border:`1px solid ${isActive?T.amber:T.border}`, background:isActive?'rgba(245,166,35,0.12)':'rgba(255,255,255,0.025)', color:isActive?T.amber:T.sub, fontSize:11, fontWeight:800, transition:'all 0.15s', whiteSpace:'nowrap' }}>
                    {g.label}
                  </button>
                );
              })}
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(104px,1fr))', gap:7 }}>
              {activeGroupItems.map(([id, m]) => (
                <button key={id} onClick={() => { setSym(id); setInstGroup(m.group); setSlPips(''); setTpPips(''); }}
                  style={{ minHeight:36, padding:'7px 10px', borderRadius:8, cursor:'pointer', border:`1px solid ${sym===id?T.amber:T.border}`, background:sym===id?'rgba(245,166,35,0.12)':'rgba(255,255,255,0.02)', color:sym===id?T.amber:T.sub, fontSize:12, fontWeight:sym===id?800:600, transition:'all 0.15s', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                  {m.icon} {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Parameters */}
          <div style={{ ...card }}>
            <div style={{ color:T.muted, fontSize:11, fontWeight:700, letterSpacing:'0.09em', marginBottom:16, textTransform:'uppercase' }}>Parameters</div>

            {/* Account size */}
            <div style={{ marginBottom:16 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                <label style={{ color:T.sub, fontSize:12, fontWeight:600 }}>Account Balance</label>
                <button onClick={() => setManual(m => !m)} style={{ background:'transparent', border:'none', color:T.amber, fontSize:11, cursor:'pointer', fontWeight:700, textDecoration:'underline' }}>
                  {manual ? '↩ Use challenge' : '✎ Override'}
                </button>
              </div>
              {manual
                ? <input type="number" value={custSz} onChange={e => setCustSz(e.target.value)} style={{ ...inpSt }}/>
                : <div style={{ padding:'10px 12px', background:'rgba(245,166,35,0.07)', border:'1px solid rgba(245,166,35,0.25)', borderRadius:8, fontSize:14, color:T.amber, fontWeight:700 }}>
                    ${size.toLocaleString()} {chFirm ? `· ${chFirm.name}` : '· Default'}
                  </div>
              }
            </div>

            {/* Risk % */}
            <div style={{ marginBottom:16 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                <label style={{ color:T.sub, fontSize:12, fontWeight:600 }}>Risk per trade</label>
                <span style={{ color:riskLevel.c, fontSize:12, fontWeight:700 }}>{riskLevel.l}</span>
              </div>
              <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:8 }}>
                <input type="number" min="0.1" max="5" step="0.1" value={riskPct} onChange={e => setRiskPct(e.target.value)} style={{ ...inpSt, flex:1 }}/>
                <span style={{ color:T.amber, fontWeight:700, fontSize:14, whiteSpace:'nowrap' }}>% = ${riskAmt.toFixed(0)}</span>
              </div>
              <div style={{ display:'flex', gap:6 }}>
                {[0.5, 1, 1.5, 2].map(p => (
                  <button key={p} onClick={() => setRiskPct(p.toString())}
                    style={{ flex:1, padding:'5px 0', border:`1px solid ${parseFloat(riskPct)===p?T.amber:T.border}`, background:parseFloat(riskPct)===p?'rgba(245,166,35,0.12)':'rgba(255,255,255,0.03)', borderRadius:6, color:parseFloat(riskPct)===p?T.amber:T.muted, fontSize:12, fontWeight:700, cursor:'pointer' }}>
                    {p}%
                  </button>
                ))}
              </div>
            </div>

            {/* Stop Loss */}
            <div style={{ marginBottom:14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                <label style={{ color:T.sub, fontSize:12, fontWeight:600 }}>Stop Loss</label>
                <span style={{ color:T.muted, fontSize:11 }}>{inst?.pipUnit}</span>
              </div>
              <input type="number" min="0" step="0.5"
                placeholder={`e.g. ${inst?.defSL || 20}`}
                value={slPips} onChange={e => setSlPips(e.target.value)} style={{ ...inpSt }}/>
            </div>

            {/* Take Profit */}
            <div>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                <label style={{ color:T.sub, fontSize:12, fontWeight:600 }}>Take Profit <span style={{ color:T.muted, fontWeight:400 }}>(optional)</span></label>
                <span style={{ color:T.muted, fontSize:11 }}>{inst?.pipUnit}</span>
              </div>
              <input type="number" min="0" step="0.5"
                placeholder="Leave blank to skip R:R"
                value={tpPips} onChange={e => setTpPips(e.target.value)} style={{ ...inpSt }}/>
            </div>
          </div>
        </div>

        {/* ── RIGHT — results ── */}
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

          {/* Big lot size result */}
          <div style={{ ...card, textAlign:'center', padding:'28px 16px',
            background: lotSize > 0 ? 'rgba(245,166,35,0.04)' : 'transparent',
            border: lotSize > 0 ? '1px solid rgba(245,166,35,0.3)' : `1px solid ${T.border}` }}>
            <div style={{ color:T.muted, fontSize:11, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:12 }}>Lot Size</div>
            <div style={{ fontSize:58, fontWeight:900, color:lotSize>0?T.amber:T.muted, lineHeight:1, marginBottom:6 }}>
              {slN > 0 ? lotSize.toFixed(2) : '—'}
            </div>
            <div style={{ color:T.sub, fontSize:13, marginBottom: lotSize>0?16:0 }}>standard lots · {sym}</div>
            {lotSize > 0 && (
              <div style={{ display:'flex', gap:8, justifyContent:'center', flexWrap:'wrap' }}>
                <span style={{ background:'rgba(245,166,35,0.12)', border:'1px solid rgba(245,166,35,0.25)', borderRadius:6, padding:'4px 10px', fontSize:12, fontWeight:700, color:T.amber }}>
                  {(lotSize * 10).toFixed(1)} mini
                </span>
                <span style={{ background:'rgba(245,166,35,0.07)', border:'1px solid rgba(245,166,35,0.15)', borderRadius:6, padding:'4px 10px', fontSize:12, fontWeight:600, color:T.sub }}>
                  {(lotSize * 100).toFixed(0)} micro
                </span>
              </div>
            )}
          </div>

          {/* Stats grid */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            {[
              { lbl:'Dollar Risk', val:`$${riskAmt.toFixed(0)}`,                           vc:overDaily?T.red:T.yellow },
              { lbl:'R:R Ratio',   val:rrRatio>0?`1 : ${rrRatio.toFixed(2)}`:'—',           vc:rrRatio>=2?T.green:rrRatio>0?T.yellow:T.muted },
              { lbl:'TP Profit',   val:tpAmt>0?`$${tpAmt.toFixed(0)}`:'—',                 vc:T.green },
              { lbl:'Pip Value',   val:inst?`$${inst.pipVal}/lot`:'—',                      vc:T.sub   },
            ].map(s => (
              <div key={s.lbl} style={{ ...cardS, textAlign:'center' }}>
                <div style={{ color:T.muted, fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:5 }}>{s.lbl}</div>
                <div style={{ color:s.vc, fontWeight:800, fontSize:17 }}>{s.val}</div>
              </div>
            ))}
          </div>

          {/* Daily DD limit status */}
          {dailyLimAmt ? (
            <div style={{ ...cardS,
              background:overDaily?'rgba(248,113,113,0.07)':'rgba(52,211,153,0.05)',
              border:`1px solid ${overDaily?'rgba(248,113,113,0.3)':'rgba(52,211,153,0.2)'}` }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <div style={{ color:T.sub, fontSize:12, fontWeight:700 }}>Daily Loss Limit</div>
                <Badge label={overDaily?'⚠ EXCEEDS':'✓ SAFE'} color={overDaily?T.red:T.green}/>
              </div>
              {[
                ['Limit',     `$${dailyLimAmt.toLocaleString()}`,     T.sub   ],
                ['Used today',`-$${dailyUsed.toFixed(0)}`,             dailyUsed>0?T.red:T.muted ],
                ['Remaining', `$${(dailyRemain||0).toFixed(0)}`,       (dailyRemain||0) < dailyLimAmt*0.3 ? T.red : T.green ],
              ].map(([k,v,c]) => (
                <div key={k} style={{ display:'flex', justifyContent:'space-between', fontSize:13, marginBottom:7 }}>
                  <span style={{ color:T.muted }}>{k}</span>
                  <span style={{ fontWeight:700, color:c }}>{v}</span>
                </div>
              ))}
              <div style={{ height:5, borderRadius:3, background:'rgba(255,255,255,0.08)', overflow:'hidden', marginTop:4 }}>
                <div style={{ height:'100%', borderRadius:3, transition:'width 0.4s',
                  background:overDaily?T.red:dailyUsed/dailyLimAmt>0.6?T.yellow:T.green,
                  width:`${Math.min(100, dailyUsed/dailyLimAmt*100)}%` }}/>
              </div>
            </div>
          ) : (
            <div style={{ ...cardS, background:'rgba(99,102,241,0.04)', border:'1px solid rgba(99,102,241,0.14)' }}>
              <div style={{ color:T.indigo, fontSize:12, fontWeight:700, marginBottom:6 }}>📌 No challenge linked</div>
              <div style={{ color:T.muted, fontSize:12 }}>Set up a challenge to see your daily DD limit here and get real-time safety checks.</div>
            </div>
          )}

          {/* Warning banners */}
          {overDaily && (
            <div style={{ padding:'12px 14px', background:'rgba(248,113,113,0.09)', border:'1px solid rgba(248,113,113,0.3)', borderRadius:10 }}>
              <div style={{ color:T.red, fontWeight:700, fontSize:13, marginBottom:5 }}>⚠ Exceeds Daily Buffer</div>
              <div style={{ color:T.sub, fontSize:12, lineHeight:1.7 }}>
                This trade risks ${riskAmt.toFixed(0)} but only ${(dailyRemain||0).toFixed(0)} of daily limit remains.
                Reduce to <strong style={{ color:T.amber }}>{safeMaxLots.toFixed(2)} lots</strong> to stay within limit.
              </div>
            </div>
          )}
          {riskPctN > 2 && (
            <div style={{ padding:'12px 14px', background:'rgba(251,191,36,0.07)', border:'1px solid rgba(251,191,36,0.25)', borderRadius:10 }}>
              <div style={{ color:T.yellow, fontWeight:700, fontSize:13, marginBottom:5 }}>⚡ High Risk Warning</div>
              <div style={{ color:T.sub, fontSize:12, lineHeight:1.7 }}>Risking {riskPctN}% on a prop account is very high. Most funded traders risk 0.5–1% per trade to protect their daily buffer.</div>
            </div>
          )}
          {rrRatio > 0 && rrRatio < 1.5 && (
            <div style={{ padding:'12px 14px', background:'rgba(251,191,36,0.07)', border:'1px solid rgba(251,191,36,0.25)', borderRadius:10 }}>
              <div style={{ color:T.yellow, fontWeight:700, fontSize:13, marginBottom:5 }}>📐 Low R:R</div>
              <div style={{ color:T.sub, fontSize:12, lineHeight:1.7 }}>R:R of 1:{rrRatio.toFixed(2)} requires a {(100/(1+rrRatio)*100/100).toFixed(0)}%+ win rate to break even. Aim for minimum 1:2.</div>
            </div>
          )}

          {/* Prop sizing tips */}
          <div style={{ ...cardS, background:'rgba(99,102,241,0.04)', border:'1px solid rgba(99,102,241,0.14)' }}>
            <div style={{ color:T.indigo, fontSize:11, fontWeight:700, letterSpacing:'0.08em', marginBottom:10 }}>💡 PROP SIZING RULES</div>
            {[
              'Never exceed 1% risk/trade on challenge phases',
              'Use 0.5% on high-news days to protect daily buffer',
              `${sym==='XAUUSD'?'Gold: avg daily range ≈ 150–250 pips — size accordingly':
                sym==='NAS100'?'NAS100: can gap $50+ on open — use wider SL & smaller size':
                sym==='EURUSD'?'EUR/USD: avg daily range ≈ 60–100 pips':
                sym==='BTCUSD'?'BTC: volatile — consider 0.5% max risk per trade':
                'Prop rule: protect daily buffer above all else'}`,
            ].map((tip, i, arr) => (
              <div key={i} style={{ fontSize:12, color:T.sub, paddingBottom:i<arr.length-1?8:0, marginBottom:i<arr.length-1?8:0, borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none' }}>
                · {tip}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED PRODUCT UI
// ═══════════════════════════════════════════════════════════════════════════

const SIGNAL_STATE_META = {
  LONG_NOW:   { label:'Long Now',  color:T.green },
  SHORT_NOW:  { label:'Short Now', color:T.red },
  WAIT_LONG:  { label:'Wait Long', color:T.amber },
  WAIT_SHORT: { label:'Wait Short', color:T.amber },
  WAIT_BREAK: { label:'Wait Break',color:T.indigo },
  AVOID_NEWS: { label:'Avoid News',color:T.red },
  AVOID_CHOP: { label:'Avoid Chop',color:T.muted },
  NO_TRADE:   { label:'No Trade',  color:T.muted },
};

const OUTCOME_META = {
  OPEN:    { label:'OPEN', color:T.indigo },
  TP1_HIT: { label:'TP1_HIT', color:T.green },
  TP2_HIT: { label:'TP2_HIT', color:T.green },
  SL_HIT:  { label:'SL_HIT', color:T.red },
  EXPIRED: { label:'EXPIRED', color:T.amber },
};

function SyncPill({ syncState, rtStatus, lastLoadAt }) {
  const stateLabel = syncState === 'synced' ? 'Synced' : syncState === 'offline' ? 'Demo / Offline' : 'Updating';
  const detail = syncState === 'synced'
    ? `Realtime ${rtStatus === 'live' ? 'live' : 'ready'}`
    : syncState === 'offline'
    ? 'Fallback mode'
    : 'Pulling latest rows';
  return (
    <div className={`pp-status-pill ${syncState}`}>
      <span className="pp-status-dot"/>
      <span>{stateLabel}</span>
      <span style={{ color: T.muted, fontWeight: 600 }}>{detail}</span>
      {lastLoadAt && <span style={{ color: T.muted, fontWeight: 600 }}>{timeAgo(lastLoadAt.toISOString())}</span>}
    </div>
  );
}

function ShellKpi({ label, value, sub, color = T.text }) {
  return (
    <div className="pp-panel" style={{ padding: 16 }}>
      <div style={{ color: T.muted, fontSize: 11, fontWeight: 800, letterSpacing: '.04em', marginBottom: 10 }}>{label}</div>
      <div style={{ color, fontSize: 28, fontWeight: 900, lineHeight: 1 }}>{value}</div>
      <div style={{ color: T.sub, fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>{sub}</div>
    </div>
  );
}

function MiniLineChart({ points, color = T.indigo, height = 220, label = 'No data yet' }) {
  if (!points?.length) {
    return <div style={{ height, display:'flex', alignItems:'center', justifyContent:'center', color:T.muted, fontSize:13 }}>{label}</div>;
  }
  const W = 900, H = height, PL = 12, PR = 18, PT = 12, PB = 28;
  const vals = points.map(p => p.value);
  const min = Math.min(...vals, 0);
  const max = Math.max(...vals, 0);
  const rng = max - min || 1;
  const sx = i => PL + (i / Math.max(1, points.length - 1)) * (W - PL - PR);
  const sy = v => H - PB - ((v - min) / rng) * (H - PT - PB);
  const linePts = points.map((p, i) => [sx(i), sy(p.value)]);
  const line = linePts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${linePts[linePts.length-1][0].toFixed(1)},${(H-PB).toFixed(1)} L${linePts[0][0].toFixed(1)},${(H-PB).toFixed(1)} Z`;
  const last = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', height:H }}>
      <defs>
        <linearGradient id="ppCurveFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.34"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map(step => {
        const y = PT + step * (H - PT - PB);
        return <line key={step} x1={PL} x2={W-PR} y1={y} y2={y} stroke="rgba(148,163,184,0.12)" strokeWidth="1"/>;
      })}
      {min < 0 && max > 0 && (
        <line x1={PL} x2={W-PR} y1={sy(0)} y2={sy(0)} stroke="rgba(148,163,184,0.18)" strokeWidth="1" strokeDasharray="5 5"/>
      )}
      <path d={area} fill="url(#ppCurveFill)"/>
      <path d={line} fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx={linePts[linePts.length-1][0]} cy={linePts[linePts.length-1][1]} r="4.5" fill={color}/>
      <text x={W - PR} y={18} fill={color} textAnchor="end" fontSize="12" fontWeight="800">{fmtR(last.value)}</text>
      {points.filter((_, i) => i === 0 || i === points.length - 1 || i === Math.floor(points.length / 2)).map((p, i) => (
        <text key={i} x={sx(points.indexOf(p))} y={H-8} fill={T.muted} textAnchor="middle" fontSize="10">{p.label}</text>
      ))}
    </svg>
  );
}

function SignalOutcomeFlow({ signals }) {
  const outcomeCounts = signals.reduce((acc, s) => {
    acc[s.outcome] = (acc[s.outcome] || 0) + 1;
    return acc;
  }, { OPEN: 0, TP1_HIT: 0, TP2_HIT: 0, SL_HIT: 0, EXPIRED: 0 });
  const stages = [
    { id:'signal', label:'Signal', sub:`${signals.length} analyzed`, color:T.indigo },
    { id:'open', label:'OPEN', sub:`${outcomeCounts.OPEN || 0}`, color:T.indigo },
    { id:'tp1', label:'TP1_HIT', sub:`${outcomeCounts.TP1_HIT || 0}`, color:T.green },
    { id:'tp2', label:'TP2_HIT', sub:`${outcomeCounts.TP2_HIT || 0}`, color:T.green },
    { id:'sl', label:'SL_HIT', sub:`${outcomeCounts.SL_HIT || 0}`, color:T.red },
    { id:'exp', label:'EXPIRED', sub:`${outcomeCounts.EXPIRED || 0}`, color:T.amber },
  ];
  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(6, minmax(0, 1fr))', gap: 10 }}>
      {stages.map((stage, i) => (
        <div key={stage.id} className="pp-panel" style={{ padding: 14, position:'relative', overflow:'hidden' }}>
          <div style={{ color:stage.color, fontSize:11, fontWeight:800, letterSpacing:'.05em' }}>{stage.label}</div>
          <div style={{ color:T.text, fontSize:24, fontWeight:900, marginTop:8 }}>{stage.sub}</div>
          {i < stages.length - 1 && (
            <div style={{ position:'absolute', right:-9, top:'50%', transform:'translateY(-50%)', color:'rgba(148,163,184,0.32)', fontSize:22 }}>→</div>
          )}
        </div>
      ))}
    </div>
  );
}

function DayHeatmap({ signals }) {
  const daily = {};
  signals.filter(s => s.outcome !== 'OPEN').forEach(s => {
    const day = new Date(s.outcome_at || s.created_at).toISOString().slice(0, 10);
    if (!daily[day]) daily[day] = { r: 0, n: 0, w: 0, l: 0 };
    daily[day].r += safeNum(s.pnl_r, 0) || 0;
    daily[day].n += 1;
    if (s.outcome === 'TP1_HIT' || s.outcome === 'TP2_HIT') daily[day].w += 1;
    if (s.outcome === 'SL_HIT') daily[day].l += 1;
  });
  const days = Array.from({ length: 28 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (27 - i));
    const key = d.toISOString().slice(0, 10);
    return { key, label: d.toLocaleDateString('en-GB', { month:'short', day:'numeric' }), ...daily[key] };
  });
  const maxAbs = Math.max(1, ...days.map(d => Math.abs(d.r || 0)));
  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(7, minmax(0, 1fr))', gap:8 }}>
      {days.map(day => {
        const r = safeNum(day.r, 0) || 0;
        const opacity = 0.14 + (Math.abs(r) / maxAbs) * 0.56;
        const bg = r > 0 ? `rgba(16,185,129,${opacity})` : r < 0 ? `rgba(239,68,68,${opacity})` : 'rgba(255,255,255,0.04)';
        return (
          <div key={day.key} className="pp-panel" style={{ padding:10, background:bg, minHeight:68 }}>
            <div style={{ color:T.muted, fontSize:10, marginBottom:10 }}>{day.label}</div>
            <div style={{ color:r > 0 ? T.green : r < 0 ? T.red : T.sub, fontWeight:900, fontSize:14 }}>{fmtR(r)}</div>
            <div style={{ color:T.sub, fontSize:10, marginTop:6 }}>{day.n || 0} trades</div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL JOURNAL — per-signal notes in localStorage
// ═══════════════════════════════════════════════════════════════════════════
function SignalNote({ signalId }) {
  const [open, setOpen]   = useState(false);
  const [text, setText]   = useState('');
  const [saved, setSaved] = useState(false);

  const key = `pp_note_${signalId}`;

  // Load on mount
  useEffect(() => {
    try { setText(localStorage.getItem(key) || ''); } catch {}
  }, [signalId]);

  const save = () => {
    try {
      if (text.trim()) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch {}
  };

  const hasNote = text.trim().length > 0;

  return (
    <div style={{ marginTop:6 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: hasNote ? 'rgba(245,158,11,0.1)' : 'rgba(255,255,255,0.04)',
          border: `1px solid ${hasNote ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.1)'}`,
          borderRadius:8, padding:'3px 10px',
          color: hasNote ? '#F59E0B' : '#64748B',
          fontSize:11, cursor:'pointer', fontWeight:600,
          display:'flex', alignItems:'center', gap:5,
        }}
      >
        <span style={{ fontSize:11 }}>📝</span>
        {open ? 'Close note' : (hasNote ? 'View note' : 'Add note')}
      </button>

      {open && (
        <div style={{
          marginTop:6, padding:'10px 12px',
          background:'rgba(245,158,11,0.05)',
          border:'1px solid rgba(245,158,11,0.18)',
          borderRadius:10,
        }}>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Your thoughts, observations, lesson learned…"
            rows={3}
            style={{
              width:'100%', resize:'vertical', boxSizing:'border-box',
              background:'rgba(255,255,255,0.04)',
              border:'1px solid rgba(255,255,255,0.1)',
              borderRadius:8, padding:'8px 10px',
              color:'#F1F5F9', fontSize:12, fontFamily:'inherit',
              outline:'none',
            }}
          />
          <div style={{ display:'flex', justifyContent:'flex-end', marginTop:6 }}>
            <button
              onClick={save}
              style={{
                padding:'4px 14px', borderRadius:8, fontSize:11, fontWeight:700, cursor:'pointer',
                background: saved ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.15)',
                border: `1px solid ${saved ? 'rgba(16,185,129,0.4)' : 'rgba(245,158,11,0.35)'}`,
                color: saved ? '#10B981' : '#F59E0B',
                transition:'all 0.2s',
              }}
            >
              {saved ? '✓ Saved' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// POSITION SIZING CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════
function PosSizer({ symbol = '', entry = 0, sl = 0, tp1 = 0, tp2 = 0, accountBalance = 100000 }) {
  const [open,    setOpen]    = useState(false);
  const [riskPct, setRiskPct] = useState(1);

  const slDist = Math.abs(entry - sl);
  if (!entry || !sl || slDist === 0) return null;

  const { contractSize, pipSize, label: pipLabel } = getInstrumentSpec(symbol);

  const riskUsd   = accountBalance * (riskPct / 100);
  const slPips    = slDist / pipSize;
  const pipValue  = contractSize * pipSize;                    // $ per pip per 1 lot
  const lotSize   = riskUsd / (slPips * pipValue);
  const rrRatio1  = tp1 ? (Math.abs(tp1 - entry) / slDist) : null;
  const rrRatio2  = tp2 ? (Math.abs(tp2 - entry) / slDist) : null;

  return (
    <div style={{ marginTop:8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background:'rgba(59,130,246,0.1)', border:'1px solid rgba(59,130,246,0.25)',
          borderRadius:8, padding:'3px 10px', color:'#60A5FA', fontSize:11,
          cursor:'pointer', fontWeight:600, display:'flex', alignItems:'center', gap:5,
        }}
      >
        <span style={{ fontSize:12 }}>📐</span>
        {open ? 'Hide sizer' : 'Position size'}
      </button>

      {open && (
        <div style={{
          marginTop:8, padding:'12px 14px',
          background:'rgba(59,130,246,0.06)', border:'1px solid rgba(59,130,246,0.18)',
          borderRadius:10,
        }}>
          {/* Risk % slider */}
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
            <label style={{ color:'#94A3B8', fontSize:11, whiteSpace:'nowrap' }}>Risk</label>
            <input
              type="range" min="0.25" max="3" step="0.25"
              value={riskPct}
              onChange={e => setRiskPct(Number(e.target.value))}
              style={{ flex:1, accentColor:'#3B82F6', cursor:'pointer' }}
            />
            <span style={{ color:'#F1F5F9', fontWeight:900, fontSize:13, minWidth:36, textAlign:'right' }}>
              {riskPct}%
            </span>
          </div>

          {/* Results grid */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            {[
              { label:'Risk $',   val:`$${riskUsd.toLocaleString('en',{maximumFractionDigits:0})}`, color:'#EF4444' },
              { label:'SL pips',  val:slPips.toFixed(1),                                            color:'#94A3B8' },
              { label:pipLabel,   val:lotSize < 0.001 ? '<0.001' : lotSize.toFixed(3),              color:'#F1F5F9' },
              { label:'pip val',  val:`$${pipValue.toFixed(2)}/lot`,                                color:'#94A3B8' },
            ].map(({ label, val, color }) => (
              <div key={label} style={{
                background:'rgba(255,255,255,0.04)', borderRadius:8, padding:'6px 10px',
              }}>
                <div style={{ color:'#64748B', fontSize:10, marginBottom:2 }}>{label}</div>
                <div style={{ color, fontSize:13, fontWeight:900 }}>{val}</div>
              </div>
            ))}
          </div>

          {/* R:R ratios */}
          {(rrRatio1 || rrRatio2) && (
            <div style={{ display:'flex', gap:10, marginTop:8, fontSize:12 }}>
              {rrRatio1 && (
                <span style={{ color:'#94A3B8' }}>
                  TP1 R:R <strong style={{ color:rrRatio1 >= 2 ? '#10B981' : rrRatio1 >= 1.5 ? '#F59E0B' : '#EF4444' }}>
                    1:{rrRatio1.toFixed(1)}
                  </strong>
                </span>
              )}
              {rrRatio2 && (
                <span style={{ color:'#94A3B8' }}>
                  TP2 R:R <strong style={{ color:rrRatio2 >= 3 ? '#10B981' : rrRatio2 >= 2 ? '#F59E0B' : '#EF4444' }}>
                    1:{rrRatio2.toFixed(1)}
                  </strong>
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE PRICE TICKER
// ═══════════════════════════════════════════════════════════════════════════
function LivePriceTicker() {
  const PAIRS = [
    { sym:'XAU/USD', label:'Gold',      flag:'🥇' },
    { sym:'EUR/USD', label:'EUR/USD',   flag:'🇪🇺' },
    { sym:'GBP/USD', label:'GBP/USD',   flag:'🇬🇧' },
    { sym:'GBP/JPY', label:'GBP/JPY',   flag:'🔵' },
    { sym:'NAS100',  label:'NAS100',    flag:'📊' },
  ];
  const [prices, setPrices]   = useState({});
  const [prev,   setPrev]     = useState({});
  const [ts,     setTs]       = useState(null);
  const [err,    setErr]      = useState(false);

  const fetchPrices = useCallback(async () => {
    try {
      const syms = PAIRS.map(p => p.sym);
      const priceMap = await mdFetchPrices(syms);
      setPrev(prev => ({ ...prev, ...prices }));
      const next = {};
      PAIRS.forEach(p => { if (priceMap[p.sym] != null) next[p.sym] = priceMap[p.sym]; });
      if (Object.keys(next).length) {
        setPrices(next);
        setTs(new Date());
        setErr(false);
      }
    } catch {
      setErr(true);
    }
  }, []);

  useEffect(() => {
    fetchPrices();
    const id = setInterval(fetchPrices, 300000); // 5 min — preserve API quota (800 req/day free)
    return () => clearInterval(id);
  }, [fetchPrices]);

  return (
    <div style={{
      display:'flex', gap: 0, overflowX:'auto',
      background:'rgba(255,255,255,0.03)',
      border:'1px solid rgba(255,255,255,0.07)',
      borderRadius: 12,
    }}>
      {PAIRS.map((p, i) => {
        const cur  = prices[p.sym];
        const prv  = prev[p.sym];
        const up   = cur != null && prv != null && cur > prv;
        const down = cur != null && prv != null && cur < prv;
        const col  = up ? '#34D399' : down ? '#F87171' : '#94A3B8';
        const arrow = up ? '▲' : down ? '▼' : '–';
        const change = (cur != null && prv != null) ? ((cur - prv) / prv * 100) : null;

        return (
          <div key={p.sym} style={{
            flex:'0 0 auto', minWidth: 140,
            padding:'11px 18px',
            borderRight: i < PAIRS.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
            display:'flex', flexDirection:'column', gap: 3,
          }}>
            <div style={{ display:'flex', alignItems:'center', gap: 6 }}>
              <span style={{ fontSize: 13 }}>{p.flag}</span>
              <span style={{ color:'#94A3B8', fontSize: 10, fontWeight: 800, letterSpacing:'.05em' }}>{p.label}</span>
            </div>
            <div style={{ fontFamily:'monospace', fontSize: 15, fontWeight: 900, color: cur ? col : '#475569' }}>
              {cur ? fmtPrice(p.sym, cur) : '—'}
            </div>
            {change != null && (
              <div style={{ fontSize: 10, fontWeight: 700, color: col }}>
                {arrow} {Math.abs(change).toFixed(4)}%
              </div>
            )}
          </div>
        );
      })}
      <div style={{
        marginLeft:'auto', padding:'11px 16px',
        display:'flex', flexDirection:'column', justifyContent:'center', gap: 3,
        borderLeft:'1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 9, color:'#475569', fontWeight: 700, letterSpacing:'.06em' }}>LIVE · 60s</div>
        <div style={{ fontSize: 9, color:'#475569' }}>
          {ts ? ts.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—'}
        </div>
        {err && <div style={{ fontSize: 9, color:'#F87171' }}>fetch error</div>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TODAY SCREEN — Morning briefing: Can I trade? What's active? Daily P&L.
// ═══════════════════════════════════════════════════════════════════════════
function TodayScreen({ data, phase, accountView, trades, onNavigate }) {
  const ch       = LS.get('challenge', null);
  const firm     = ch ? PROP_FIRMS[ch.firmId] : null;
  const type     = (firm && ch?.typeId) ? firm.types[ch.typeId] : null;
  const phIdx    = ch?.curPhaseIdx ?? 0;
  const phName   = type ? type.phases[phIdx] : null;
  const rules    = (phName && type) ? type.rules[phName] : null;
  const size     = ch ? ch.size : (accountView?.size || 100000);
  const curPnl   = ch?.curPnl || 0;

  // Today's trades
  const todayStr    = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short' });
  const todayTrades = trades.filter(t => t.date === todayStr);
  const todayPnl    = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const todayLoss   = Math.abs(Math.min(0, todayPnl));
  const wins        = todayTrades.filter(t => t.win).length;
  const losses      = todayTrades.filter(t => !t.win).length;

  // Challenge limits
  const dailyLim     = rules?.daily ? size * rules.daily : null;
  const maxDDLimit   = rules ? size * (rules.maxDD || 0.1) : null;
  const dailyUsedPct = dailyLim ? (todayLoss / dailyLim) * 100 : 0;
  const maxDDUsed    = Math.abs(Math.min(0, curPnl));
  const maxDDPct     = maxDDLimit ? (maxDDUsed / maxDDLimit) * 100 : 0;

  // CAN I TRADE TODAY?
  const canTrade = (() => {
    if (dailyLim && todayLoss >= dailyLim * 0.99)
      return { verdict:'STOP',    color:T.red,    icon:'🛑', msg:'Daily loss limit reached. No more trades today.' };
    if (maxDDLimit && maxDDUsed >= maxDDLimit * 0.99)
      return { verdict:'STOP',    color:T.red,    icon:'🛑', msg:'Max drawdown breached. Do not open new positions.' };
    if (dailyLim && dailyUsedPct >= 70)
      return { verdict:'CAREFUL', color:T.amber,  icon:'⚠️', msg:`${(100-dailyUsedPct).toFixed(0)}% of daily limit left. Reduce size significantly.` };
    if (maxDDLimit && maxDDPct >= 60)
      return { verdict:'CAREFUL', color:T.amber,  icon:'⚠️', msg:'Getting close to max drawdown. Trade only A-grade setups.' };
    return { verdict:'YES',     color:T.green,  icon:'✅',
      msg: dailyLim
        ? `$${(dailyLim - todayLoss).toFixed(0)} daily budget remaining. Clear to trade.`
        : 'No limits hit. Clear to trade today.' };
  })();

  // Market session
  const sess = currentSession();

  // Signals
  const allSignals    = data.signals || [];
  const activeSignals = allSignals.filter(s =>
    ['LONG_NOW','SHORT_NOW'].includes(s.signal_state) && s.outcome === 'OPEN'
  );
  const today = new Date().toISOString().slice(0,10);
  const todaySigCount = allSignals.filter(s => s.created_at?.startsWith(today)).length;

  return (
    <div className="pp-grid" style={{ gap:20 }}>

      {/* ── NEWS EVENTS STRIP ── */}
      <NewsStrip compact={false}/>

      {/* ── CAN I TRADE? HERO BANNER ── */}
      <div className="pp-panel" style={{
        padding:'28px 32px',
        background: canTrade.verdict === 'YES' ? 'rgba(16,185,129,0.06)'
                  : canTrade.verdict === 'CAREFUL' ? 'rgba(245,166,35,0.06)'
                  : 'rgba(239,68,68,0.07)',
        border: `1.5px solid ${canTrade.verdict === 'YES' ? 'rgba(16,185,129,0.28)'
                              : canTrade.verdict === 'CAREFUL' ? 'rgba(245,166,35,0.32)'
                              : 'rgba(239,68,68,0.35)'}`,
      }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:20 }}>
          <div>
            <div style={{ color:T.muted, fontSize:10, fontWeight:800, letterSpacing:'.1em', marginBottom:12, textTransform:'uppercase' }}>Can I Trade Today?</div>
            <div style={{ display:'flex', alignItems:'center', gap:16 }}>
              <div style={{ fontSize:48, lineHeight:1 }}>{canTrade.icon}</div>
              <div>
                <div style={{ fontSize:38, fontWeight:900, color:canTrade.color, lineHeight:1 }}>{canTrade.verdict}</div>
                <div style={{ color:T.sub, fontSize:13, marginTop:8, lineHeight:1.6, maxWidth:400 }}>{canTrade.msg}</div>
              </div>
            </div>
          </div>
          <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
            <button onClick={() => onNavigate('signals')} style={{ padding:'11px 22px', background:`linear-gradient(135deg,#6366F1,#4F46E5)`, border:'none', borderRadius:10, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer' }}>
              ⚡ Run Signals
            </button>
            <button onClick={() => onNavigate('challenge')} style={{ padding:'11px 22px', background:'rgba(255,255,255,0.05)', border:`1px solid ${T.border}`, borderRadius:10, color:T.sub, fontSize:13, fontWeight:600, cursor:'pointer' }}>
              ◎ Challenge →
            </button>
            <button onClick={() => onNavigate('journal')} style={{ padding:'11px 22px', background:'rgba(255,255,255,0.05)', border:`1px solid ${T.border}`, borderRadius:10, color:T.sub, fontSize:13, fontWeight:600, cursor:'pointer' }}>
              + Log Trade
            </button>
          </div>
        </div>
      </div>

      {/* ── 4-STAT STRIP ── */}
      <div className="pp-today-strip">
        {[
          { icon: sess.active ? '🟢' : '⭕', label:'Session Now', value:sess.name, color:sess.color },
          { icon:'⚡', label:'Active Signals', value:activeSignals.length, color:activeSignals.length > 0 ? T.green : T.muted },
          { icon:'📋', label:'Trades Today',   value:todayTrades.length,   color:todayTrades.length > 0 ? T.amber : T.muted },
          { icon: todayPnl >= 0 ? '📈' : '📉', label:"Today's P&L", value:`${todayPnl >= 0 ? '+' : ''}$${todayPnl}`, color:todayPnl > 0 ? T.green : todayPnl < 0 ? T.red : T.muted },
        ].map(({ icon, label, value, color }) => (
          <div key={label} className="pp-today-cell">
            <div style={{ fontSize:20, marginBottom:6 }}>{icon}</div>
            <div style={{ color:T.muted, fontSize:10, fontWeight:700, letterSpacing:'.06em', textTransform:'uppercase' }}>{label}</div>
            <div style={{ color, fontSize:20, fontWeight:900, marginTop:4 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* ── RISK LIMITS (only if challenge configured) ── */}
      {ch && rules && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }} className="pp-grid-2x">
          <div className="pp-panel" style={{ padding:20 }}>
            <div style={{ fontWeight:700, fontSize:14, marginBottom:14 }}>Daily Risk Budget</div>
            {dailyLim ? (
              <>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                  <span style={{ color:T.sub, fontSize:13 }}>Used today</span>
                  <span style={{ color: dailyUsedPct > 70 ? T.red : T.amber, fontWeight:800, fontSize:14 }}>
                    ${todayLoss.toFixed(0)} / ${dailyLim.toLocaleString()}
                  </span>
                </div>
                <div style={{ height:10, background:'rgba(255,255,255,0.06)', borderRadius:6, overflow:'hidden', marginBottom:10 }}>
                  <div style={{ height:'100%', width:`${Math.min(100, dailyUsedPct).toFixed(1)}%`, background: dailyUsedPct < 50 ? T.green : dailyUsedPct < 80 ? T.amber : T.red, borderRadius:6, transition:'width 0.6s ease' }}/>
                </div>
                <div style={{ color:T.muted, fontSize:12 }}>
                  Remaining: <span style={{ color:T.green, fontWeight:700 }}>${Math.max(0, dailyLim - todayLoss).toFixed(0)}</span>
                  {' · '}Max 1 trade: <span style={{ color:T.amber, fontWeight:700 }}>${(Math.max(0, dailyLim - todayLoss) * 0.5).toFixed(0)}</span>
                </div>
              </>
            ) : (
              <div style={{ color:T.muted, fontSize:13, padding:'12px 0' }}>No daily limit for this phase.</div>
            )}
          </div>
          <div className="pp-panel" style={{ padding:20 }}>
            <div style={{ fontWeight:700, fontSize:14, marginBottom:14 }}>Max Drawdown Buffer</div>
            {maxDDLimit ? (
              <>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                  <span style={{ color:T.sub, fontSize:13 }}>Used overall</span>
                  <span style={{ color: maxDDPct > 70 ? T.red : T.amber, fontWeight:800, fontSize:14 }}>
                    ${maxDDUsed.toFixed(0)} / ${maxDDLimit.toLocaleString()}
                  </span>
                </div>
                <div style={{ height:10, background:'rgba(255,255,255,0.06)', borderRadius:6, overflow:'hidden', marginBottom:10 }}>
                  <div style={{ height:'100%', width:`${Math.min(100, maxDDPct).toFixed(1)}%`, background: maxDDPct < 50 ? T.green : maxDDPct < 80 ? T.amber : T.red, borderRadius:6, transition:'width 0.6s ease' }}/>
                </div>
                <div style={{ color:T.muted, fontSize:12 }}>
                  Balance floor: <span style={{ color:T.green, fontWeight:700 }}>${(size - maxDDLimit).toLocaleString()}</span>
                  {' · '}Current: <span style={{ color: curPnl >= 0 ? T.green : T.red, fontWeight:700 }}>${(size + curPnl).toLocaleString()}</span>
                </div>
              </>
            ) : (
              <div style={{ color:T.muted, fontSize:13, padding:'12px 0' }}>No drawdown limit configured.</div>
            )}
          </div>
        </div>
      )}

      {/* ── ACTIVE SIGNALS PREVIEW ── */}
      {activeSignals.length > 0 && (
        <div className="pp-panel" style={{ padding:20 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
            <div style={{ fontWeight:700, fontSize:15 }}>⚡ Active Signals Now</div>
            <button onClick={() => onNavigate('signals')} style={{ padding:'6px 14px', background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.28)', borderRadius:8, color:'#818CF8', fontSize:12, fontWeight:700, cursor:'pointer' }}>
              Signal Engine →
            </button>
          </div>
          {activeSignals.slice(0, 3).map(s => (
            <div key={s.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'11px 14px', borderRadius:10, marginBottom:8, background:'rgba(255,255,255,0.03)', border:`1px solid ${T.border}` }}>
              <div style={{ display:'flex', gap:12, alignItems:'center' }}>
                <div style={{ width:8, height:8, borderRadius:'50%', background: s.signal_state === 'LONG_NOW' ? T.green : T.red }}/>
                <div>
                  <div style={{ fontWeight:700, fontSize:14 }}>{s.symbol}</div>
                  <div style={{ color:T.muted, fontSize:12 }}>{s.signal_state === 'LONG_NOW' ? 'LONG' : 'SHORT'} · {s.session_name || 'Unknown session'}</div>
                </div>
              </div>
              <button onClick={() => {
                LS.set('pendingSignal', { sym: s.symbol, dir: s.signal_state === 'LONG_NOW' ? 'LONG' : 'SHORT' });
                onNavigate('analyze');
              }} style={{ padding:'7px 14px', background:'rgba(255,255,255,0.05)', border:`1px solid ${T.border}`, borderRadius:8, color:T.sub, fontSize:12, fontWeight:600, cursor:'pointer' }}>
                Validate →
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── TODAY'S SESSION SUMMARY ── */}
      <div className="pp-panel" style={{ padding:20 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
          <div style={{ fontWeight:700, fontSize:15 }}>Today's Session</div>
          <button onClick={() => onNavigate('journal')} style={{ padding:'6px 14px', background:'rgba(255,255,255,0.04)', border:`1px solid ${T.border}`, borderRadius:8, color:T.sub, fontSize:12, cursor:'pointer' }}>
            Open Journal →
          </button>
        </div>
        {todayTrades.length === 0 ? (
          <div style={{ textAlign:'center', padding:'32px 0', color:T.muted }}>
            <div style={{ fontSize:36, marginBottom:10 }}>🌅</div>
            <div style={{ fontSize:14, marginBottom:6 }}>No trades logged yet today.</div>
            <div style={{ fontSize:12, color:T.muted, marginBottom:18 }}>Find a setup, validate it, then log the result.</div>
            <button onClick={() => onNavigate('signals')} style={{ padding:'10px 22px', background:`linear-gradient(135deg,#6366F1,#4F46E5)`, border:'none', borderRadius:10, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer' }}>
              ⚡ Find a Setup →
            </button>
          </div>
        ) : (
          <div>
            <div style={{ display:'flex', gap:24, marginBottom:14, flexWrap:'wrap' }}>
              {[
                { lbl:'Trades', val:todayTrades.length,                                 vc:T.text  },
                { lbl:'Wins',   val:wins,                                                vc:T.green },
                { lbl:'Losses', val:losses,                                              vc:T.red   },
                { lbl:'Net P&L',val:`${todayPnl >= 0 ? '+' : ''}$${todayPnl}`,          vc:todayPnl >= 0 ? T.green : T.red },
              ].map(s => (
                <div key={s.lbl}>
                  <div style={{ color:T.muted, fontSize:11 }}>{s.lbl}</div>
                  <div style={{ color:s.vc, fontWeight:800, fontSize:20 }}>{s.val}</div>
                </div>
              ))}
            </div>
            {todayTrades.slice(0, 3).map(t => (
              <div key={t.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'9px 12px', borderRadius:9, marginBottom:6, background:'rgba(255,255,255,0.03)', border:`1px solid ${T.border}` }}>
                <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                  <div style={{ width:7, height:7, borderRadius:'50%', background:t.win ? T.green : T.red }}/>
                  <span style={{ fontWeight:700, fontSize:13 }}>{t.sym}</span>
                  <span style={{ color:t.dir === 'LONG' ? T.green : T.red, fontSize:12, fontWeight:600 }}>{t.dir}</span>
                </div>
                <span style={{ color:t.pnl >= 0 ? T.green : T.red, fontWeight:800, fontSize:14 }}>{t.pnl >= 0 ? '+' : ''}${t.pnl}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── NO CHALLENGE SET ── */}
      {!ch && (
        <div style={{ textAlign:'center', padding:'36px 24px', background:'rgba(255,255,255,0.02)', border:`1px solid ${T.border}`, borderRadius:16 }}>
          <div style={{ fontSize:44, marginBottom:14 }}>🎯</div>
          <div style={{ fontWeight:800, fontSize:17, color:T.sub, marginBottom:8 }}>No challenge configured</div>
          <div style={{ fontSize:13, color:T.muted, marginBottom:20, lineHeight:1.7 }}>
            Set up your prop firm challenge to see daily limits, max drawdown buffer, and precise trade decisions.
          </div>
          <button onClick={() => onNavigate('challenge')} style={{ padding:'11px 26px', background:`linear-gradient(135deg,${T.amber},#D97706)`, border:'none', borderRadius:10, color:'#000', fontSize:13, fontWeight:800, cursor:'pointer' }}>
            Set Up Challenge →
          </button>
        </div>
      )}

    </div>
  );
}

function ExecutiveDashboard({ data, phase }) {
  const { show: showToast } = useToast();
  const account       = data.account || {};
  const positions     = data.positions || [];
  const allSignals    = data.signals || [];
  const openPositions = positions.filter(p => p.status === 'OPEN' || p.status === 'TP1_HIT');
  const activeSignals = allSignals.filter(s => ['LONG_NOW','SHORT_NOW'].includes(s.signal_state) && s.outcome === 'OPEN').slice(0, 6);
  const [analyzing, setAnalyzing] = useState(false);

  const equity  = safeNum(account.equity,  safeNum(account.balance, 100000)) || 100000;
  const balance = safeNum(account.balance, 100000) || 100000;
  const openPnl = safeNum(account.open_pnl, 0) || 0;
  const dailyPnl= safeNum(account.daily_pnl_usd, 0) || 0;
  const equityGain = equity - 100000;
  const equityPct  = (equityGain / 100000) * 100;
  const equityColor = equityGain >= 0 ? T.green : T.red;

  const dailyMode = (() => {
    const limit = balance * ((safeNum(data.settings?.daily_loss_limit_pct, 2) || 2) / 100);
    const used  = Math.abs(Math.min(0, dailyPnl));
    const pct   = limit > 0 ? (used / limit) * 100 : 0;
    return pct < 40 ? { label:'NORMAL', color:T.green, icon:'✅' }
         : pct < 75 ? { label:'DEFENSIVE', color:T.amber, icon:'⚠️' }
                    : { label:'STOP', color:T.red, icon:'🛑' };
  })();

  // Session detector
  const sessionNow = (() => {
    const h = new Date().getUTCHours();
    if (h >= 7  && h < 12) return { name:'London', color:'#3B82F6', icon:'🇬🇧' };
    if (h >= 12 && h < 17) return { name:'New York', color:'#A78BFA', icon:'🗽' };
    if (h >= 0  && h < 7)  return { name:'Asian', color:'#F59E0B', icon:'🌏' };
    return { name:'Off-Hours', color:T.muted, icon:'🌙' };
  })();

  // Today's signals count
  const today = new Date().toISOString().slice(0,10);
  const todaySignals = allSignals.filter(s => s.created_at?.startsWith(today)).length;
  const resolvedToday = allSignals.filter(s => s.outcome !== 'OPEN' && (s.outcome_at || s.created_at)?.startsWith(today)).length;

  // Equity curve points
  const equityPoints = (data.snapshots || []).slice(-60).map(s => ({
    label: new Date(s.created_at).toLocaleDateString('en-GB', { month:'short', day:'numeric' }),
    value: safeNum(s.equity, safeNum(s.balance, 0)) || 0,
  }));

  // Session win rates
  const sessionGroups = {};
  allSignals.filter(s => s.outcome !== 'OPEN').forEach(s => {
    const key = sessionLabel(s.session_name);
    if (!sessionGroups[key]) sessionGroups[key] = { w:0, l:0 };
    if (['TP1_HIT','TP2_HIT'].includes(s.outcome)) sessionGroups[key].w++;
    if (s.outcome === 'SL_HIT') sessionGroups[key].l++;
  });
  const sessionRows = Object.entries(sessionGroups).map(([k, v]) => {
    const total = v.w + v.l;
    return { name:k, total, wr: total ? (v.w / total) * 100 : 0 };
  }).sort((a, b) => b.wr - a.wr).slice(0, 4);

  const handleAnalyzeNow = async () => {
    setAnalyzing(true);
    showToast('⚡ Запускаем автоанализ всех инструментов…', 'signal', 3000);
    try {
      const headers = await getAuthedJsonHeaders();
      const r = await fetch(`${SB_URL}/functions/v1/auto-analyze`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ symbols:['XAU/USD','EUR/USD','GBP/USD','USD/JPY','NAS100','BTC/USD'] }),
      });
      if (r.ok) {
        showToast('✅ Анализ завершён! Сигналы обновляются…', 'success', 5000);
        setTimeout(() => data.refresh('updating'), 2500);
      } else {
        showToast('⚠️ Edge Function не отвечает. Запусти bash deploy.sh', 'warn', 6000);
      }
    } catch {
      showToast('❌ Нужен вход в аккаунт или нет связи с Edge Function.', 'error', 6000);
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="pp-grid" style={{ gap:20 }}>

      {/* ── LIVE PRICE TICKER ── */}
      <LivePriceTicker/>

      {/* ── HERO ROW ── */}
      <div className="pp-panel" style={{ padding:28, background:'rgba(255,255,255,0.06)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:24, flexWrap:'wrap' }}>

          {/* Big equity number */}
          <div>
            <div className="pp-section-label">PAPER ACCOUNT · FTMO CHALLENGE</div>
            <div className="pp-hero-equity" style={{ color:equityColor }}>
              <AnimNum value={equity} prefix="$" decimals={0} color={equityColor}/>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:16, marginTop:10 }}>
              <span style={{ color:equityColor, fontSize:16, fontWeight:700 }}>
                {equityGain >= 0 ? '+' : ''}<AnimNum value={equityGain} prefix="$" decimals={0} color={equityColor}/>
                {' '}({equityPct >= 0 ? '+' : ''}{equityPct.toFixed(2)}%)
              </span>
              <span style={{ color:T.muted, fontSize:13 }}>vs start $100,000</span>
            </div>
            <div style={{ display:'flex', gap:20, marginTop:14 }}>
              <span style={{ color:T.sub, fontSize:13 }}>Open P&L <strong style={{ color: openPnl >= 0 ? T.green : T.red }}>{fmtUsd(openPnl)}</strong></span>
              <span style={{ color:T.sub, fontSize:13 }}>Today <strong style={{ color: dailyPnl >= 0 ? T.green : T.red }}>{fmtUsd(dailyPnl)}</strong></span>
              <span style={{ color:T.sub, fontSize:13 }}>Mode <strong style={{ color:dailyMode.color }}>{dailyMode.icon} {dailyMode.label}</strong></span>
            </div>
          </div>

          {/* Analyze Now CTA */}
          <div style={{ display:'flex', flexDirection:'column', gap:12, alignItems:'flex-end' }}>
            <button
              className={`pp-analyze-btn${analyzing ? '' : ' idle'}`}
              onClick={handleAnalyzeNow}
              disabled={analyzing}
            >
              {analyzing
                ? <><span style={{ display:'inline-block', animation:'pp-spin 0.8s linear infinite', width:16, height:16, border:'2px solid rgba(255,255,255,0.4)', borderTopColor:'#fff', borderRadius:'50%' }}/> Analyzing…</>
                : <>⚡ Analyze Now</>
              }
            </button>
            <div style={{ color:T.muted, fontSize:11, textAlign:'right' }}>
              {activeSignals.length > 0
                ? <><span style={{ color:T.green }}>●</span> {activeSignals.length} actionable signals</>
                : <><span style={{ color:T.muted }}>○</span> No actionable signals</>
              }
            </div>
            {data.memory?.[0]?.market_notes && (
              <div style={{ maxWidth:280, padding:'10px 14px', background:'rgba(129,140,248,0.08)', border:'1px solid rgba(129,140,248,0.2)', borderRadius:10 }}>
                <div style={{ fontSize:10, color:'#818CF8', fontWeight:800, marginBottom:5, letterSpacing:'.06em' }}>🧠 AI READ</div>
                <p style={{ color:T.sub, fontSize:12, lineHeight:1.6, margin:0 }}>{data.memory[0].market_notes.slice(0,140)}…</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── TODAY STRIP ── */}
      <div className="pp-today-strip">
        {[
          { icon:sessionNow.icon, label:'Session', value:sessionNow.name, color:sessionNow.color },
          { icon:'⚡', label:'Signals today', value:todaySignals, color:T.indigo },
          { icon:'✅', label:'Resolved today', value:resolvedToday, color: resolvedToday > 0 ? T.green : T.muted },
          { icon:'📋', label:'Open positions', value:openPositions.length, color: openPositions.length > 0 ? T.amber : T.muted },
        ].map(({ icon, label, value, color }) => (
          <div key={label} className="pp-today-cell">
            <div style={{ fontSize:18, marginBottom:6 }}>{icon}</div>
            <div style={{ color:T.muted, fontSize:10, fontWeight:700, letterSpacing:'.06em', textTransform:'uppercase' }}>{label}</div>
            <div style={{ color, fontSize:22, fontWeight:900, marginTop:4 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* ── EQUITY CURVE + SESSION EDGE ── */}
      <div className="pp-grid pp-grid-2x">
        <div className="pp-panel" style={{ padding:20 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
            <div>
              <div className="pp-section-title">Equity Curve</div>
              <div className="pp-section-sub">Live snapshots from paper account</div>
            </div>
            <SyncPill syncState={data.syncState} rtStatus={data.rtStatus} lastLoadAt={data.lastLoadAt}/>
          </div>
          {equityPoints.length >= 2
            ? <MiniLineChart points={equityPoints} color={equityColor} label=""/>
            : (
              <div style={{ height:140, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:10, color:T.muted, fontSize:13 }}>
                <div style={{ fontSize:32 }}>📈</div>
                <div>Curve fills after first equity snapshot</div>
                <div style={{ fontSize:11, color:T.muted }}>Run update-paper-positions to start tracking</div>
              </div>
            )
          }
        </div>

        <div className="pp-panel" style={{ padding:20 }}>
          <div className="pp-section-title" style={{ marginBottom:14 }}>Session Edge</div>
          <div className="pp-grid" style={{ gap:10 }}>
            {sessionRows.length ? sessionRows.map(row => (
              <div key={row.name}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
                  <span style={{ color:T.sub, fontSize:13 }}>{row.name}</span>
                  <span style={{ color: row.wr >= 50 ? T.green : T.red, fontSize:13, fontWeight:800 }}>{row.wr.toFixed(0)}% <span style={{ color:T.muted, fontWeight:400 }}>({row.total})</span></span>
                </div>
                <div style={{ height:6, background:'rgba(255,255,255,0.07)', borderRadius:999, overflow:'hidden' }}>
                  <div style={{ width:`${row.wr}%`, height:'100%', background: row.wr >= 50 ? T.green : T.red, borderRadius:999, transition:'width 0.8s ease' }}/>
                </div>
              </div>
            )) : (
              <div style={{ color:T.muted, fontSize:13, textAlign:'center', padding:'20px 0' }}>
                <div style={{ fontSize:28, marginBottom:8 }}>🎯</div>
                Waiting for resolved outcomes.<br/>
                <span style={{ fontSize:11 }}>update-outcomes runs every hour automatically.</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── ACTIVE SIGNALS (with confidence ring + TP/SL bar) ── */}
      <div className="pp-grid pp-grid-2x">
        <div className="pp-panel" style={{ padding:20 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
            <div className="pp-section-title">Active Signals</div>
            {activeSignals.length > 0 && (
              <span style={{ background:'rgba(59,130,246,0.15)', color:'#93C5FD', border:'1px solid rgba(59,130,246,0.3)', borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:800 }}>
                {activeSignals.length} LIVE
              </span>
            )}
          </div>
          <div className="pp-grid" style={{ gap:10 }}>
            {activeSignals.length ? activeSignals.map(signal => {
              const meta = SIGNAL_STATE_META[signal.signal_state] || SIGNAL_STATE_META.NO_TRADE;
              const conf = safeNum(signal.confidence, 0);
              return (
                <div key={signal.id} className="pp-panel-solid pp-signal-card" style={{ padding:14 }}>
                  <div style={{ display:'flex', gap:12, alignItems:'flex-start' }}>
                    <ConfRing score={conf}/>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
                        <div style={{ fontWeight:900, fontSize:15 }}>{signal.symbol}</div>
                        <div style={{ color:meta.color, fontSize:11, fontWeight:900, background:`${meta.color}15`, border:`1px solid ${meta.color}30`, borderRadius:6, padding:'2px 8px' }}>{meta.label}</div>
                      </div>
                      <div style={{ color:T.muted, fontSize:11, marginTop:3 }}>{sessionLabel(signal.session_name)} · {signal.timeframe || '15m'} · {timeAgo(signal.created_at)}</div>
                      <div style={{ display:'flex', gap:14, marginTop:8, flexWrap:'wrap', fontSize:12 }}>
                        {signal.price && <span style={{ color:T.sub }}>Entry <strong style={{ color:T.text }}>{fmtPrice(signal.symbol, signal.price)}</strong></span>}
                        {signal.tp1   && <span style={{ color:T.sub }}>TP1 <strong style={{ color:'#34D399' }}>{fmtPrice(signal.symbol, signal.tp1)}</strong></span>}
                        {signal.tp2   && <span style={{ color:T.sub }}>TP2 <strong style={{ color:T.green }}>{fmtPrice(signal.symbol, signal.tp2)}</strong></span>}
                        {signal.sl    && <span style={{ color:T.sub }}>SL <strong style={{ color:T.red }}>{fmtPrice(signal.symbol, signal.sl)}</strong></span>}
                      </div>
                      <TpSlBar entry={signal.price} tp1={signal.tp1} tp2={signal.tp2} sl={signal.sl} direction={signal.direction}/>
                      <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                        <PosSizer symbol={signal.symbol} entry={safeNum(signal.price)} sl={safeNum(signal.sl)} tp1={safeNum(signal.tp1)} tp2={safeNum(signal.tp2)} accountBalance={balance}/>
                        <SignalNote signalId={signal.id}/>
                      </div>
                    </div>
                  </div>
                </div>
              );
            }) : (
              <div style={{ padding:'28px 20px', textAlign:'center', color:T.muted }}>
                <div style={{ fontSize:36, marginBottom:10 }}>⚡</div>
                <div style={{ fontSize:14, fontWeight:700, color:T.sub, marginBottom:6 }}>No actionable signals</div>
                <div style={{ fontSize:12, lineHeight:1.6 }}>Click <strong style={{ color:T.indigo }}>Analyze Now</strong> above to scan<br/>XAU/USD, EUR/USD, GBP/USD, NAS100…</div>
              </div>
            )}
          </div>
        </div>

        <div className="pp-panel" style={{ padding:20 }}>
          <div className="pp-section-title" style={{ marginBottom:14 }}>Paper Positions</div>
          <div className="pp-grid" style={{ gap:10 }}>
            {openPositions.length ? openPositions.slice(0, 5).map(pos => {
              const pnl = safeNum(pos.pnl_usd, 0) || safeNum(pos.partial_pnl_usd, 0) || 0;
              const pnlR = safeNum(pos.pnl_r, 0) || safeNum(pos.partial_pnl_r, 0) || 0;
              return (
                <div key={pos.id} className="pp-panel-solid pp-signal-card" style={{ padding:14 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12 }}>
                    <div>
                      <div style={{ fontWeight:900, fontSize:15 }}>{pos.symbol}</div>
                      <div style={{ color: pos.direction === 'LONG' ? T.green : T.red, fontSize:11, fontWeight:800, marginTop:3 }}>{pos.direction} · {pos.status}</div>
                    </div>
                    <div style={{ textAlign:'right' }}>
                      <div style={{ color: pnl >= 0 ? T.green : T.red, fontWeight:900, fontSize:16 }}>{fmtUsd(pnl)}</div>
                      <div style={{ color: pnlR >= 0 ? T.green : T.red, fontSize:12, fontWeight:700 }}>{fmtR(pnlR)}</div>
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:14, marginTop:10, fontSize:12, flexWrap:'wrap' }}>
                    <span style={{ color:T.sub }}>Entry <strong style={{ color:T.text }}>{pos.entry_price ? Number(pos.entry_price).toFixed(2) : '—'}</strong></span>
                    <span style={{ color:T.sub }}>Risk <strong style={{ color:T.text }}>{fmtUsd(pos.risk_usd || 0)}</strong></span>
                    <span style={{ color:T.sub }}>Opened <strong style={{ color:T.text }}>{timeAgo(pos.opened_at)}</strong></span>
                  </div>
                  <TpSlBar entry={safeNum(pos.entry_price)} tp1={safeNum(pos.tp1)} tp2={safeNum(pos.tp2)} sl={safeNum(pos.sl)} direction={pos.direction}/>
                </div>
              );
            }) : (
              <div style={{ padding:'28px 20px', textAlign:'center', color:T.muted }}>
                <div style={{ fontSize:36, marginBottom:10 }}>📋</div>
                <div style={{ fontSize:14, fontWeight:700, color:T.sub, marginBottom:6 }}>No open positions</div>
                <div style={{ fontSize:12, lineHeight:1.6 }}>Paper trades open automatically<br/>when auto-analyze fires LONG_NOW / SHORT_NOW</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function OutcomeAnalyticsPanel({ data }) {
  const signals = data.signals || [];
  const resolved = signals.filter(s => s.outcome !== 'OPEN');
  const wins = resolved.filter(s => ['TP1_HIT', 'TP2_HIT'].includes(s.outcome));
  const losses = resolved.filter(s => s.outcome === 'SL_HIT');
  const decided = wins.length + losses.length;
  const wr = decided ? (wins.length / decided) * 100 : 0;
  const totalR = resolved.reduce((sum, s) => sum + (safeNum(s.pnl_r, 0) || 0), 0);
  const grossProfit = wins.reduce((sum, s) => sum + Math.abs(safeNum(s.pnl_r, 0) || 0), 0);
  const grossLoss = losses.reduce((sum, s) => sum + Math.abs(safeNum(s.pnl_r, 0) || 0), 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy = decided ? ((wins.length / decided) * avgWin) - ((losses.length / decided) * avgLoss) : 0;
  const rCurve = resolved
    .filter(s => safeNum(s.pnl_r) != null)
    .sort((a, b) => new Date(a.outcome_at || a.created_at) - new Date(b.outcome_at || b.created_at))
    .reduce((acc, s, idx) => {
      const prev = acc[idx - 1]?.value || 0;
      acc.push({
        label: new Date(s.outcome_at || s.created_at).toLocaleDateString('en-GB', { month:'short', day:'numeric' }),
        value: prev + (safeNum(s.pnl_r, 0) || 0),
      });
      return acc;
    }, []);
  const sessionRows = {};
  const instrumentRows = {};
  resolved.forEach(s => {
    const sess = sessionLabel(s.session_name);
    const inst = s.symbol || 'Unknown';
    if (!sessionRows[sess]) sessionRows[sess] = { w:0, l:0 };
    if (!instrumentRows[inst]) instrumentRows[inst] = { w:0, l:0 };
    if (['TP1_HIT', 'TP2_HIT'].includes(s.outcome)) {
      sessionRows[sess].w += 1;
      instrumentRows[inst].w += 1;
    }
    if (s.outcome === 'SL_HIT') {
      sessionRows[sess].l += 1;
      instrumentRows[inst].l += 1;
    }
  });
  const toRows = (rows) => Object.entries(rows).map(([name, v]) => {
    const total = v.w + v.l;
    return { name, total, wr: total ? (v.w / total) * 100 : 0 };
  }).sort((a, b) => b.wr - a.wr);
  return (
    <div className="pp-grid" style={{ gap:20 }}>
      <div className="pp-grid pp-grid-4x">
        <ShellKpi label="Expectancy" value={fmtR(expectancy)} sub={`Profit factor ${grossLoss ? (grossProfit / grossLoss).toFixed(2) : grossProfit ? '∞' : '0'}x`} color={expectancy >= 0 ? T.green : T.red}/>
        <ShellKpi label="Session Win Rate" value={`${wr.toFixed(1)}%`} sub={`${decided} decided outcomes`} color={wr >= 50 ? T.green : T.red}/>
        <ShellKpi label="Resolved R" value={fmtR(totalR)} sub={`${resolved.length} resolved · ${signals.filter(s => s.outcome === 'OPEN').length} open`} color={totalR >= 0 ? T.green : T.red}/>
        <ShellKpi label="Avg Win / Loss" value={`${avgWin.toFixed(2)}R / ${avgLoss.toFixed(2)}R`} sub="Outcome tracker / real data" color={T.indigo}/>
      </div>

      <div className="pp-panel" style={{ padding:20 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap', marginBottom:16 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:16 }}>Signal → Outcome Flow</div>
            <div style={{ color:T.sub, fontSize:12, marginTop:4 }}>OPEN → TP1_HIT / TP2_HIT / SL_HIT / EXPIRED</div>
          </div>
          <SyncPill syncState={data.syncState} rtStatus={data.rtStatus} lastLoadAt={data.lastLoadAt}/>
        </div>
        <SignalOutcomeFlow signals={signals}/>
      </div>

      <div className="pp-grid pp-grid-2x">
        <div className="pp-panel" style={{ padding:20 }}>
          <div style={{ fontWeight:800, fontSize:16, marginBottom:14 }}>Live R Equity Curve</div>
          <MiniLineChart points={rCurve} color={totalR >= 0 ? T.green : T.red} label="Resolved outcomes will build the curve here"/>
        </div>
        <div className="pp-panel" style={{ padding:20 }}>
          <div style={{ fontWeight:800, fontSize:16, marginBottom:14 }}>Heatmap by Day</div>
          <DayHeatmap signals={signals}/>
        </div>
      </div>

      <div className="pp-grid pp-grid-2x">
        <div className="pp-panel" style={{ padding:20 }}>
          <div style={{ fontWeight:800, fontSize:16, marginBottom:14 }}>Win Rate by Session</div>
          <div className="pp-grid" style={{ gap:10 }}>
            {toRows(sessionRows).slice(0, 6).map(row => (
              <div key={row.name}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                  <span style={{ color:T.sub, fontSize:12 }}>{row.name}</span>
                  <span style={{ color: row.wr >= 50 ? T.green : T.red, fontWeight:800, fontSize:12 }}>{row.wr.toFixed(0)}%</span>
                </div>
                <div style={{ height:8, background:'rgba(255,255,255,.06)', borderRadius:999, overflow:'hidden' }}>
                  <div style={{ height:'100%', width:`${row.wr}%`, background: row.wr >= 50 ? T.green : T.red, borderRadius:999 }}/>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="pp-panel" style={{ padding:20 }}>
          <div style={{ fontWeight:800, fontSize:16, marginBottom:14 }}>Win Rate by Instrument</div>
          <div className="pp-grid" style={{ gap:10 }}>
            {toRows(instrumentRows).slice(0, 6).map(row => (
              <div key={row.name}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                  <span style={{ color:T.sub, fontSize:12 }}>{row.name}</span>
                  <span style={{ color: row.wr >= 50 ? T.green : T.red, fontWeight:800, fontSize:12 }}>{row.wr.toFixed(0)}%</span>
                </div>
                <div style={{ height:8, background:'rgba(255,255,255,.06)', borderRadius:999, overflow:'hidden' }}>
                  <div style={{ height:'100%', width:`${row.wr}%`, background: row.wr >= 50 ? T.green : T.red, borderRadius:999 }}/>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="pp-panel" style={{ padding:20 }}>
        <div style={{ fontWeight:800, fontSize:16, marginBottom:14 }}>Recent Outcomes</div>
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
            <thead>
              <tr style={{ borderBottom:`1px solid ${T.border}` }}>
                {['Symbol','State','Session','Outcome','P&L R','Confidence','Updated'].map(h => (
                  <th key={h} style={{ padding:'8px 10px', textAlign:'left', color:T.muted, fontWeight:700 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {signals.slice(0, 16).map(s => {
                const stateMeta = SIGNAL_STATE_META[s.signal_state] || SIGNAL_STATE_META.NO_TRADE;
                const outcomeMeta = OUTCOME_META[s.outcome] || OUTCOME_META.OPEN;
                return (
                  <tr key={s.id} style={{ borderBottom:`1px solid rgba(148,163,184,.08)` }}>
                    <td style={{ padding:'10px', color:T.text, fontWeight:800 }}>{s.symbol}</td>
                    <td style={{ padding:'10px', color:stateMeta.color, fontWeight:700 }}>{stateMeta.label}</td>
                    <td style={{ padding:'10px', color:T.sub }}>{sessionLabel(s.session_name)}</td>
                    <td style={{ padding:'10px' }}><span style={{ color:outcomeMeta.color, fontWeight:800 }}>{outcomeMeta.label}</span></td>
                    <td style={{ padding:'10px', color:(safeNum(s.pnl_r, 0) || 0) >= 0 ? T.green : T.red, fontWeight:800 }}>{fmtR(s.pnl_r)}</td>
                    <td style={{ padding:'10px', color:T.sub }}>{safeNum(s.confidence, 0)}%</td>
                    <td style={{ padding:'10px', color:T.muted }}>{timeAgo(s.outcome_at || s.updated_at || s.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SignalsWorkspace({ onNavigate }) {
  const SYMS      = ['XAU/USD','EUR/USD','GBP/USD','NAS100','GBP/JPY','BTC/USD','ETH/USD'];
  const TFS       = [{ v:'15min', l:'15m' }, { v:'1h', l:'1h' }, { v:'4h', l:'4h' }];
  const DIRS      = ['AUTO','LONG','SHORT'];

  const [sym,    setSym]    = useState(() => LS.get('sig_sym', 'XAU/USD'));
  const [tf,     setTf]     = useState(() => LS.get('sig_tf', '1h'));
  const [dir,    setDir]    = useState('AUTO');
  const [result, setResult] = useState(null);
  const [candles, setCandles] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,  setError]  = useState(null);
  const [demoMode, setDemoMode] = useState(false);
  const ranOnce = React.useRef(false);

  // ── Algo Engine: fetch latest SMC signal + open positions for this symbol ──
  const [algoSignal,    setAlgoSignal]    = useState(null);
  const [algoPosition,  setAlgoPosition]  = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // Latest SMC signal for this symbol
        const sigRes = await fetch(
          `${SB_URL}/rest/v1/smc_signals?symbol=eq.${encodeURIComponent(sym)}&select=verdict,confidence,htf_trend,sweep_occurred,mss_occurred,reasoning_codes,session_name,created_at&order=created_at.desc&limit=1`,
          { headers: SB_HDR }
        );
        const sigData = await sigRes.json();
        if (!cancelled && Array.isArray(sigData) && sigData.length) {
          setAlgoSignal(sigData[0]);
        } else if (!cancelled) {
          setAlgoSignal(null);
        }

        // Open paper position for this symbol
        const posRes = await fetch(
          `${SB_URL}/rest/v1/paper_positions?symbol=eq.${encodeURIComponent(sym)}&status=eq.OPEN&select=direction,entry_price,sl_price,tp1_price,confidence,opened_at&order=opened_at.desc&limit=1`,
          { headers: SB_HDR }
        );
        const posData = await posRes.json();
        if (!cancelled && Array.isArray(posData) && posData.length) {
          setAlgoPosition(posData[0]);
        } else if (!cancelled) {
          setAlgoPosition(null);
        }
      } catch { /* ignore */ }
    };
    load();
    return () => { cancelled = true; };
  }, [sym]);

  const runAnalysis = async () => {
    setLoading(true);
    setError(null);
    setDemoMode(false);

    // Try cache first (per symbol+tf, valid 15 min)
    const CACHE_KEY = `ohlcv_${sym}_${tf}`;
    const cached = LS.get(CACHE_KEY, null);

    let cvt = null;

    // Try live API — Yahoo Finance via market-data Edge Function (free, no limit)
    try {
      cvt = await mdFetchOHLCV(sym, tf, 200);
      // Cache successful fetch
      LS.set(CACHE_KEY, { data: cvt, ts: Date.now() });
    } catch (apiErr) {
      // Fallback: use cached data if < 4 hours old
      if (cached && (Date.now() - cached.ts) < 4 * 3600000) {
        cvt = cached.data;
        setError(`📡 API unavailable — showing cached data from ${Math.round((Date.now()-cached.ts)/60000)}m ago`);
        setDemoMode(true);
      } else {
        // Final fallback: seeded synthetic OHLCV
        cvt = _generateDemoOHLCV(sym, 200);
        setError('📡 Live data unavailable — running on demo prices. Real patterns, synthetic data.');
        setDemoMode(true);
      }
    }

    try {
      setCandles(cvt);
      const closes     = cvt.map(c => c.v);
      const price      = closes[closes.length - 1];
      const ema20val   = _ema(closes, 20);
      const ema50val   = _ema(closes, 50);
      const ema200val  = closes.length >= 200 ? _ema(closes, 200) : 0;
      // AUTO direction: use full indicator bias, not just EMA20/50
      // This mirrors auto-analyze's htfTrend logic so both engines start from the same bias
      const htfBull = ema20val > ema50val && price > ema50val && (ema200val === 0 || price > ema200val);
      const htfBear = ema20val < ema50val && price < ema50val && (ema200val === 0 || price < ema200val);
      const rsiVal   = _rsi(closes);
      const macdVal  = _macd(closes);
      let autoScore  = 0;
      if (htfBull)          autoScore += 3;
      if (htfBear)          autoScore -= 3;
      if (rsiVal > 55)      autoScore -= 1;
      if (rsiVal < 45)      autoScore += 1;
      if (macdVal.bullish)  autoScore += 2;
      if (macdVal.bearish)  autoScore -= 2;
      const autoDir = autoScore >= 0 ? 'LONG' : 'SHORT';
      const effectDir  = dir === 'AUTO' ? autoDir : dir;

      // Compute numeric SL/TP levels for display (mirrors _runAnalysis internals)
      const pip   = sym === 'NAS100' ? 1 : sym === 'XAU/USD' ? 0.1 : 0.0001;
      const atrVal = _atr(cvt);
      const slPips  = Math.max(1, Math.round((atrVal / pip) * 1.2));
      const tp1Pips = Math.round(slPips * 2.0);
      const tp2Pips = Math.round(slPips * 3.2);
      const slDist   = slPips  * pip;
      const tp1Dist  = tp1Pips * pip;
      const tp2Dist  = tp2Pips * pip;
      const slNum  = effectDir === 'LONG' ? price - slDist  : price + slDist;
      const tp1Num = effectDir === 'LONG' ? price + tp1Dist : price - tp1Dist;
      const tp2Num = effectDir === 'LONG' ? price + tp2Dist : price - tp2Dist;

      const analysis = _runAnalysis({
        candles: cvt,
        dir: effectDir,
        sym,
        account: { size: 100000, todayPnL: 0 },
        phase: 's1',
        newsEvents: [],
      });

      setResult({
        ...analysis,
        direction: effectDir,
        autoDir,
        price,
        slNum, tp1Num, tp2Num,
        tf,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Auto-run once on first mount (restores last analysis on tab switch)
  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    runAnalysis();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist symbol + tf selection
  useEffect(() => { LS.set('sig_sym', sym); }, [sym]);
  useEffect(() => { LS.set('sig_tf', tf); }, [tf]);

  const verdictColor = result
    ? result.verdict === result.direction ? T.green
    : result.verdict === 'NO TRADE' ? T.red
    : T.amber
    : T.muted;

  return (
    <div className="pp-grid" style={{ gap: 20 }}>

      {/* ── Controls ── */}
      <div className="pp-panel" style={{ padding: 20 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 18, flexWrap:'wrap', gap: 8 }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 17 }}>⚡ Signal Engine</div>
            <div style={{ color: T.sub, fontSize: 12, marginTop: 3 }}>SMC · EMA · RSI · MACD · BB · <span style={{color:T.teal}}>Yahoo Finance · Free · No API key</span></div>
          </div>
        </div>

        <div style={{ display:'flex', gap: 16, flexWrap:'wrap', alignItems:'flex-end' }}>
          {/* Symbol */}
          <div>
            <div style={{ color: T.muted, fontSize: 10, fontWeight: 800, letterSpacing:'.07em', marginBottom: 7 }}>SYMBOL</div>
            <div style={{ display:'flex', gap: 5 }}>
              {SYMS.map(s => (
                <button key={s} onClick={() => { setSym(s); setResult(null); }}
                  className={`pp-btn${sym === s ? ' pp-btn-primary' : ''}`}
                  style={{ fontSize: 11, padding: '6px 9px' }}>{s}</button>
              ))}
            </div>
          </div>

          {/* Timeframe */}
          <div>
            <div style={{ color: T.muted, fontSize: 10, fontWeight: 800, letterSpacing:'.07em', marginBottom: 7 }}>TIMEFRAME</div>
            <div style={{ display:'flex', gap: 5 }}>
              {TFS.map(t => (
                <button key={t.v} onClick={() => { setTf(t.v); setResult(null); }}
                  className={`pp-btn${tf === t.v ? ' pp-btn-primary' : ''}`}
                  style={{ fontSize: 11, padding: '6px 12px' }}>{t.l}</button>
              ))}
            </div>
          </div>

          {/* Direction */}
          <div>
            <div style={{ color: T.muted, fontSize: 10, fontWeight: 800, letterSpacing:'.07em', marginBottom: 7 }}>DIRECTION</div>
            <div style={{ display:'flex', gap: 5 }}>
              {DIRS.map(d => (
                <button key={d} onClick={() => setDir(d)}
                  className={`pp-btn${dir === d ? ' pp-btn-primary' : ''}`}
                  style={{ fontSize: 11, padding: '6px 12px' }}>{d}</button>
              ))}
            </div>
          </div>

          <button onClick={runAnalysis} disabled={loading}
            className="pp-btn pp-btn-primary"
            style={{ height: 36, minWidth: 148, fontWeight: 800, fontSize: 13 }}>
            {loading ? '⏳ Analyzing…' : '⚡ Run Analysis'}
          </button>
        </div>

        {error && (
          <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8,
            background: demoMode ? 'rgba(245,158,11,0.08)' : 'rgba(239,68,68,0.08)',
            border: `1px solid ${demoMode ? 'rgba(245,158,11,0.3)' : 'rgba(239,68,68,0.2)'}`,
            color: demoMode ? T.amber : T.red, fontSize: 12 }}>
            {error}
          </div>
        )}
      </div>

      {/* ── Result ── */}
      {result && (
        <div className="pp-panel" style={{ padding: 22 }}>

          {demoMode && (
            <div style={{ marginBottom: 14, padding: '8px 14px', borderRadius: 8, background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.25)', display:'flex', alignItems:'center', gap: 10 }}>
              <span style={{ fontSize: 14 }}>🔶</span>
              <span style={{ color: T.amber, fontSize: 12, fontWeight: 700 }}>DEMO MODE</span>
              <span style={{ color: T.sub, fontSize: 12 }}>— TA analysis is real, price data is synthetic. Live data will resume automatically when Yahoo Finance API is reachable.</span>
            </div>
          )}

          {/* ── Conflict / Consensus banner ── */}
          {(() => {
            const algoDir = algoSignal
              ? (['LONG_NOW','WAIT_LONG'].includes(algoSignal.verdict) ? 'LONG'
                :['SHORT_NOW','WAIT_SHORT'].includes(algoSignal.verdict) ? 'SHORT'
                : null)
              : null;
            const posDir = algoPosition?.direction || null;
            const activeAlgoDir = posDir || algoDir;
            const taDir = result.direction;
            const conflict = activeAlgoDir && taDir && activeAlgoDir !== taDir;
            const confirmed = activeAlgoDir && taDir && activeAlgoDir === taDir;

            if (conflict) return (
              <div style={{ marginBottom: 14, padding: '12px 16px', borderRadius: 10,
                background: 'rgba(239,68,68,0.09)', border: '1px solid rgba(239,68,68,0.3)',
                display:'flex', alignItems:'flex-start', gap: 12 }}>
                <span style={{ fontSize: 20, flexShrink: 0 }}>⚡</span>
                <div>
                  <div style={{ color: T.red, fontSize: 13, fontWeight: 800, marginBottom: 4 }}>
                    ENGINE CONFLICT — TA says {taDir} · Algo has {activeAlgoDir} {posDir ? 'position OPEN' : 'signal'}
                  </div>
                  <div style={{ color: T.sub, fontSize: 12, lineHeight: 1.6 }}>
                    These engines use different methods — TA reads short-term momentum (EMA/RSI/MACD),
                    while the Algo engine reads market structure (SMC sweep+MSS on 15m+1h).
                    When they conflict, <strong style={{ color: T.text }}>trust the Algo engine for entries</strong> —
                    it uses the same logic as your paper trades.
                    {posDir && <> The Algo LONG is currently open — do not manually short against it without closing it first.</>}
                  </div>
                </div>
              </div>
            );

            if (confirmed) return (
              <div style={{ marginBottom: 14, padding: '10px 16px', borderRadius: 10,
                background: 'rgba(16,185,129,0.07)', border: '1px solid rgba(16,185,129,0.25)',
                display:'flex', alignItems:'center', gap: 12 }}>
                <span style={{ fontSize: 18 }}>✅</span>
                <div style={{ color: '#34D399', fontSize: 12, fontWeight: 700 }}>
                  ENGINES ALIGNED — TA and Algo both signal {taDir}. High-conviction setup.
                </div>
              </div>
            );

            return null;
          })()}

          {/* ── Algo Engine reference card ── */}
          {algoSignal && (
            <div style={{ marginBottom: 14, padding: '12px 16px', borderRadius: 10,
              background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.2)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#818CF8', letterSpacing:'.06em' }}>🤖 ALGO ENGINE (SMC/ICT)</div>
                <div style={{ fontSize: 10, color: T.muted }}>{timeAgo(algoSignal.created_at)}</div>
              </div>
              <div style={{ display:'flex', gap: 14, flexWrap:'wrap', fontSize: 12 }}>
                <span style={{ color: T.sub }}>Verdict: <strong style={{ color:
                  ['LONG_NOW','WAIT_LONG'].includes(algoSignal.verdict) ? T.green :
                  ['SHORT_NOW','WAIT_SHORT'].includes(algoSignal.verdict) ? T.red : T.muted
                }}>{algoSignal.verdict}</strong></span>
                <span style={{ color: T.sub }}>Confidence: <strong style={{ color: T.text }}>{algoSignal.confidence}%</strong></span>
                <span style={{ color: T.sub }}>HTF: <strong style={{ color:
                  algoSignal.htf_trend === 'bullish' ? T.green :
                  algoSignal.htf_trend === 'bearish' ? T.red : T.muted
                }}>{(algoSignal.htf_trend||'—').toUpperCase()}</strong></span>
                {algoSignal.sweep_occurred && <span style={{ color:'#F59E0B', fontWeight:700 }}>⚡ Sweep</span>}
                {algoSignal.mss_occurred   && <span style={{ color:'#34D399', fontWeight:700 }}>✓ MSS</span>}
              </div>
              {algoPosition && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(99,102,241,0.15)',
                  fontSize: 11, color: algoPosition.direction === 'LONG' ? T.green : T.red, fontWeight: 700 }}>
                  📋 Open {algoPosition.direction} position — Entry {Number(algoPosition.entry_price).toFixed(2)}
                  {algoPosition.sl_price ? ` · SL ${Number(algoPosition.sl_price).toFixed(2)}` : ''}
                  {algoPosition.tp1_price ? ` · TP1 ${Number(algoPosition.tp1_price).toFixed(2)}` : ''}
                </div>
              )}
            </div>
          )}

          {/* Header row */}
          <div style={{ display:'flex', gap: 20, alignItems:'flex-start', flexWrap:'wrap', marginBottom: 18 }}>

            {/* Conf ring + verdict */}
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap: 8 }}>
              <ConfRing score={result.confidence} size={80}/>
              <div style={{ fontWeight: 900, fontSize: 12, letterSpacing:'.05em', color: verdictColor }}>
                {result.verdict}
              </div>
              <div style={{ fontSize: 10, color: T.muted }}>confidence</div>
            </div>

            {/* Symbol + price + direction */}
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ display:'flex', alignItems:'center', gap: 10, marginBottom: 6, flexWrap:'wrap' }}>
                <div style={{ fontWeight: 900, fontSize: 22, letterSpacing:'-.02em' }}>{sym}</div>
                <div style={{
                  fontSize: 11, fontWeight: 800, padding: '3px 10px', borderRadius: 6,
                  background: result.direction === 'LONG' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                  color: result.direction === 'LONG' ? T.green : T.red,
                }}>
                  {result.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}
                </div>
                {dir === 'AUTO' && (
                  <div style={{ fontSize: 10, color: T.muted, fontStyle:'italic' }}>auto-detected</div>
                )}
                <div style={{ fontSize: 10, color: T.muted, marginLeft:'auto' }}>
                  News risk: <b style={{ color: result.newsRisk === 'HIGH' ? T.red : result.newsRisk === 'MED' ? T.amber : T.green }}>{result.newsRisk}</b>
                </div>
              </div>

              <div style={{ fontFamily:'monospace', fontSize: 28, fontWeight: 900, marginBottom: 6 }}>
                {fmtPrice(sym, result.price)}
              </div>

              <TpSlBar
                entry={result.price}
                tp1={result.tp1Num}
                tp2={result.tp2Num}
                sl={result.slNum}
                direction={result.direction}
              />
            </div>

            {/* Levels table */}
            <div style={{ minWidth: 148 }}>
              {[
                ['Entry', result.price,   T.text],
                ['SL',    result.slNum,   T.red],
                ['TP1',   result.tp1Num,  '#34D399'],
                ['TP2',   result.tp2Num,  T.green],
              ].map(([lbl, val, col]) => (
                <div key={lbl} style={{ display:'flex', justifyContent:'space-between', gap: 20, marginBottom: 8 }}>
                  <span style={{ color: T.muted, fontSize: 11, fontWeight: 700 }}>{lbl}</span>
                  <span style={{ color: col, fontSize: 12, fontWeight: 800, fontFamily:'monospace' }}>
                    {fmtPrice(sym, val)}
                  </span>
                </div>
              ))}
              <div style={{ borderTop:`1px solid ${T.border}`, paddingTop: 8, fontSize: 10, color: T.sub }}>
                R:R 1:{(Math.abs(result.tp1Num - result.price) / Math.abs(result.price - result.slNum)).toFixed(1)} / 1:{(Math.abs(result.tp2Num - result.price) / Math.abs(result.price - result.slNum)).toFixed(1)}
              </div>
            </div>
          </div>

          {/* TA factors */}
          <div style={{ display:'flex', flexWrap:'wrap', gap: 7, marginBottom: 14 }}>
            {result.factors.map((f, i) => (
              <div key={i} style={{
                padding: '5px 11px', borderRadius: 8, fontSize: 11,
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
              }}>
                <span style={{ color: T.muted, fontWeight: 700 }}>{f.k}: </span>
                <span style={{ color: f.c, fontWeight: 600 }}>{f.v}</span>
              </div>
            ))}
          </div>

          {/* Rationale */}
          <div style={{
            padding: '13px 16px', borderRadius: 10, marginBottom: 12,
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
            fontSize: 12, color: T.sub, lineHeight: 1.75,
          }}>
            {result.rationale}
          </div>

          {/* Compliance */}
          <div style={{
            padding: '10px 14px', borderRadius: 8, marginBottom: 14,
            background: result.compliance === 'WARNING' ? 'rgba(239,68,68,0.07)' : 'rgba(16,185,129,0.06)',
            border: `1px solid ${result.compliance === 'WARNING' ? 'rgba(239,68,68,0.18)' : 'rgba(16,185,129,0.14)'}`,
            fontSize: 12, color: result.compliance === 'WARNING' ? T.red : '#34D399',
          }}>
            {result.compliance === 'WARNING' ? '⚠️' : '✅'} {result.compNote}
          </div>

          {/* PosSizer + Journal */}
          <div style={{ display:'flex', gap: 12, flexWrap:'wrap' }}>
            <PosSizer
              symbol={sym}
              entry={result.price}
              sl={result.slNum}
              tp1={result.tp1Num}
              tp2={result.tp2Num}
              accountBalance={100000}
            />
            <SignalNote signalId={`manual_${sym}_${tf}`}/>
          </div>

          {/* ── Workflow actions ── */}
          <div style={{ display:'flex', gap:10, marginTop:14, flexWrap:'wrap' }}>
            {onNavigate && (
              <button onClick={() => {
                LS.set('pendingSignal', {
                  sym,
                  dir:   result.direction,
                  price: result.price,
                  sl:    result.slNum,
                  tp1:   result.tp1Num,
                  tp2:   result.tp2Num,
                  tf,
                  confidence: result.confidence,
                });
                onNavigate('analyze');
              }} style={{ flex:1, padding:'12px 0', background:`linear-gradient(135deg,#6366F1,#4F46E5)`, border:'none', borderRadius:10, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer' }}>
                ◬ Validate This Setup in Analyze →
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {!result && !loading && (
        <div style={{
          textAlign:'center', padding: '64px 24px',
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 16, color: T.muted,
        }}>
          <div style={{ fontSize: 44, marginBottom: 14 }}>⚡</div>
          <div style={{ fontWeight: 800, fontSize: 17, color: T.sub, marginBottom: 8 }}>
            Select a symbol and hit Run Analysis
          </div>
          <div style={{ fontSize: 13, maxWidth: 360, margin:'0 auto', lineHeight: 1.7 }}>
            Live OHLCV data → SMC structure · EMA trend · RSI · MACD · Bollinger Bands → confidence score + trade parameters
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsWorkbench({ data, accountView, onUpdateAccount, plan }) {
  const [localSettings, setLocalSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [prefs, setPrefs] = useState(() => LS.get('ui_prefs', { theme:'dark', push:true, sound:false, summaries:true }));

  // ── Telegram state ──────────────────────────────────────────────────────
  const [tgToken,  setTgToken]  = useState(() => LS.get('tg_token', ''));
  const [tgChatId, setTgChatId] = useState(() => LS.get('tg_chat_id', ''));
  const [tgTest,   setTgTest]   = useState({ loading: false, result: null });

  const saveTgCreds = () => {
    LS.set('tg_token',   tgToken);
    LS.set('tg_chat_id', tgChatId);
  };

  const testTelegram = async () => {
    setTgTest({ loading: true, result: null });
    try {
      const r = await fetch(`${SB_URL}/functions/v1/telegram-bot`, {
        method: 'POST',
        headers: { ...SB_JSON_HDR },
        body: JSON.stringify({ mode: 'status', chat_id: tgChatId || undefined }),
      });
      const json = await r.json().catch(() => ({}));
      if (r.ok && json.ok) {
        setTgTest({ loading: false, result: { ok: true, msg: '✅ Message sent! Check your Telegram.' } });
      } else {
        setTgTest({ loading: false, result: { ok: false, msg: json.error || `HTTP ${r.status}` } });
      }
    } catch (e) {
      setTgTest({ loading: false, result: { ok: false, msg: e.message } });
    }
  };

  useEffect(() => {
    setLocalSettings(data.settings ? { ...data.settings } : null);
  }, [data.settings]);

  const setField = (key, value) => setLocalSettings(prev => ({ ...(prev || {}), [key]: value }));
  const saveSettings = async () => {
    if (!localSettings) return;
    setSaving(true);
    try {
      const payload = {
        risk_pct: safeNum(localSettings.risk_pct, 1) || 1,
        daily_loss_limit_pct: safeNum(localSettings.daily_loss_limit_pct, 2) || 2,
        max_open_positions: safeNum(localSettings.max_open_positions, 3) || 3,
        confidence_threshold: safeNum(localSettings.confidence_threshold, 70) || 70,
        trailing_atr_mult: safeNum(localSettings.trailing_atr_mult, 1.5) || 1.5,
        partial_close_pct: safeNum(localSettings.partial_close_pct, 50) || 50,
        correlation_guard: !!localSettings.correlation_guard,
        updated_at: new Date().toISOString(),
      };
      const headers = await getAuthedJsonHeaders();
      await fetch(`${SB_URL}/rest/v1/bot_settings?id=eq.1`, {
        method:'PATCH',
        headers:{ ...headers, Prefer:'return=minimal' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.warn('Save settings failed:', e);
    } finally {
      setSaving(false);
    }
  };

  const togglePref = (key) => {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    LS.set('ui_prefs', next);
  };

  const [showUpgrade, setShowUpgrade] = useState(false);
  const currentPlan = plan || 'free';
  const [marketTest, setMarketTest] = useState({ loading:false, result:null });
  const planMeta = PLAN_META[currentPlan] || PLAN_META.free;

  const testMarketData = async () => {
    setMarketTest({ loading:true, result:null });
    try {
      const candles = await mdFetchOHLCV('XAU/USD', '1h', 30);
      setMarketTest({ loading:false, result:{ ok:true, msg:`Online · ${candles.length} XAU/USD candles loaded` } });
    } catch (e) {
      setMarketTest({ loading:false, result:{ ok:false, msg:e.message || 'Market data check failed' } });
    }
  };

  return (
    <div className="pp-grid" style={{ gap:20 }}>
      {showUpgrade && <UpgradeModal onClose={() => setShowUpgrade(false)} requiredPlan={currentPlan === 'free' ? 'pro' : 'elite'} feature="unlock all PropPilot features"/>}

      {/* ── Plan & Subscription ── */}
      <div className="pp-panel" style={{ padding:24 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:16, marginBottom:20 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:16, marginBottom:6 }}>Plan & Subscription</div>
            <div style={{ color:T.muted, fontSize:13 }}>Your current PropPilot plan and included features.</div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <span style={{ padding:'6px 18px', borderRadius:20, background:`${planMeta.color}22`, border:`1px solid ${planMeta.color}66`, color:planMeta.color, fontWeight:800, fontSize:14 }}>
              {planMeta.label}
            </span>
            <span style={{ color:T.muted, fontSize:13 }}>{planMeta.price}</span>
          </div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))', gap:10, marginBottom:20 }}>
          {planMeta.features.map((f, i) => (
            <div key={i} style={{ display:'flex', alignItems:'center', gap:8, padding:'9px 12px', background:'rgba(255,255,255,0.04)', borderRadius:9, border:`1px solid ${T.border}` }}>
              <span style={{ color:T.green, fontSize:14 }}>✓</span>
              <span style={{ color:T.sub, fontSize:13 }}>{f}</span>
            </div>
          ))}
          {/* Locked features teaser */}
          {currentPlan === 'free' && (
            <>
              {['Unlimited trade journal','AI coaching on every trade','Cloud sync cross-device'].map((f,i) => (
                <div key={i} style={{ display:'flex', alignItems:'center', gap:8, padding:'9px 12px', background:'rgba(255,255,255,0.02)', borderRadius:9, border:`1px solid rgba(255,255,255,0.06)`, opacity:0.55 }}>
                  <span style={{ color:T.muted, fontSize:14 }}>🔒</span>
                  <span style={{ color:T.muted, fontSize:13 }}>{f}</span>
                </div>
              ))}
            </>
          )}
        </div>
        {currentPlan !== 'elite' && (
          <button onClick={() => setShowUpgrade(true)} style={{ padding:'11px 28px', background:`linear-gradient(135deg,#6366F1,#4F46E5)`, border:'none', borderRadius:10, color:'#fff', fontSize:14, fontWeight:800, cursor:'pointer' }}>
            ⚡ Upgrade to {currentPlan === 'free' ? 'Pro' : 'Elite'} →
          </button>
        )}
      </div>

      <div className="pp-grid pp-grid-2x">
        <div className="pp-panel" style={{ padding:20 }}>
          <div style={{ fontWeight:800, fontSize:16, marginBottom:14 }}>Account Sync</div>
          <div className="pp-grid" style={{ gap:12 }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:12 }}>
              {[
                ['Firm', accountView.firm || 'FTMO'],
                ['Size', fmtUsd(accountView.size || 100000)],
                ['Current P&L', fmtUsd(accountView.currentPnL || 0)],
                ['Today P&L', fmtUsd(accountView.todayPnL || 0)],
              ].map(([k, v]) => (
                <div key={k} className="pp-panel-solid" style={{ padding:12 }}>
                  <div style={{ color:T.muted, fontSize:10, fontWeight:800, letterSpacing:'.05em' }}>{k}</div>
                  <div style={{ color:T.text, fontSize:15, fontWeight:800, marginTop:6 }}>{v}</div>
                </div>
              ))}
            </div>
            <button className="pp-btn pp-btn-primary" onClick={() => onUpdateAccount(true)}>Edit linked account</button>
          </div>
        </div>

        <div className="pp-panel" style={{ padding:20 }}>
          <div style={{ fontWeight:800, fontSize:16, marginBottom:14 }}>UI Preferences</div>
          <div className="pp-grid" style={{ gap:10 }}>
            {[
              ['theme', 'Theme toggle', prefs.theme === 'dark' ? 'Dark premium' : 'Light'],
              ['push', 'Push notifications', prefs.push ? 'Enabled' : 'Disabled'],
              ['sound', 'Sound cues', prefs.sound ? 'Enabled' : 'Disabled'],
              ['summaries', 'Auto summaries', prefs.summaries ? 'Enabled' : 'Disabled'],
            ].map(([key, label, value]) => (
              <button key={key} className="pp-btn" onClick={() => key === 'theme' ? (() => {
                const next = { ...prefs, theme: prefs.theme === 'dark' ? 'light' : 'dark' };
                setPrefs(next); LS.set('ui_prefs', next);
              })() : togglePref(key)}>
                <span style={{ display:'flex', justifyContent:'space-between', width:'100%' }}>
                  <span>{label}</span>
                  <span style={{ color:T.sub }}>{value}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="pp-panel" style={{ padding:20 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12, marginBottom:14 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:16 }}>Risk Profile</div>
            <div style={{ color:T.sub, fontSize:12, marginTop:4 }}>Connected to `bot_settings` and paper engine safety rules</div>
          </div>
          <button className={`pp-btn ${saving ? '' : 'pp-btn-primary'}`} onClick={saveSettings} disabled={saving || !localSettings}>{saving ? 'Saving...' : 'Save sync settings'}</button>
        </div>
        {localSettings ? (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3, minmax(0, 1fr))', gap:12 }}>
            {[
              ['risk_pct', 'Risk per trade (%)', 'number', '0.1'],
              ['daily_loss_limit_pct', 'Daily loss limit (%)', 'number', '0.1'],
              ['max_open_positions', 'Max open positions', 'number', '1'],
              ['confidence_threshold', 'Min confidence', 'number', '1'],
              ['trailing_atr_mult', 'Trailing ATR mult', 'number', '0.1'],
              ['partial_close_pct', 'Partial close at TP1 (%)', 'number', '1'],
            ].map(([key, label, type, step]) => (
              <label key={key} className="pp-panel-solid" style={{ padding:12, display:'block' }}>
                <div style={{ color:T.muted, fontSize:10, fontWeight:800, letterSpacing:'.05em', marginBottom:8 }}>{label}</div>
                <input
                  type={type}
                  step={step}
                  value={localSettings[key]}
                  onChange={e => setField(key, e.target.value)}
                  style={{ width:'100%', padding:'10px 12px', background:'rgba(255,255,255,.04)', border:`1px solid ${T.border}`, borderRadius:8, color:T.text, outline:'none' }}
                />
              </label>
            ))}
            <label className="pp-panel-solid" style={{ padding:12, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
              <div>
                <div style={{ color:T.muted, fontSize:10, fontWeight:800, letterSpacing:'.05em', marginBottom:6 }}>Correlation guard</div>
                <div style={{ color:T.sub, fontSize:12 }}>Block clustered correlated exposure</div>
              </div>
              <input type="checkbox" checked={!!localSettings.correlation_guard} onChange={e => setField('correlation_guard', e.target.checked)}/>
            </label>
          </div>
        ) : (
          <div style={{ color:T.muted, fontSize:13 }}>Loading settings...</div>
        )}
      </div>

      {/* ── Market Data Status ──────────────────────────────────────────── */}
      <div className="pp-panel" style={{ padding: 20 }}>
        <div style={{ fontWeight:800, fontSize:16, marginBottom:6 }}>📡 Market Data</div>
        <div style={{ color:T.sub, fontSize:13, marginBottom:16, lineHeight:1.6 }}>
          Signals, Analyze, Dashboard, and Algo use the Supabase <code style={{ color:T.indigo }}>market-data</code> edge function backed by Yahoo Finance. No external API key is required for normal operation.
        </div>
        <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
          <button onClick={testMarketData} disabled={marketTest.loading}
            style={{ padding:'10px 20px', background:`linear-gradient(135deg,${T.indigo},#4F46E5)`, border:'none', borderRadius:8, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer' }}>
            {marketTest.loading ? 'Testing...' : 'Test Market Data'}
          </button>
          {marketTest.result && (
            <span style={{ color:marketTest.result.ok ? T.green : T.red, fontSize:13, fontWeight:700 }}>
              {marketTest.result.msg}
            </span>
          )}
        </div>
      </div>

      {/* ── Telegram Integration ─────────────────────────────────────── */}
      <div className="pp-panel" style={{ padding: 20 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap: 12, marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>🤖 Telegram Integration</div>
            <div style={{ color: T.sub, fontSize: 12, marginTop: 4 }}>
              Receive real-time push notifications for signals, TP/SL hits and account status
            </div>
          </div>
          <a href="https://t.me/BotFather" target="_blank" rel="noreferrer"
            style={{ fontSize: 11, color: T.indigo, textDecoration:'none', fontWeight: 700 }}>
            Get token from @BotFather →
          </a>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap: 12, marginBottom: 14 }}>
          <label className="pp-panel-solid" style={{ padding: 12, display:'block' }}>
            <div style={{ color: T.muted, fontSize: 10, fontWeight: 800, letterSpacing:'.05em', marginBottom: 8 }}>BOT TOKEN</div>
            <input
              type="password"
              value={tgToken}
              onChange={e => setTgToken(e.target.value)}
              placeholder="1234567890:ABCDef..."
              style={{
                width:'100%', padding:'10px 12px', boxSizing:'border-box',
                background:'rgba(255,255,255,.04)', border:`1px solid ${T.border}`,
                borderRadius: 8, color: T.text, outline:'none', fontSize: 12, fontFamily:'monospace',
              }}
            />
          </label>
          <label className="pp-panel-solid" style={{ padding: 12, display:'block' }}>
            <div style={{ color: T.muted, fontSize: 10, fontWeight: 800, letterSpacing:'.05em', marginBottom: 8 }}>CHAT ID</div>
            <input
              type="text"
              value={tgChatId}
              onChange={e => setTgChatId(e.target.value)}
              placeholder="123456789"
              style={{
                width:'100%', padding:'10px 12px', boxSizing:'border-box',
                background:'rgba(255,255,255,.04)', border:`1px solid ${T.border}`,
                borderRadius: 8, color: T.text, outline:'none', fontSize: 12, fontFamily:'monospace',
              }}
            />
            <div style={{ color: T.muted, fontSize: 10, marginTop: 6 }}>
              Start your bot → /start → your chat_id appears
            </div>
          </label>
        </div>

        <div style={{ display:'flex', gap: 10, alignItems:'center', flexWrap:'wrap' }}>
          <button className="pp-btn pp-btn-primary" onClick={() => { saveTgCreds(); }}>
            💾 Save credentials
          </button>
          <button
            className="pp-btn"
            onClick={testTelegram}
            disabled={tgTest.loading || !tgChatId}
            style={{ opacity: tgChatId ? 1 : 0.4 }}>
            {tgTest.loading ? '⏳ Sending…' : '📡 Send test message'}
          </button>

          {tgTest.result && (
            <div style={{
              padding: '7px 13px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: tgTest.result.ok ? 'rgba(16,185,129,0.10)' : 'rgba(239,68,68,0.10)',
              border: `1px solid ${tgTest.result.ok ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}`,
              color: tgTest.result.ok ? T.green : T.red,
            }}>
              {tgTest.result.msg}
            </div>
          )}

          {tgToken && tgChatId && !tgTest.result && (
            <div style={{ fontSize: 11, color: T.green }}>✓ Credentials saved locally</div>
          )}
        </div>

        <div style={{
          marginTop: 16, padding: '12px 16px', borderRadius: 10,
          background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
          fontSize: 12, color: T.sub, lineHeight: 1.8,
        }}>
          <b style={{ color: T.text }}>Setup steps:</b><br/>
          1. Message <code style={{ color: T.indigo }}>@BotFather</code> on Telegram → <code style={{ color: T.indigo }}>/newbot</code> → copy the token above<br/>
          2. Send your bot <code style={{ color: T.indigo }}>/start</code> → your chat_id appears in bot logs or use <code style={{ color: T.indigo }}>@userinfobot</code><br/>
          3. Run <code style={{ color: T.indigo }}>supabase secrets set TELEGRAM_BOT_TOKEN=&lt;token&gt;</code> and <code style={{ color: T.indigo }}>TELEGRAM_CHAT_ID=&lt;id&gt;</code><br/>
          4. Push notifications auto-fire on new signals, TP1/TP2 hit, SL hit, kill-switch
        </div>
      </div>

      {/* ── Automation Status ─────────────────────────────────────── */}
      <div className="pp-panel" style={{ padding:20 }}>
        <div style={{ fontWeight:800, fontSize:16, marginBottom:16 }}>⚙ Automation Status</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, minmax(0, 1fr))', gap:12 }}>
          {[
            { label:'Auto-Analyze', desc:'AI scans markets every session', status:'Cron · Supabase', ok:true,  action:'Run Now', onAction: async () => {
              try {
                const headers = await getAuthedJsonHeaders();
                const r = await fetch(`${SB_URL}/functions/v1/auto-analyze`, { method:'POST', headers, body:'{}' });
                const j = await r.json().catch(() => ({}));
                alert(r.ok ? `Done: ${j.processed || 0} signals processed` : `Error: ${j.error || r.status}`);
              } catch(e) { alert('Error: ' + e.message); }
            }},
            { label:'Paper Positions', desc:'Updates open trade prices every 30m', status:'Cron · Supabase', ok:true, action:null },
            { label:'Outcome Tracking', desc:'Marks TP/SL hits automatically', status:'Cron · Supabase', ok:true, action:null },
          ].map(({ label, desc, status, ok, action, onAction }) => (
            <div key={label} className="pp-panel-solid" style={{ padding:16 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:8 }}>
                <div style={{ fontWeight:700, fontSize:13 }}>{label}</div>
                <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                  <span style={{ width:6, height:6, borderRadius:'50%', background: ok ? T.green : T.red, display:'inline-block', boxShadow: ok ? `0 0 6px ${T.green}` : 'none' }}/>
                  <span style={{ fontSize:10, color: ok ? T.green : T.red, fontWeight:700 }}>{ok ? 'Active' : 'Off'}</span>
                </div>
              </div>
              <div style={{ color:T.muted, fontSize:11, marginBottom:10 }}>{desc}</div>
              <div style={{ color:T.sub, fontSize:10, fontFamily:'monospace', marginBottom: action ? 12 : 0 }}>{status}</div>
              {action && <button className="pp-btn pp-btn-primary" onClick={onAction} style={{ width:'100%', fontSize:11 }}>{action}</button>}
            </div>
          ))}
        </div>
      </div>

      {/* ── Danger zone ────────────────────────────────────────────── */}
      <div className="pp-panel" style={{ padding:20, border:'1px solid rgba(239,68,68,0.2)', background:'rgba(239,68,68,0.04)' }}>
        <div style={{ fontWeight:800, fontSize:14, color:T.red, marginBottom:12 }}>⚠ Danger Zone</div>
        <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
          <button className="pp-btn" style={{ borderColor:'rgba(239,68,68,0.4)', color:T.red }}
            onClick={() => { if (window.confirm('Clear all local trade history? This cannot be undone.')) { LS.set('trades',[]); window.location.reload(); }}}>
            Clear Trade History
          </button>
          <button className="pp-btn" style={{ borderColor:'rgba(239,68,68,0.4)', color:T.red }}
            onClick={() => { if (window.confirm('Reset challenge progress?')) { LS.set('challenge', null); window.location.reload(); }}}>
            Reset Challenge
          </button>
          <button className="pp-btn" style={{ borderColor:'rgba(239,68,68,0.4)', color:T.red }}
            onClick={() => { if (window.confirm('Clear ALL local settings?')) { localStorage.clear(); window.location.reload(); }}}>
            Factory Reset
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Market session detector ──────────────────────────────────────────────
function currentSession() {
  const h = new Date().getUTCHours();
  if (h >= 22 || h < 8)  return { name:'Asia',   color:'#06B6D4', active: h >= 23 || h < 7 };
  if (h >= 7  && h < 9)  return { name:'Pre-London', color:'#94A3B8', active: false };
  if (h >= 9  && h < 12) return { name:'London', color:'#3B82F6', active: true };
  if (h >= 12 && h < 17) return { name:'London+NY', color:'#8B5CF6', active: true };
  if (h >= 17 && h < 21) return { name:'NY',     color:'#10B981', active: true };
  return { name:'Closed', color:'#4B5A72', active: false };
}

function UnifiedAppHeader({ screen, phase, onPhaseChange, accountView, syncState, rtStatus, lastLoadAt, onRefresh, onSetup, onNotif, notifPerm, user, onLogout, appData, gateData, trades }) {

  const phColors = { s1:'#3B82F6', s2:'#8B5CF6', fs:'#10B981', sw:'#F59E0B' };
  const screenLabels = {
    dashboard:'Today', signals:'Signals', analyze:'Analyze',
    algo:'Algo Trading', journal:'Journal', risk:'Risk Calc', analytics:'Analytics',
    challenge:'Challenge', settings:'Settings',
  };

  // ── Context chip — smart info per screen ────────────────────────────────
  const ContextChip = () => {
    // DASHBOARD: today's P&L
    if (screen === 'dashboard') {
      const pnl     = accountView.todayPnL || 0;
      const size    = accountView.size || 100000;
      const pnlPct  = size ? ((pnl / size) * 100).toFixed(2) : 0;
      const color   = pnl > 0 ? T.green : pnl < 0 ? T.red : T.sub;
      return (
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'4px 12px', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:10 }}>
          <span style={{ fontSize:10, color:T.muted, fontWeight:700, letterSpacing:'.05em' }}>TODAY</span>
          <span style={{ color, fontWeight:800, fontFamily:'monospace', fontSize:13 }}>{pnl >= 0 ? '+' : ''}{fmtUsd(pnl)}</span>
          <span style={{ color, fontSize:10, fontWeight:700 }}>({pnl >= 0 ? '+' : ''}{pnlPct}%)</span>
        </div>
      );
    }

    // SIGNALS: market session
    if (screen === 'signals') {
      const sess = currentSession();
      return (
        <div style={{ display:'flex', alignItems:'center', gap:7, padding:'4px 12px', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:10 }}>
          <span style={{ width:7, height:7, borderRadius:'50%', background: sess.color, display:'inline-block', boxShadow: sess.active ? `0 0 8px ${sess.color}` : 'none', flexShrink:0 }}/>
          <span style={{ fontSize:11, fontWeight:800, color: sess.active ? sess.color : T.sub }}>{sess.name} Session</span>
          <span style={{ fontSize:10, color:T.muted }}>{sess.active ? 'Open' : 'Closed'}</span>
        </div>
      );
    }

    // JOURNAL: stats summary
    if (screen === 'journal') {
      const t = trades || [];
      const wins    = t.filter(x => x.win).length;
      const wr      = t.length ? Math.round(wins/t.length*100) : 0;
      const totalPnl= t.reduce((s,x) => s + (x.pnl||0), 0);
      return (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'4px 12px', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:10 }}>
          <span style={{ fontSize:10, color:T.muted, fontWeight:700 }}>{t.length} TRADES</span>
          <span style={{ color: wr >= 50 ? T.green : T.red, fontWeight:800, fontSize:12 }}>WR {wr}%</span>
          <span style={{ color: totalPnl >= 0 ? T.green : T.red, fontWeight:700, fontFamily:'monospace', fontSize:12 }}>{totalPnl >= 0 ? '+' : ''}{fmtUsd(totalPnl)}</span>
        </div>
      );
    }

    // RISK: daily limit remaining
    if (screen === 'risk') {
      const ch = LS.get('challenge', null);
      const chFirm = ch ? PROP_FIRMS[ch.firmId] : null;
      const chType = (chFirm && ch?.typeId) ? chFirm.types[ch.typeId] : null;
      const phIdx  = ch?.curPhaseIdx ?? 0;
      const phaseName = chType ? chType.phases[phIdx] : null;
      const rules  = (phaseName && chType) ? chType.rules[phaseName] : null;
      const size   = ch?.size || accountView.size || 100000;
      const dailyLim = rules?.daily ? size * rules.daily : null;
      const todayPnl = (LS.get('trades', []))
        .filter(t => t.date === new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short' }))
        .reduce((s,t) => s + (t.pnl||0), 0);
      const remaining = dailyLim ? Math.max(0, dailyLim + Math.min(0, todayPnl)) : null;
      return (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'4px 12px', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:10 }}>
          <span style={{ fontSize:10, color:T.muted, fontWeight:700 }}>DAILY LIMIT</span>
          {dailyLim
            ? <><span style={{ color:T.amber, fontWeight:800, fontFamily:'monospace', fontSize:12 }}>{fmtUsd(dailyLim)}</span>
                <span style={{ color:T.muted, fontSize:10 }}>Left:</span>
                <span style={{ color: remaining > 0 ? T.green : T.red, fontWeight:800, fontFamily:'monospace', fontSize:12 }}>{fmtUsd(remaining)}</span></>
            : <span style={{ color:T.muted, fontSize:11 }}>Set up challenge first</span>
          }
        </div>
      );
    }

    // CHALLENGE: gate progress
    if (screen === 'challenge') {
      const g       = gateData || {};
      const tot     = g.totalTrades || 0;
      const pf      = g.profitFactor || 0;
      const dd      = g.maxDD || 0;
      const pfOk    = pf >= 1.2;
      const ddOk    = dd <= 15;
      return (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'4px 14px', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:10 }}>
          <span style={{ fontSize:9, color:T.muted, fontWeight:800, letterSpacing:'.06em' }}>GATE</span>
          {[
            { label:'Trades', val:`${tot}/100`, ok: tot >= 100 },
            { label:'PF', val:pf.toFixed(2), ok: pfOk },
            { label:'MaxDD', val:`${dd.toFixed(1)}%`, ok: ddOk },
          ].map(({ label, val, ok }) => (
            <div key={label} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
              <span style={{ fontSize:9, color:T.muted }}>{label}</span>
              <span style={{ fontSize:11, fontWeight:800, color: ok ? T.green : T.amber, fontFamily:'monospace' }}>{val}</span>
            </div>
          ))}
          {tot >= 100 && pfOk && ddOk && <span style={{ fontSize:11, color:T.green, fontWeight:900 }}>🔓 PASS</span>}
        </div>
      );
    }

    // ANALYTICS: open P&L
    if (screen === 'analytics') {
      const sigs    = (appData?.signals || []).filter(s => s.outcome === 'OPEN');
      const resolved= (appData?.signals || []).filter(s => s.outcome !== 'OPEN');
      const wins    = resolved.filter(s => ['TP1_HIT','TP2_HIT'].includes(s.outcome)).length;
      const wr      = resolved.length ? Math.round(wins/resolved.length*100) : 0;
      return (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'4px 12px', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:10 }}>
          <span style={{ fontSize:10, color:T.muted, fontWeight:700 }}>{resolved.length} RESOLVED</span>
          <span style={{ color: wr >= 50 ? T.green : T.red, fontWeight:800, fontSize:12 }}>WR {wr}%</span>
          <span style={{ fontSize:10, color:T.muted }}>{sigs.length} open</span>
        </div>
      );
    }

    // SETTINGS: bot + telegram status
    if (screen === 'settings') {
      const hasTg = !!(LS.get('tg_token','') && LS.get('tg_chat_id',''));
      const riskPct = appData?.settings?.risk_pct;
      return (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'4px 12px', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:10 }}>
          <span style={{ fontSize:10, color:T.muted, fontWeight:700 }}>RISK</span>
          <span style={{ color:T.indigo, fontWeight:800, fontFamily:'monospace', fontSize:12 }}>{riskPct != null ? `${riskPct}%/trade` : '—'}</span>
          <span style={{ width:1, height:12, background:T.border, display:'inline-block' }}/>
          <span style={{ fontSize:10, color:T.muted }}>TG:</span>
          <span style={{ color: hasTg ? T.green : T.muted, fontWeight:700, fontSize:11 }}>{hasTg ? 'Connected' : 'Off'}</span>
        </div>
      );
    }

    // ANALYZE: instrument hint
    return (
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'4px 12px', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:10 }}>
        <span style={{ fontSize:11, color:T.sub }}>Pick instrument + direction below</span>
      </div>
    );
  };

  return (
    <div className="pp-topbar">
      <div className="pp-topbar-inner">

        {/* Left: Brand + screen label */}
        <div style={{ display:'flex', alignItems:'center', gap:10, flexShrink:0 }}>
          <div className="pp-brand-mark">P</div>
          <div>
            <div style={{ fontWeight:900, fontSize:15, letterSpacing:'-.03em', lineHeight:1.15 }}>
              PropPilot <span style={{ color:T.indigo }}>AI</span>
            </div>
            <div style={{ color:T.muted, fontSize:9, fontWeight:700, letterSpacing:'.08em', textTransform:'uppercase' }}>
              {screenLabels[screen] || 'Dashboard'}
            </div>
          </div>
        </div>

        {/* Center: phase pills + context chip */}
        <div style={{ display:'flex', alignItems:'center', gap:8, flex:1, justifyContent:'center', flexWrap:'wrap', overflow:'hidden' }}>

          {/* Phase pills */}
          <div style={{ display:'flex', alignItems:'center', gap:2, background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.06)', borderRadius:9, padding:'2px 3px', flexShrink:0 }}>
            {Object.entries(PHASES).map(([id, p]) => (
              <button key={id} onClick={() => onPhaseChange?.(id)} title={p.label} style={{
                padding:'3px 8px', border:'none', borderRadius:7, cursor:'pointer', fontWeight:800,
                fontSize:10, letterSpacing:'.04em', transition:'all .15s',
                background: phase === id ? `${phColors[id]}25` : 'transparent',
                color: phase === id ? phColors[id] : T.muted,
                outline: phase === id ? `1px solid ${phColors[id]}50` : 'none',
              }}>{p.tag}</button>
            ))}
          </div>

          {/* Account chip */}
          <div className="pp-status-pill" style={{ gap:5, flexShrink:0 }}>
            <span style={{ color:T.text, fontWeight:700, fontSize:11 }}>{accountView.firm || 'FTMO'}</span>
            <span style={{ color:T.border }}>·</span>
            <span style={{ color:T.indigo, fontWeight:800, fontFamily:'monospace', fontSize:11 }}>{fmtUsd(accountView.size || 100000)}</span>
          </div>

          {/* Smart context chip */}
          <ContextChip/>
        </div>

        {/* Right: actions */}
        <div style={{ display:'flex', alignItems:'center', gap:5, flexShrink:0 }}>
          <SyncPill syncState={syncState} rtStatus={rtStatus} lastLoadAt={lastLoadAt}/>
          {onNotif && (
            <button className="pp-btn" onClick={onNotif}
              title={notifPerm === 'granted' ? 'Notifications on' : 'Enable notifications'}
              style={{ padding:'6px 8px', fontSize:13, color: notifPerm === 'granted' ? T.green : T.muted }}>
              {notifPerm === 'granted' ? '🔔' : '🔕'}
            </button>
          )}
          <button className="pp-btn" onClick={() => onRefresh('updating')} title="Refresh" style={{ padding:'6px 9px' }}>↻</button>
          <button className="pp-btn pp-btn-primary" onClick={onSetup} style={{ fontSize:11, padding:'7px 12px' }}>⚙ Account</button>
          {onLogout && (
            <button className="pp-btn" onClick={onLogout}
              title={user?.email ? `Sign out — ${user.email}` : 'Sign out'}
              style={{ padding:'6px 8px', color:T.muted, fontSize:13 }}>↩</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB ERROR BOUNDARY
// ═══════════════════════════════════════════════════════════════════════════

class TabBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(e) { return { err: e }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding:48, textAlign:'center' }}>
        <div style={{ fontSize:40, marginBottom:16 }}>⚠️</div>
        <div style={{ fontWeight:800, fontSize:18, marginBottom:8 }}>This tab crashed</div>
        <div style={{ color:T.sub, fontSize:13, marginBottom:24, fontFamily:'monospace',
          background:'rgba(255,255,255,0.04)', padding:'10px 16px', borderRadius:10, maxWidth:480, margin:'0 auto 24px' }}>
          {this.state.err?.message}
        </div>
        <button className="pp-btn pp-btn-primary" onClick={() => this.setState({ err: null })}>
          ↺ Retry
        </button>
      </div>
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTH SCREEN
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// LIVE NEWS EVENTS HOOK — fetches ForexFactory calendar, caches 1h
// ═══════════════════════════════════════════════════════════════════════════
// NEWS SYSTEM — hooks + components
// ═══════════════════════════════════════════════════════════════════════════

const SB_URL_CONST  = 'https://nxiednydxyrtxpkmgtof.supabase.co';
const SB_ANON_KEY   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im54aWVkbnlkeHlydHhwa21ndG9mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDU2MDMzNTIsImV4cCI6MjA2MTE3OTM1Mn0.7YWnCo0SLSMU7UBB2LlZvRbQmXD9fM5n_nkbLqHB3NQ';

async function fetchCalendarAPI(params = '') {
  const res = await fetch(`${SB_URL_CONST}/functions/v1/calendar${params}`, {
    headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${SB_ANON_KEY}` },
  });
  if (!res.ok) throw new Error('calendar fetch failed');
  return res.json();
}

// Hook: today's high+medium events (with live countdown refresh every minute)
function useNewsEvents() {
  const [events,  setEvents]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);

  const load = useCallback(async () => {
    try {
      // Try Edge Function first
      const data = await fetchCalendarAPI('?range=today');
      const evts = (data.events || []).filter(e => ['High','Medium'].includes(e.impact));
      setEvents(evts);
      setBlocked(data.trading_blocked || false);
    } catch {
      // Fallback: fetch FF directly from browser
      try {
        const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json?version=9');
        const raw = await r.json();
        if (Array.isArray(raw)) {
          const todayISO = new Date().toISOString().slice(0, 10);
          const todayEvts = raw
            .filter(e => e.date && e.date.startsWith(todayISO))
            .filter(e => ['High','Medium'].includes(e.impact))
            .map(e => ({ ...e, currency: e.country, time_label: e.time, date_iso: todayISO, minutes_until: null, is_imminent: false, is_upcoming: false }));
          setEvents(todayEvts);
        }
      } catch { /* silent */ }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000); // refresh every minute
    return () => clearInterval(timer);
  }, [load]);

  return { events, loading, blocked };
}

// Hook: full week calendar
function useCalendarWeek() {
  const [allEvents, setAllEvents] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchCalendarAPI('?range=week');
      setAllEvents(data.events || []);
      setError(null);
    } catch (e) {
      setError('Failed to load calendar. Check your connection.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 300_000); // refresh every 5 min
    return () => clearInterval(timer);
  }, [load]);

  return { allEvents, loading, error, reload: load };
}

// ── Countdown timer component ────────────────────────────────────────────────
function Countdown({ minutesUntil, isImminent, isPast }) {
  if (isPast) return <span style={{ color: T.muted, fontSize: 11 }}>Released</span>;
  if (minutesUntil === null) return <span style={{ color: T.muted, fontSize: 11 }}>—</span>;
  if (minutesUntil <= 0) return <span style={{ color: T.red, fontSize: 11, fontWeight: 800 }}>NOW</span>;

  const h = Math.floor(minutesUntil / 60);
  const m = minutesUntil % 60;
  const label = h > 0 ? `${h}h ${m}m` : `${m}m`;

  return (
    <span style={{
      fontSize: 11, fontWeight: 700, fontFamily: 'monospace',
      color: isImminent ? T.red : minutesUntil <= 60 ? T.amber : T.muted,
      background: isImminent ? 'rgba(239,68,68,0.1)' : 'transparent',
      padding: isImminent ? '2px 6px' : '0',
      borderRadius: 4,
    }}>
      {isImminent ? `⚡ ${label}` : `in ${label}`}
    </span>
  );
}

// ── Impact badge ─────────────────────────────────────────────────────────────
function ImpactBadge({ impact }) {
  const cfg = {
    High:   { bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.3)',  color: '#F87171', dot: '🔴' },
    Medium: { bg: 'rgba(245,166,35,0.1)',  border: 'rgba(245,166,35,0.3)', color: T.amber,   dot: '🟡' },
    Low:    { bg: 'rgba(100,116,139,0.1)', border: 'rgba(100,116,139,0.2)',color: T.muted,   dot: '⚪' },
  }[impact] || { bg: 'transparent', border: T.border, color: T.muted, dot: '—' };

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 7px', borderRadius: 6, fontSize: 10, fontWeight: 800,
      background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
    }}>
      {cfg.dot} {impact}
    </span>
  );
}

// ── Full Economic Calendar Tab ───────────────────────────────────────────────
function EconomicCalendarTab() {
  const { allEvents, loading, error, reload } = useCalendarWeek();
  const [dayFilter,    setDayFilter]    = useState('today');  // today|tomorrow|week
  const [impactFilter, setImpactFilter] = useState('all');    // all|High|Medium|Low
  const [currFilter,   setCurrFilter]   = useState('all');    // all|USD|EUR|GBP|JPY|...
  const [, forceUpdate] = useState(0);

  // Re-render every minute to update countdowns
  useEffect(() => {
    const t = setInterval(() => forceUpdate(n => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const todayISO    = new Date().toISOString().slice(0, 10);
  const tomorrowISO = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  const filtered = useMemo(() => {
    let evts = allEvents;

    // Day filter
    if (dayFilter === 'today')    evts = evts.filter(e => e.date_iso === todayISO);
    if (dayFilter === 'tomorrow') evts = evts.filter(e => e.date_iso === tomorrowISO);

    // Impact filter
    if (impactFilter !== 'all')   evts = evts.filter(e => e.impact === impactFilter);

    // Currency filter
    if (currFilter !== 'all')     evts = evts.filter(e => e.currency === currFilter);

    return evts;
  }, [allEvents, dayFilter, impactFilter, currFilter, todayISO, tomorrowISO]);

  // Re-compute live fields (minutes_until changes with time)
  const enriched = useMemo(() => {
    const now = Date.now();
    return filtered.map(e => {
      if (!e.datetime_utc) return e;
      const ms = new Date(e.datetime_utc).getTime();
      const minutesUntil = Math.round((ms - now) / 60_000);
      return {
        ...e,
        minutes_until: minutesUntil,
        is_past:       minutesUntil < -30,
        is_imminent:   minutesUntil >= -5 && minutesUntil <= 15,
        is_upcoming:   minutesUntil >= -5 && minutesUntil <= 60,
      };
    });
  }, [filtered]);

  // Group by date → time
  const grouped = useMemo(() => {
    const g = {};
    for (const e of enriched) {
      if (!g[e.date_iso]) g[e.date_iso] = [];
      g[e.date_iso].push(e);
    }
    return g;
  }, [enriched]);

  const currencies = useMemo(() => {
    const s = new Set(allEvents.map(e => e.currency).filter(Boolean));
    return ['all', ...Array.from(s).sort()];
  }, [allEvents]);

  const imminentHigh = enriched.filter(e => e.impact === 'High' && e.is_imminent);
  const upcomingHigh = enriched.filter(e => e.impact === 'High' && e.is_upcoming && !e.is_imminent);

  return (
    <div className="pp-grid" style={{ gap: 20 }}>

      {/* ── ALERT BAR ── */}
      {imminentHigh.length > 0 && (
        <div style={{
          padding: '14px 20px', borderRadius: 12,
          background: 'rgba(239,68,68,0.08)', border: '1.5px solid rgba(239,68,68,0.35)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontSize: 22 }}>🚨</span>
          <div>
            <div style={{ color: T.red, fontWeight: 800, fontSize: 14 }}>
              TRADING BLOCKED — High-impact news imminent
            </div>
            <div style={{ color: T.sub, fontSize: 12, marginTop: 3 }}>
              {imminentHigh.map(e => `${e.currency}: ${e.title} (${Math.max(0, e.minutes_until ?? 0)}min)`).join(' · ')}
            </div>
          </div>
        </div>
      )}

      {upcomingHigh.length > 0 && imminentHigh.length === 0 && (
        <div style={{
          padding: '12px 18px', borderRadius: 12,
          background: 'rgba(245,166,35,0.07)', border: '1px solid rgba(245,166,35,0.28)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: 18 }}>⚠️</span>
          <div style={{ color: T.amber, fontSize: 13 }}>
            High-impact news within 60min: {upcomingHigh.map(e => `${e.currency} in ${e.minutes_until}min`).join(', ')} — reduce size
          </div>
        </div>
      )}

      {/* ── HEADER + FILTERS ── */}
      <div className="pp-panel" style={{ padding: '18px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>📅 Economic Calendar</div>
            <div style={{ color: T.muted, fontSize: 12, marginTop: 3 }}>ForexFactory · auto-refreshes every 5 min</div>
          </div>
          <button onClick={reload} style={{
            padding: '7px 16px', background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)',
            borderRadius: 8, color: '#60A5FA', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}>
            ↻ Refresh
          </button>
        </div>

        {/* Filter row */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* Day filter */}
          <div style={{ display: 'flex', gap: 4, background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: 3 }}>
            {['today','tomorrow','week'].map(d => (
              <button key={d} onClick={() => setDayFilter(d)} style={{
                padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                background: dayFilter === d ? 'rgba(59,130,246,0.3)' : 'transparent',
                color: dayFilter === d ? '#93C5FD' : T.muted,
              }}>
                {d.charAt(0).toUpperCase() + d.slice(1)}
              </button>
            ))}
          </div>

          {/* Impact filter */}
          <div style={{ display: 'flex', gap: 4, background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: 3 }}>
            {['all','High','Medium','Low'].map(imp => (
              <button key={imp} onClick={() => setImpactFilter(imp)} style={{
                padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                background: impactFilter === imp
                  ? imp === 'High' ? 'rgba(239,68,68,0.3)' : imp === 'Medium' ? 'rgba(245,166,35,0.25)' : 'rgba(255,255,255,0.1)'
                  : 'transparent',
                color: impactFilter === imp
                  ? imp === 'High' ? '#F87171' : imp === 'Medium' ? T.amber : T.sub
                  : T.muted,
              }}>
                {imp === 'all' ? 'All' : imp}
              </button>
            ))}
          </div>

          {/* Currency filter */}
          <select value={currFilter} onChange={e => setCurrFilter(e.target.value)} style={{
            padding: '5px 10px', background: 'rgba(255,255,255,0.05)', border: `1px solid ${T.border}`,
            borderRadius: 8, color: T.sub, fontSize: 12, cursor: 'pointer',
          }}>
            {currencies.map(c => <option key={c} value={c}>{c === 'all' ? 'All Currencies' : c}</option>)}
          </select>
        </div>
      </div>

      {/* ── EVENT LIST ── */}
      {loading && (
        <div style={{ textAlign: 'center', padding: 40, color: T.muted, fontSize: 14 }}>
          Loading calendar…
        </div>
      )}

      {error && (
        <div style={{ padding: 20, background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, color: T.red, fontSize: 13 }}>
          {error}
        </div>
      )}

      {!loading && !error && enriched.length === 0 && (
        <div className="pp-panel" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📭</div>
          <div style={{ color: T.sub, fontSize: 14 }}>No events match your filters for this period.</div>
        </div>
      )}

      {!loading && Object.entries(grouped).map(([dateIso, events]) => {
        const dateLabel = dateIso === todayISO ? 'Today'
          : dateIso === tomorrowISO ? 'Tomorrow'
          : new Date(dateIso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

        const dayHighCount = events.filter(e => e.impact === 'High').length;

        return (
          <div key={dateIso} className="pp-panel" style={{ padding: 0, overflow: 'hidden' }}>
            {/* Day header */}
            <div style={{
              padding: '12px 20px',
              background: 'rgba(255,255,255,0.03)',
              borderBottom: `1px solid ${T.border}`,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <div style={{ fontWeight: 800, fontSize: 14 }}>{dateLabel}</div>
              {dayHighCount > 0 && (
                <span style={{ fontSize: 11, color: T.red, fontWeight: 700, background: 'rgba(239,68,68,0.1)', padding: '2px 8px', borderRadius: 6 }}>
                  🔴 {dayHighCount} high-impact
                </span>
              )}
            </div>

            {/* Events */}
            {events.map((e, i) => (
              <div key={e.id || i} style={{
                padding: '13px 20px',
                borderBottom: i < events.length - 1 ? `1px solid ${T.border}` : 'none',
                background: e.is_imminent ? 'rgba(239,68,68,0.04)' : e.is_upcoming && e.impact === 'High' ? 'rgba(245,166,35,0.03)' : 'transparent',
                display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
              }}>
                {/* Time */}
                <div style={{ minWidth: 52, textAlign: 'right' }}>
                  <div style={{ fontSize: 12, color: T.muted, fontFamily: 'monospace' }}>{e.time_label || e.time || '—'}</div>
                  <Countdown minutesUntil={e.minutes_until} isImminent={e.is_imminent} isPast={e.is_past} />
                </div>

                {/* Impact */}
                <div style={{ minWidth: 72 }}>
                  <ImpactBadge impact={e.impact} />
                </div>

                {/* Currency */}
                <div style={{
                  minWidth: 36, fontWeight: 800, fontSize: 13,
                  color: e.currency === 'USD' ? '#60A5FA' : e.currency === 'EUR' ? '#34D399' : e.currency === 'GBP' ? T.amber : T.sub,
                }}>
                  {e.currency}
                </div>

                {/* Title */}
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: e.is_imminent ? T.red : T.text }}>
                    {e.title}
                  </div>
                  {e.trading_advice && (
                    <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>{e.trading_advice}</div>
                  )}
                  {/* Affected symbols */}
                  {e.affected_symbols?.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                      {e.affected_symbols.map(s => (
                        <span key={s} style={{
                          fontSize: 10, padding: '1px 6px', borderRadius: 4, fontWeight: 700,
                          background: 'rgba(148,163,184,0.1)', color: T.muted, border: `1px solid ${T.border}`,
                        }}>{s}</span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Actual / Forecast / Previous */}
                <div style={{ display: 'flex', gap: 16, fontSize: 11, color: T.muted, fontFamily: 'monospace', flexShrink: 0 }}>
                  {e.actual && (
                    <div>
                      <div style={{ fontSize: 9, color: T.muted, marginBottom: 1 }}>ACTUAL</div>
                      <div style={{ color: T.green, fontWeight: 800, fontSize: 12 }}>{e.actual}</div>
                    </div>
                  )}
                  {e.forecast && (
                    <div>
                      <div style={{ fontSize: 9, color: T.muted, marginBottom: 1 }}>FORECAST</div>
                      <div style={{ color: T.text }}>{e.forecast}</div>
                    </div>
                  )}
                  {e.previous && (
                    <div>
                      <div style={{ fontSize: 9, color: T.muted, marginBottom: 1 }}>PREV</div>
                      <div>{e.previous}</div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── NewsStrip component (inline strip of today's events) ─────────────────
function NewsStrip({ compact = false }) {
  const { events, loading } = useNewsEvents();
  if (loading) return null;
  if (!events.length) return (
    <div style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'4px 10px', background:'rgba(52,211,153,0.08)', border:'1px solid rgba(52,211,153,0.2)', borderRadius:8, fontSize:12, color:'#34D399' }}>
      📅 No high-impact news today
    </div>
  );
  if (compact) return (
    <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
      {events.map((e,i) => (
        <div key={i} style={{
          display:'inline-flex', alignItems:'center', gap:5, padding:'3px 9px',
          background: e.impact === 'High' ? 'rgba(239,68,68,0.1)' : 'rgba(245,166,35,0.08)',
          border: `1px solid ${e.impact === 'High' ? 'rgba(239,68,68,0.28)' : 'rgba(245,166,35,0.22)'}`,
          borderRadius:7, fontSize:11, color: e.impact === 'High' ? '#F87171' : T.amber,
        }}>
          <span style={{ fontWeight:800 }}>{e.impact === 'High' ? '🔴' : '🟡'}</span>
          {e.country} {e.title?.slice(0,28)}{e.title?.length > 28 ? '…' : ''} {e.time || ''}
        </div>
      ))}
    </div>
  );
  return (
    <div style={{ padding:'14px 18px', background:'rgba(239,68,68,0.06)', border:'1px solid rgba(239,68,68,0.2)', borderRadius:12, marginBottom:16 }}>
      <div style={{ fontSize:11, color:T.red, fontWeight:800, letterSpacing:'.08em', marginBottom:10 }}>⚠ HIGH-IMPACT NEWS TODAY</div>
      <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
        {events.map((e,i) => (
          <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:8 }}>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <span style={{ fontSize:12, color: e.impact === 'High' ? T.red : T.amber, fontWeight:800 }}>
                {e.impact === 'High' ? '🔴' : '🟡'}
              </span>
              <span style={{ color:T.sub, fontSize:13, fontWeight:600 }}>{e.country}</span>
              <span style={{ color:T.text, fontSize:13 }}>{e.title}</span>
            </div>
            <span style={{ color:T.muted, fontSize:12, fontFamily:'monospace' }}>{e.time || '—'}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop:10, fontSize:11, color:T.muted }}>
        Reduce position size or avoid trading 30min before/after each event.
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// UPGRADE MODAL — shown when free user hits a plan gate
// ═══════════════════════════════════════════════════════════════════════════
function UpgradeModal({ onClose, requiredPlan = 'pro', feature = '' }) {
  const req = PLAN_META[requiredPlan];
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:9000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }} onClick={onClose}>
      <div style={{ background:'#0d1117', border:'1px solid rgba(255,255,255,0.12)', borderRadius:20, padding:36, maxWidth:520, width:'100%', boxShadow:'0 32px 96px rgba(0,0,0,0.8)' }} onClick={e => e.stopPropagation()}>
        <div style={{ textAlign:'center', marginBottom:28 }}>
          <div style={{ fontSize:44, marginBottom:10 }}>🚀</div>
          <div style={{ fontWeight:900, fontSize:22, marginBottom:8, color:req.color }}>{req.label} Required</div>
          {feature && <div style={{ color:T.sub, fontSize:14 }}><strong style={{ color:T.text }}>{feature}</strong> is a {req.label} feature.</div>}
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:28 }}>
          {['pro','elite'].map(p => {
            const meta = PLAN_META[p];
            const isReq = p === requiredPlan;
            return (
              <div key={p} style={{ padding:'18px 16px', borderRadius:14, border:`1.5px solid ${isReq ? meta.color : 'rgba(255,255,255,0.1)'}`, background: isReq ? `${meta.color}10` : 'rgba(255,255,255,0.03)' }}>
                <div style={{ fontWeight:900, fontSize:16, color:meta.color, marginBottom:4 }}>{meta.label}</div>
                <div style={{ fontWeight:800, fontSize:20, color:T.text, marginBottom:10 }}>{meta.price}</div>
                {meta.features.map(f => (
                  <div key={f} style={{ color:T.sub, fontSize:12, marginBottom:4, display:'flex', gap:6 }}>
                    <span style={{ color: isReq ? meta.color : T.muted }}>✓</span> {f}
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        <div style={{ display:'flex', gap:10 }}>
          <button onClick={() => window.open('mailto:upgrade@proppilot.ai?subject=Upgrade to ' + req.label, '_blank')}
            style={{ flex:1, padding:'13px 0', background:`linear-gradient(135deg,${req.color},${req.color}cc)`, border:'none', borderRadius:11, color:'#fff', fontSize:14, fontWeight:800, cursor:'pointer' }}>
            Upgrade to {req.label} →
          </button>
          <button onClick={onClose} style={{ padding:'13px 20px', background:'transparent', border:`1px solid ${T.border}`, borderRadius:11, color:T.muted, fontSize:13, cursor:'pointer' }}>
            Maybe later
          </button>
        </div>
        <div style={{ textAlign:'center', marginTop:12, color:T.muted, fontSize:11 }}>
          Contact support: upgrade@proppilot.ai
        </div>
      </div>
    </div>
  );
}

// ── PlanGate: wraps gated features ────────────────────────────────────────
function PlanGate({ minPlan, children, feature, plan }) {
  const [showUpgrade, setShowUpgrade] = useState(false);
  const userPlan = plan || LS.get('user_plan', 'free');
  const hasAccess = PLAN_ORDER[userPlan] >= PLAN_ORDER[minPlan];

  if (hasAccess) return children;

  return (
    <>
      {showUpgrade && <UpgradeModal requiredPlan={minPlan} feature={feature} onClose={() => setShowUpgrade(false)}/>}
      <div style={{ padding:'18px 20px', background:`${PLAN_META[minPlan].color}08`, border:`1px solid ${PLAN_META[minPlan].color}30`, borderRadius:12, textAlign:'center' }}>
        <div style={{ fontSize:24, marginBottom:8 }}>🔒</div>
        <div style={{ fontWeight:700, fontSize:14, color:PLAN_META[minPlan].color, marginBottom:6 }}>{PLAN_META[minPlan].label} Feature</div>
        {feature && <div style={{ color:T.sub, fontSize:13, marginBottom:14 }}>{feature}</div>}
        <button onClick={() => setShowUpgrade(true)} style={{ padding:'8px 20px', background:`linear-gradient(135deg,${PLAN_META[minPlan].color},${PLAN_META[minPlan].color}cc)`, border:'none', borderRadius:9, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer' }}>
          Upgrade to {PLAN_META[minPlan].label}
        </button>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ONBOARDING WIZARD — shown to new users on first login
// ═══════════════════════════════════════════════════════════════════════════
function OnboardingWizard({ user, onComplete, onNavigate }) {
  const [step, setStep] = useState(0); // 0=welcome, 1=challenge, 2=done
  const [setupDone, setSetupDone] = useState(false);

  const finish = async () => {
    LS.set('onboarding_done', true);
    await saveUserProfile(user?.id, { onboarding_done: true });
    onComplete();
  };

  const handleChallengeSetup = async (cfg) => {
    LS.set('challenge', cfg);
    await syncChallengeToSB(user?.id, cfg);
    setSetupDone(true);
    setStep(2);
  };

  const stepDots = (
    <div style={{ display:'flex', gap:8, justifyContent:'center', marginBottom:28 }}>
      {[0,1,2].map(i => (
        <div key={i} style={{ width:8, height:8, borderRadius:'50%', background: i <= step ? '#6366F1' : 'rgba(255,255,255,0.15)', transition:'background 0.3s' }}/>
      ))}
    </div>
  );

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(5,7,15,0.96)', zIndex:9100, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'rgba(13,17,23,0.98)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:24, padding:'40px 36px', maxWidth:560, width:'100%', boxShadow:'0 40px 120px rgba(0,0,0,0.9)' }}>
        {stepDots}

        {/* ── STEP 0: WELCOME ── */}
        {step === 0 && (
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:56, marginBottom:16 }}>⚡</div>
            <div style={{ fontWeight:900, fontSize:26, marginBottom:10 }}>Welcome to PropPilot AI</div>
            <div style={{ color:T.sub, fontSize:15, lineHeight:1.7, marginBottom:8 }}>
              Your prop trading command center. Signals, risk management, challenge tracking — all in one place.
            </div>
            <div style={{ color:T.muted, fontSize:13, marginBottom:32 }}>
              Logged in as <strong style={{ color:T.sub }}>{user?.email}</strong>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:32 }}>
              {[
                { icon:'⚡', label:'AI Signals', sub:'Live SMC analysis' },
                { icon:'◎', label:'Challenge Tracking', sub:'FTMO, MyFundedFX +' },
                { icon:'▦', label:'Smart Journal', sub:'AI coaching per trade' },
              ].map(({ icon, label, sub }) => (
                <div key={label} style={{ padding:'16px 12px', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:12, textAlign:'center' }}>
                  <div style={{ fontSize:24, marginBottom:6 }}>{icon}</div>
                  <div style={{ fontWeight:700, fontSize:13 }}>{label}</div>
                  <div style={{ color:T.muted, fontSize:11, marginTop:3 }}>{sub}</div>
                </div>
              ))}
            </div>
            <button onClick={() => setStep(1)} style={{ width:'100%', padding:'14px 0', background:'linear-gradient(135deg,#6366F1,#4F46E5)', border:'none', borderRadius:12, color:'#fff', fontSize:15, fontWeight:800, cursor:'pointer' }}>
              Let's set up your challenge →
            </button>
            <button onClick={finish} style={{ marginTop:10, background:'transparent', border:'none', color:T.muted, fontSize:13, cursor:'pointer', textDecoration:'underline' }}>
              Skip — I'll do this later
            </button>
          </div>
        )}

        {/* ── STEP 1: CHALLENGE SETUP ── */}
        {step === 1 && (
          <div>
            <div style={{ textAlign:'center', marginBottom:24 }}>
              <div style={{ fontSize:40, marginBottom:10 }}>◎</div>
              <div style={{ fontWeight:900, fontSize:22, marginBottom:8 }}>Set Up Your Challenge</div>
              <div style={{ color:T.sub, fontSize:14 }}>Which prop firm are you trading with?</div>
            </div>
            <ChallengeSetupWizard onSave={handleChallengeSetup}/>
            <button onClick={() => { setStep(2); }} style={{ marginTop:14, width:'100%', padding:'10px 0', background:'transparent', border:`1px solid ${T.border}`, borderRadius:10, color:T.muted, fontSize:13, cursor:'pointer' }}>
              Skip for now
            </button>
          </div>
        )}

        {/* ── STEP 2: DONE ── */}
        {step === 2 && (
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:56, marginBottom:16 }}>✅</div>
            <div style={{ fontWeight:900, fontSize:24, marginBottom:10 }}>You're Ready!</div>
            <div style={{ color:T.sub, fontSize:14, lineHeight:1.8, marginBottom:32 }}>
              {setupDone ? 'Challenge configured and synced. ' : ''}
              Your command center is live. Start by running the Signal Engine to find your first trade setup.
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              <button onClick={() => { onNavigate('signals'); finish(); }} style={{ padding:'14px 0', background:'linear-gradient(135deg,#6366F1,#4F46E5)', border:'none', borderRadius:12, color:'#fff', fontSize:15, fontWeight:800, cursor:'pointer' }}>
                ⚡ Run My First Signal →
              </button>
              <button onClick={finish} style={{ padding:'12px 0', background:'transparent', border:`1px solid ${T.border}`, borderRadius:12, color:T.sub, fontSize:13, cursor:'pointer' }}>
                Go to Today Dashboard
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AuthScreen({ onAuth, onDemo }) {
  const [mode,     setMode]     = useState('login'); // 'login' | 'register'
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');

  const handle = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) { setError('Please fill in all fields.'); return; }
    if (!sbClient) { setError('Auth service unavailable.'); return; }
    setLoading(true); setError('');
    try {
      let res;
      if (mode === 'login') {
        res = await sbClient.auth.signInWithPassword({ email: email.trim(), password });
      } else {
        res = await sbClient.auth.signUp({ email: email.trim(), password });
      }
      if (res.error) throw res.error;
      if (mode === 'register' && !res.data?.session) {
        setError(''); setMode('confirm');
      } else {
        onAuth(res.data.session?.user || res.data.user);
      }
    } catch(err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (mode === 'confirm') {
    return (
      <div className="pp-auth-root">
        <div className="pp-auth-card" style={{ textAlign:'center' }}>
          <div style={{ fontSize:48, marginBottom:20 }}>✉️</div>
          <div style={{ fontSize:'1.3rem', fontWeight:800, marginBottom:10 }}>Check your email</div>
          <div style={{ color:'#94a3b8', fontSize:'0.9rem', marginBottom:24 }}>
            We sent a confirmation link to <strong style={{ color:'#f1f5f9' }}>{email}</strong>.
            Click it to activate your account, then come back and sign in.
          </div>
          <button className="pp-auth-btn" onClick={() => setMode('login')}>Back to Sign In</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pp-auth-root">
      <div className="pp-auth-card">
        <div className="pp-auth-logo">
          <div className="pp-auth-logo-mark">P</div>
          <div className="pp-auth-logo-text">Prop<span>Pilot</span> <span style={{ fontWeight:400, fontSize:'0.9rem', color:'#6366f1' }}>AI</span></div>
        </div>

        <div className="pp-auth-title">{mode === 'login' ? 'Welcome back' : 'Create your account'}</div>
        <div className="pp-auth-sub">
          {mode === 'login'
            ? 'Sign in to access your prop trading dashboard.'
            : 'Start trading smarter in under 60 seconds.'}
        </div>

        {error && <div className="pp-auth-error">{error}</div>}

        <form onSubmit={handle}>
          <div className="pp-auth-field">
            <label className="pp-auth-label">Email address</label>
            <input
              className="pp-auth-input"
              type="email" placeholder="trader@example.com"
              value={email} onChange={e => setEmail(e.target.value)}
              autoComplete="email" autoFocus
            />
          </div>
          <div className="pp-auth-field">
            <label className="pp-auth-label">Password</label>
            <input
              className="pp-auth-input"
              type="password" placeholder="••••••••"
              value={password} onChange={e => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </div>
          <button className="pp-auth-btn" type="submit" disabled={loading}>
            {loading ? 'Please wait…' : mode === 'login' ? 'Sign In →' : 'Create Account →'}
          </button>
        </form>

        <div className="pp-auth-divider"><span>or</span></div>

        <button className="pp-auth-btn" type="button" onClick={onDemo}
          style={{ background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.12)', boxShadow:'none', color:'#e2e8f0', marginTop:0 }}>
          Continue in Demo Mode →
        </button>

        <div className="pp-auth-switch">
          {mode === 'login'
            ? <>Don't have an account? <a onClick={() => { setMode('register'); setError(''); }}>Sign up free</a></>
            : <>Already have an account? <a onClick={() => { setMode('login'); setError(''); }}>Sign in</a></>
          }
        </div>
      </div>
    </div>
  );
}

function AuthGate({ children }) {
  const [authState, setAuthState] = useState('loading'); // 'loading' | 'authed' | 'unauthed'
  const [user,      setUser]      = useState(null);

  useEffect(() => {
    const demoUser = LS.get('demo_user', null);
    if (demoUser) {
      setUser(demoUser);
      setAuthState('authed');
      return;
    }
    if (!sbClient) { setAuthState('unauthed'); return; }
    // Check current session
    sbClient.auth.getSession().then(({ data }) => {
      if (data?.session) {
        setUser(data.session.user);
        setAuthState('authed');
      } else {
        setAuthState('unauthed');
      }
    });
    // Listen for auth changes
    const { data: listener } = sbClient.auth.onAuthStateChange((event, session) => {
      if (session) {
        LS.set('demo_user', null);
        setUser(session.user);
        setAuthState('authed');
      } else {
        setUser(null);
        setAuthState('unauthed');
      }
    });
    return () => listener?.subscription?.unsubscribe?.();
  }, []);

  const handleLogout = async () => {
    LS.set('demo_user', null);
    if (sbClient) await sbClient.auth.signOut();
    setUser(null);
    setAuthState('unauthed');
  };

  const handleDemo = () => {
    const demoUser = {
      id: null,
      email: 'demo@proppilot.local',
      app_metadata: {},
      user_metadata: { demo: true },
    };
    LS.set('demo_user', demoUser);
    LS.set('onboarding_done', true);
    setUser(demoUser);
    setAuthState('authed');
  };

  if (authState === 'loading') {
    return (
      <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:16 }}>
        <div style={{ width:40, height:40, border:'3px solid rgba(99,102,241,0.3)', borderTopColor:'#6366f1', borderRadius:'50%', animation:'pp-spin 0.7s linear infinite' }}/>
        <div style={{ color:'#64748b', fontSize:'0.85rem' }}>Loading PropPilot…</div>
      </div>
    );
  }

  if (authState === 'unauthed') {
    return <AuthScreen onAuth={(nextUser) => { setUser(nextUser || null); setAuthState('authed'); }} onDemo={handleDemo}/>;
  }

  return children({ user, onLogout: handleLogout });
}

// ═══════════════════════════════════════════════════════════════════════════
// ALGO TRADING TAB — Live paper account + positions from Supabase
// ═══════════════════════════════════════════════════════════════════════════

function AlgoTradingTab({ user }) {
  const [acct,      setAcct]      = useState(null);
  const [positions, setPositions] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [prices,    setPrices]    = useState({});
  const [killBusy,  setKillBusy]  = useState(false);
  const [cycleBusy, setCycleBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [cycleResult, setCycleResult] = useState(null);
  const [posView,   setPosView]   = useState('open'); // 'open' | 'history'
  const { show: showToast } = useToast();

  // ── Load data from Supabase ───────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const [acctRes, posRes] = await Promise.all([
        fetch(`${SB_URL}/rest/v1/paper_account?id=eq.1&select=*`, {
          headers: { ...SB_HDR, Accept: 'application/vnd.pgrst.object+json' }
        }),
        fetch(`${SB_URL}/rest/v1/paper_positions?order=opened_at.desc&limit=100&select=*`, {
          headers: SB_HDR
        }),
      ]);
      if (acctRes.ok) { const d = await acctRes.json(); if (d) setAcct(d); }
      if (posRes.ok)  { const d = await posRes.json();  if (Array.isArray(d)) setPositions(d); }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000); // refresh every 30s
    return () => clearInterval(t);
  }, [load]);

  // ── Fetch live prices for open positions ─────────────────────────────────
  useEffect(() => {
    const openSyms = [...new Set(positions.filter(p => ['OPEN','TP1_HIT'].includes(p.status)).map(p => p.symbol))];
    if (openSyms.length === 0) { setPrices({}); return; }
    mdFetchPrices(openSyms).then(pm => setPrices(pm)).catch(() => {});
  }, [positions]);

  // ── Realtime subscription ─────────────────────────────────────────────────
  useEffect(() => {
    if (!sbClient) return;
    const ch = sbClient.channel('algo-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'paper_account' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'paper_positions' }, () => load())
      .subscribe();
    return () => sbClient.removeChannel(ch);
  }, [load]);

  // ── Kill switch toggle ────────────────────────────────────────────────────
  const toggleKillSwitch = async () => {
    if (!acct) return;
    setKillBusy(true);
    const newVal = !acct.kill_switch_active;
    try {
      const headers = await getAuthedJsonHeaders();
      await fetch(`${SB_URL}/rest/v1/paper_account?id=eq.1`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          kill_switch_active: newVal,
          kill_switch_reason: newVal ? 'Manual stop from PropPilot UI' : null,
          kill_switch_at: newVal ? new Date().toISOString() : null,
        }),
      });
      setAcct(prev => ({ ...prev, kill_switch_active: newVal }));
      showToast(newVal ? '🛑 Kill Switch активирован' : '✅ Kill Switch снят', newVal ? 'warn' : 'success');
    } catch { showToast('Ошибка при обновлении Kill Switch', 'error'); }
    setKillBusy(false);
  };

  const runPaperCycle = async ({ demoTest = false } = {}) => {
    setCycleBusy(true);
    setCycleResult(null);
    try {
      const headers = await getAuthedJsonHeaders();
      const res = await fetch(`${SB_URL}/functions/v1/auto-analyze`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          autoTrade: true,
          demoTest,
          symbols: ['XAU/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'NAS100', 'BTC/USD'],
        }),
      });
      const json = await res.json().catch(() => ({}));
      setCycleResult(json);
      if (!res.ok) {
        showToast(json.error || 'Paper cycle failed', 'error');
        return;
      }
      if (json.tradesOpened > 0) {
        showToast(demoTest ? '🧪 Demo paper trade opened' : '✅ Paper trade opened from model signal', 'success', 5000);
      } else {
        showToast('No executable signal right now. Analysis saved.', 'info', 5000);
      }
      await load();
    } catch (err) {
      showToast(err.message || 'Sign in required for paper trading', 'error', 6000);
    } finally {
      setCycleBusy(false);
    }
  };

  const syncPositions = async () => {
    setUpdateBusy(true);
    try {
      const headers = await getAuthedJsonHeaders();
      const res = await fetch(`${SB_URL}/functions/v1/update-paper-positions`, {
        method: 'POST',
        headers,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(json.error || 'Position sync failed', 'error', 5000);
        return;
      }
      showToast(`Positions synced: ${json.updated || 0} updated, ${json.closed || 0} closed`, 'success', 4500);
      await load();
    } catch (err) {
      showToast(err.message || 'Sign in required to sync positions', 'error', 6000);
    } finally {
      setUpdateBusy(false);
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const openPos    = positions.filter(p => ['OPEN','TP1_HIT'].includes(p.status));
  const closedPos  = positions.filter(p => !['OPEN','TP1_HIT'].includes(p.status));
  const totalOpenPnl = openPos.reduce((s, p) => {
    const live = prices[p.symbol];
    if (!live) return s + safeNum(p.pnl_usd, 0);
    const dir  = p.direction === 'LONG' ? 1 : -1;
    const contract = getInstrumentSpec(p.symbol).contractSize;
    const lotSize = safeNum(p.lot_size, 0.01);
    return s + (live - safeNum(p.entry_price, live)) * dir * lotSize * contract;
  }, 0);

  const rCurve = closedPos
    .sort((a,b) => new Date(a.closed_at||a.created_at) - new Date(b.closed_at||b.created_at))
    .reduce((acc, p) => {
      const prev = acc[acc.length - 1]?.v || 0;
      acc.push({
        t: new Date(p.closed_at||p.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' }),
        v: prev + safeNum(p.pnl_r, 0),
      });
      return acc;
    }, []);

  const ks = acct?.kill_switch_active;

  // ── Outcome badge ─────────────────────────────────────────────────────────
  const outcomeBadge = (status) => {
    const map = {
      'TP1_HIT': { lbl:'TP1 ✓', c:T.green },
      'TP2_HIT': { lbl:'TP2 ✓✓', c:'#34D399' },
      'SL_HIT':  { lbl:'SL ✗', c:T.red },
      'EXPIRED': { lbl:'Expired', c:T.muted },
      'KILL_SWITCH': { lbl:'Kill Switch', c:T.amber },
      'MANUAL_CLOSE': { lbl:'Manual', c:T.sub },
      'OPEN':    { lbl:'OPEN', c:T.blue },
    };
    const m = map[status] || { lbl: status, c: T.muted };
    return <Badge label={m.lbl} color={m.c}/>;
  };

  if (loading) return (
    <div className="pp-grid pp-grid-4x">
      {[...Array(8)].map((_,i) => <div key={i} className="pp-skeleton" style={{ height: i<4?120:220 }}/>)}
    </div>
  );

  return (
    <div className="pp-grid" style={{ gap:20 }}>

      {/* ── Kill Switch Banner ── */}
      {ks && (
        <div style={{ padding:'16px 24px', borderRadius:14, background:'rgba(239,68,68,0.08)', border:'2px solid rgba(239,68,68,0.35)', display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12 }}>
          <div>
            <div style={{ fontWeight:900, fontSize:16, color:T.red, marginBottom:4 }}>🛑 KILL SWITCH АКТИВЕН — Автоторговля остановлена</div>
            <div style={{ color:T.sub, fontSize:13 }}>{acct?.kill_switch_reason || 'Причина не указана'}</div>
          </div>
          <button onClick={toggleKillSwitch} disabled={killBusy}
            style={{ padding:'10px 22px', background:`linear-gradient(135deg,${T.green},#059669)`, border:'none', borderRadius:9, color:'#fff', fontWeight:800, fontSize:13, cursor:'pointer' }}>
            {killBusy ? '⏳' : '✅ Возобновить торговлю'}
          </button>
        </div>
      )}

      {/* ── Account KPIs ── */}
      {!acct ? (
        <div className="pp-panel" style={{ padding:32, textAlign:'center', color:T.muted }}>
          <div style={{ fontSize:36, marginBottom:12 }}>📊</div>
          <div style={{ fontWeight:800, fontSize:16, color:T.sub, marginBottom:8 }}>Нет данных paper account</div>
          <div style={{ fontSize:13, maxWidth:360, margin:'0 auto', lineHeight:1.7 }}>
            Запусти SQL миграцию в Supabase Dashboard, чтобы создать таблицу paper_account.
          </div>
        </div>
      ) : (
        <div className="pp-grid pp-grid-4x">
          <ShellKpi
            label="Balance"
            value={`$${Number(acct.balance||100000).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}`}
            sub={`Equity $${Number(acct.equity||acct.balance||100000).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}`}
            color={T.blue}
          />
          <ShellKpi
            label="Open P&L"
            value={`${totalOpenPnl>=0?'+':''}$${totalOpenPnl.toFixed(2)}`}
            sub={`${openPos.length} open position${openPos.length===1?'':'s'}`}
            color={totalOpenPnl>=0?T.green:T.red}
          />
          <ShellKpi
            label="Win Rate"
            value={acct.total_trades ? `${((acct.win_trades||0)/acct.total_trades*100).toFixed(1)}%` : '—'}
            sub={`${acct.win_trades||0}W · ${acct.loss_trades||0}L · ${acct.total_trades||0} total`}
            color={(acct.win_trades||0)/(acct.total_trades||1)>=0.5 ? T.green : T.red}
          />
          <ShellKpi
            label="Max Drawdown"
            value={`${Number(acct.max_drawdown||0).toFixed(2)}%`}
            sub={`Daily P&L: ${acct.daily_pnl_usd>=0?'+':''}$${Number(acct.daily_pnl_usd||0).toFixed(2)}`}
            color={Number(acct.max_drawdown||0) > 5 ? T.red : T.green}
          />
        </div>
      )}

      {/* ── Second row KPIs ── */}
      {acct && (
        <div className="pp-grid pp-grid-4x">
          <ShellKpi
            label="Profit Factor"
            value={acct.profit_factor ? Number(acct.profit_factor).toFixed(2) : '—'}
            sub="Gross Win / Gross Loss"
            color={Number(acct.profit_factor||0)>=1.5 ? T.green : Number(acct.profit_factor||0)>=1 ? T.amber : T.red}
          />
          <ShellKpi
            label="Avg P&L per Trade"
            value={acct.avg_pnl_r ? `${Number(acct.avg_pnl_r)>=0?'+':''}${Number(acct.avg_pnl_r).toFixed(2)}R` : '—'}
            sub="Expected value per trade"
            color={Number(acct.avg_pnl_r||0)>=0 ? T.green : T.red}
          />
          <ShellKpi
            label="Daily Trades"
            value={String(acct.daily_trades||0)}
            sub={`Session count: ${acct.session_count||0}`}
            color={T.sub}
          />
          <div className="pp-panel" style={{ padding:16, display:'flex', flexDirection:'column', justifyContent:'space-between' }}>
            <div style={{ color:T.muted, fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Kill Switch</div>
            <button onClick={toggleKillSwitch} disabled={killBusy}
              style={{ width:'100%', padding:'10px 0', borderRadius:9, border:'none', cursor:killBusy?'wait':'pointer', fontWeight:800, fontSize:13,
                background: ks ? `linear-gradient(135deg,${T.green},#059669)` : `linear-gradient(135deg,${T.red},#991B1B)`,
                color:'#fff', transition:'all .2s' }}>
              {killBusy ? '⏳ …' : ks ? '▶ Resume Trading' : '🛑 Stop All Trading'}
            </button>
            <div style={{ color:T.muted, fontSize:10, marginTop:6, textAlign:'center' }}>{ks ? 'Trading paused — click to resume' : 'All systems running'}</div>
          </div>
        </div>
      )}

      <div className="pp-panel" style={{ padding:20 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:14 }}>
          <div>
            <div style={{ fontWeight:900, fontSize:16, marginBottom:4 }}>Paper Algo Test</div>
            <div style={{ color:T.sub, fontSize:12, lineHeight:1.6 }}>
              Реальные market data, демо-деньги, без брокера и без live orders.
            </div>
          </div>
          <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
            <button
              onClick={() => runPaperCycle({ demoTest:false })}
              disabled={cycleBusy || ks}
              style={{ padding:'10px 16px', borderRadius:9, border:`1px solid ${T.border}`, background:'rgba(255,255,255,0.06)', color:T.text, fontWeight:800, cursor:cycleBusy||ks?'not-allowed':'pointer' }}>
              {cycleBusy ? 'Running…' : 'Run Model Cycle'}
            </button>
            <button
              onClick={() => runPaperCycle({ demoTest:true })}
              disabled={cycleBusy || ks}
              style={{ padding:'10px 16px', borderRadius:9, border:'none', background:`linear-gradient(135deg,${T.indigo},${T.blue})`, color:'#fff', fontWeight:900, cursor:cycleBusy||ks?'not-allowed':'pointer' }}>
              {cycleBusy ? 'Running…' : 'Force Demo Test'}
            </button>
            <button
              onClick={syncPositions}
              disabled={updateBusy}
              style={{ padding:'10px 16px', borderRadius:9, border:`1px solid rgba(16,185,129,0.35)`, background:'rgba(16,185,129,0.08)', color:T.green, fontWeight:900, cursor:updateBusy?'wait':'pointer' }}>
              {updateBusy ? 'Syncing…' : 'Sync Positions'}
            </button>
          </div>
        </div>
        {cycleResult && (
          <div style={{ marginTop:14, padding:12, borderRadius:10, background:'rgba(255,255,255,0.035)', border:`1px solid ${T.border}`, color:T.sub, fontSize:12, display:'grid', gap:6 }}>
            <div>
              Analyzed <b style={{ color:T.text }}>{cycleResult.analyzed ?? 0}</b> symbols · actionable <b style={{ color:T.text }}>{cycleResult.actionable ?? 0}</b> · opened <b style={{ color:cycleResult.tradesOpened ? T.green : T.amber }}>{cycleResult.tradesOpened ?? 0}</b>
            </div>
            {Array.isArray(cycleResult.tradeResults) && cycleResult.tradeResults.length > 0 && (
              <div>
                {cycleResult.tradeResults.map((r, i) => (
                  <div key={i} style={{ color:r.success ? T.green : T.red }}>
                    {r.success ? 'Opened' : 'Rejected'} {r.symbol || ''}{r.direction ? ` ${r.direction}` : ''}{r.error ? ` · ${r.error}` : ''}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── R-Curve ── */}
      {rCurve.length > 1 && (
        <div className="pp-panel" style={{ padding:20 }}>
          <div style={{ fontWeight:800, fontSize:16, marginBottom:4 }}>Live R Equity Curve</div>
          <div style={{ color:T.sub, fontSize:12, marginBottom:14 }}>Накопленный P&L в R-единицах · {closedPos.length} закрытых позиций</div>
          <MiniLineChart points={rCurve} color={rCurve[rCurve.length-1]?.v >= 0 ? T.green : T.red} label="Closed positions will build the curve"/>
        </div>
      )}

      {/* ── Positions ── */}
      <div className="pp-panel" style={{ padding:20 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, flexWrap:'wrap', gap:10 }}>
          <div style={{ fontWeight:800, fontSize:16 }}>Позиции</div>
          <div style={{ display:'flex', gap:6, padding:'3px', background:'rgba(255,255,255,0.04)', borderRadius:10, border:'1px solid rgba(255,255,255,0.06)' }}>
            {[['open', `Открытые (${openPos.length})`], ['history', `История (${closedPos.length})`]].map(([id, lbl]) => (
              <button key={id} onClick={() => setPosView(id)}
                style={{ padding:'6px 16px', borderRadius:8, border:'none', cursor:'pointer', fontWeight:700, fontSize:12,
                  background: posView===id ? 'rgba(255,255,255,0.1)' : 'transparent',
                  color: posView===id ? T.text : T.muted }}>
                {lbl}
              </button>
            ))}
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={syncPositions} disabled={updateBusy} style={{ padding:'6px 14px', background:'rgba(16,185,129,0.08)', border:'1px solid rgba(16,185,129,0.25)', borderRadius:8, color:T.green, fontSize:12, fontWeight:800, cursor:updateBusy?'wait':'pointer' }}>{updateBusy ? 'Syncing…' : '↻ Sync'}</button>
            <button onClick={load} style={{ padding:'6px 14px', background:'transparent', border:`1px solid ${T.border}`, borderRadius:8, color:T.muted, fontSize:12, cursor:'pointer' }}>⟳ Refresh</button>
          </div>
        </div>

        {posView === 'open' && (
          openPos.length === 0 ? (
            <div style={{ textAlign:'center', padding:'40px 0', color:T.muted }}>
              <div style={{ fontSize:32, marginBottom:8 }}>📭</div>
              <div>Нет открытых позиций</div>
              <div style={{ fontSize:12, marginTop:6, color:T.muted }}>Run Model Cycle открывает paper position только по executable сигналу</div>
            </div>
          ) : (
            <div style={{ display:'grid', gap:10 }}>
              {openPos.map(pos => {
                const live = prices[pos.symbol];
                const dir  = pos.direction === 'LONG' ? 1 : -1;
                const contract = getInstrumentSpec(pos.symbol).contractSize;
                const lotSize = safeNum(pos.lot_size, 0.01);
                const unrPnl = live ? (live - safeNum(pos.entry_price, live)) * dir * lotSize * contract : safeNum(pos.pnl_usd, 0);
                return (
                  <div key={pos.id} className="pp-panel" style={{ padding:'14px 18px', border:`1px solid ${unrPnl>=0?'rgba(16,185,129,0.2)':'rgba(239,68,68,0.2)'}` }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:10 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                        <div style={{ width:10, height:10, borderRadius:5, background: pos.direction==='LONG'?T.green:T.red, boxShadow:`0 0 8px ${pos.direction==='LONG'?T.green:T.red}` }}/>
                        <div>
                          <div style={{ fontWeight:900, fontSize:16 }}>{pos.symbol}</div>
                          <div style={{ display:'flex', gap:6, alignItems:'center', marginTop:2 }}>
                            <span style={{ color: pos.direction==='LONG'?T.green:T.red, fontSize:11, fontWeight:800 }}>{pos.direction}</span>
                            {pos.status === 'TP1_HIT' && <Badge label="TP1 HIT" color={T.green}/>}
                          </div>
                        </div>
                        <div style={{ display:'flex', gap:16, marginLeft:8 }}>
                          {[
                            ['Entry', Number(pos.entry_price||0).toFixed(pos.symbol?.includes('JPY')?3:pos.symbol==='XAU/USD'?2:4)],
                            ['SL',    Number(pos.sl_price||0).toFixed(pos.symbol?.includes('JPY')?3:pos.symbol==='XAU/USD'?2:4), T.red],
                            ['TP1',   Number(pos.tp1_price||0).toFixed(pos.symbol?.includes('JPY')?3:pos.symbol==='XAU/USD'?2:4), T.green],
                            ['TP2',   Number(pos.tp2_price||0).toFixed(pos.symbol?.includes('JPY')?3:pos.symbol==='XAU/USD'?2:4), '#34D399'],
                          ].map(([k, v, vc]) => (
                            <div key={k} style={{ textAlign:'center' }}>
                              <div style={{ color:T.muted, fontSize:9, fontWeight:700 }}>{k}</div>
                              <div style={{ color:vc||T.text, fontWeight:800, fontSize:12, fontFamily:'monospace' }}>{v}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div style={{ textAlign:'right' }}>
                        <div style={{ color: unrPnl>=0?T.green:T.red, fontWeight:900, fontSize:20 }}>
                          {unrPnl>=0?'+':''}${unrPnl.toFixed(2)}
                        </div>
                        {live && <div style={{ color:T.muted, fontSize:11 }}>Live: {live.toFixed(pos.symbol==='XAU/USD'?2:4)}</div>}
                        <div style={{ color:T.muted, fontSize:10 }}>{timeAgo(pos.opened_at)}</div>
                      </div>
                    </div>
                    <TpSlBar
                      entry={safeNum(pos.entry_price)}
                      sl={safeNum(pos.sl_price)}
                      tp1={safeNum(pos.tp1_price)}
                      tp2={safeNum(pos.tp2_price)}
                      currentPrice={live}
                      direction={pos.direction}
                    />
                  </div>
                );
              })}
            </div>
          )
        )}

        {posView === 'history' && (
          closedPos.length === 0 ? (
            <div style={{ textAlign:'center', padding:'40px 0', color:T.muted }}>
              <div style={{ fontSize:32, marginBottom:8 }}>📋</div>
              <div>Нет закрытых позиций</div>
            </div>
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead>
                  <tr style={{ borderBottom:`1px solid ${T.border}` }}>
                    {['Символ','Направление','Исход','P&L $','P&L R','Confidence','Закрыто'].map(h => (
                      <th key={h} style={{ padding:'8px 12px', textAlign:'left', color:T.muted, fontWeight:700, fontSize:11 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {closedPos.slice(0, 40).map(pos => {
                    const pnlUsd = safeNum(pos.pnl_usd, null) ?? safeNum(pos.partial_pnl_usd, 0);
                    const pnlR   = safeNum(pos.pnl_r,   null) ?? safeNum(pos.partial_pnl_r,   0);
                    return (
                      <tr key={pos.id} style={{ borderBottom:`1px solid rgba(148,163,184,.07)` }}>
                        <td style={{ padding:'10px 12px', fontWeight:800 }}>{pos.symbol}</td>
                        <td style={{ padding:'10px 12px', color:pos.direction==='LONG'?T.green:T.red, fontWeight:700 }}>{pos.direction==='LONG'?'🟢 LONG':'🔴 SHORT'}</td>
                        <td style={{ padding:'10px 12px' }}>{outcomeBadge(pos.status)}</td>
                        <td style={{ padding:'10px 12px', color:pnlUsd>=0?T.green:T.red, fontWeight:800 }}>{pnlUsd>=0?'+':''}${Number(pnlUsd).toFixed(2)}</td>
                        <td style={{ padding:'10px 12px', color:pnlR>=0?T.green:T.red, fontWeight:700 }}>{fmtR(pnlR)}</td>
                        <td style={{ padding:'10px 12px', color:T.sub }}>{safeNum(pos.confidence,0)}%</td>
                        <td style={{ padding:'10px 12px', color:T.muted }}>{timeAgo(pos.closed_at||pos.updated_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {/* ── How it works ── */}
      <div className="pp-panel" style={{ padding:20 }}>
        <div style={{ fontWeight:800, fontSize:15, marginBottom:14 }}>⚙️ Как работает Algo система</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:12 }}>
          {[
            { icon:'🕐', step:'auto-analyze', desc:'Анализирует 6 символов на реальных данных и сохраняет сигналы в БД', color:T.blue },
            { icon:'⚡', step:'execute-paper-trade', desc:'Run Model Cycle передаёт executable сигнал в risk engine и открывает paper position', color:T.teal },
            { icon:'📊', step:'update-paper-positions', desc:'Каждые 30 мин проверяет TP/SL открытых позиций и закрывает их', color:T.green },
            { icon:'🛡️', step:'Kill Switch', desc:'Автоматически останавливает торговлю при превышении daily loss или max drawdown', color:T.red },
          ].map(s => (
            <div key={s.step} style={{ padding:'14px 16px', background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:12 }}>
              <div style={{ fontSize:24, marginBottom:8 }}>{s.icon}</div>
              <div style={{ fontWeight:800, fontSize:13, color:s.color, marginBottom:6 }}>{s.step}</div>
              <div style={{ color:T.sub, fontSize:12, lineHeight:1.65 }}>{s.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// APP SHELL
// ═══════════════════════════════════════════════════════════════════════════

const TABS = [
  { id:'dashboard', label:'Today',     icon:'◈' },
  { id:'signals',   label:'Signals',   icon:'⚡' },
  { id:'news',      label:'Calendar',  icon:'📅' },
  { id:'analyze',   label:'Analyze',   icon:'◬' },
  { id:'algo',      label:'Algo',      icon:'📊' },
  { id:'journal',   label:'Journal',   icon:'▦' },
  { id:'challenge', label:'Challenge', icon:'◎' },
  { id:'settings',  label:'Settings',  icon:'◉' },
];

function PropPilotAI({ pushMgr, user, onLogout }) {
  const hashScreen = useCallback(() => {
    const raw = window.location.hash.replace('#', '');
    return TABS.some(t => t.id === raw) ? raw : null;
  }, []);
  const [screen, setScreen] = useState(() => hashScreen() || LS.get('screen', 'dashboard'));
  const [phase, setPhase] = useState(() => LS.get('phase', 's1'));
  const [showSetup, setShowSetup] = useState(false);
  const [trades, setTrades] = useState(() => LS.get('trades', []));
  const [account, setAccount] = useState(() => LS.get('account', {
    firm:'FTMO', size:100000, currentPnL:0, todayPnL:0, tradingDays:7,
  }));
  const appData = useUnifiedAppData();
  const { show: showToast } = useToast();
  const [notifPerm, setNotifPerm] = useState(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );

  // ── Plan tier ────────────────────────────────────────────────────────────
  const [userPlan, setUserPlan] = useState(() => LS.get('user_plan', 'free'));

  // ── Onboarding ───────────────────────────────────────────────────────────
  const [showOnboarding, setShowOnboarding] = useState(false);

  // On mount: load profile (plan + onboarding), restore challenge from Supabase
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      // Load profile
      const profile = await loadUserProfile(user.id);
      const plan = profile?.plan || 'free';
      setUserPlan(plan);
      LS.set('user_plan', plan);

      // Show onboarding if not done
      const localDone = LS.get('onboarding_done', false);
      if (!localDone && !profile?.onboarding_done) {
        setShowOnboarding(true);
      }

      // Restore challenge from Supabase if localStorage is empty
      const localChallenge = LS.get('challenge', null);
      if (!localChallenge) {
        const remoteChallenge = await loadChallengeFromSB(user.id);
        if (remoteChallenge) {
          LS.set('challenge', remoteChallenge);
          showToast('✅ Challenge data restored from cloud', 'success', 4000);
        }
      }
    })();
  }, [user?.id]);

  // Subscribe Realtime for push notifications
  useEffect(() => {
    if (!sbClient || !pushMgr) return;
    pushMgr.subscribeOutcomes(sbClient, (s, isWin) => {
      showToast(
        `${isWin ? '✅' : '❌'} ${s.symbol} — ${s.outcome?.replace('_',' ')} ${s.pnl_r != null ? (s.pnl_r > 0 ? '+' : '') + s.pnl_r.toFixed(2) + 'R' : ''}`,
        isWin ? 'success' : 'error', 7000
      );
    });
  }, [pushMgr, showToast]);

  useEffect(() => { LS.set('screen', screen); }, [screen]);
  useEffect(() => { LS.set('phase', phase); }, [phase]);
  useEffect(() => { LS.set('account', account); }, [account]);
  useEffect(() => { LS.set('trades', trades); }, [trades]);
  useEffect(() => {
    const challenge = LS.get('challenge', null);
    if (!challenge) return;
    const synced = deriveChallengeProgressFromTrades(challenge, trades);
    if (!synced) return;
    const changed = synced.curPnl !== challenge.curPnl ||
      synced.tradeDays !== challenge.tradeDays ||
      synced.todayPnl !== LS.get('ch_todaypnl_' + challenge.firmId, 0);
    if (!changed) return;
    const next = { ...synced };
    delete next.todayPnl;
    LS.set('challenge', next);
    LS.set('ch_todaypnl_' + challenge.firmId, synced.todayPnl);
    window.dispatchEvent(new Event('challenge:updated'));
    if (user?.id) syncChallengeToSB(user.id, next);
  }, [trades, user?.id]);
  useEffect(() => {
    if (window.location.hash.replace('#', '') !== screen) window.location.hash = screen;
  }, [screen]);
  useEffect(() => {
    const onHash = () => {
      const next = hashScreen();
      if (next) setScreen(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [hashScreen]);

  const handleSetAccount = (acc) => setAccount(acc);
  const accountView = useMemo(() => {
    const ch = LS.get('challenge', null);
    if (ch && ch.firmId && ch.size) {
      const firm = PROP_FIRMS[ch.firmId];
      return {
        firm: firm?.name || ch.firmId,
        size: ch.size,
        currentPnL: ch.curPnl || 0,
        todayPnL: LS.get('ch_todaypnl_' + ch.firmId, 0),
        tradingDays: ch.tradeDays || 0,
      };
    }
    return account;
  }, [account, screen, trades]);

  // Gate metrics — computed for Challenge tab's internal use
  const gateData = useMemo(() => {
    const sigs = appData.signals || [];
    const resolved = sigs.filter(s => s.outcome !== 'OPEN');
    const wins   = resolved.filter(s => ['TP1_HIT','TP2_HIT'].includes(s.outcome));
    const losses = resolved.filter(s => s.outcome === 'SL_HIT');
    const grossW = wins.reduce((s, x)   => s + Math.abs(safeNum(x.pnl_r,1)||1), 0);
    const grossL = losses.reduce((s, x) => s + Math.abs(safeNum(x.pnl_r,1)||1), 0);
    const pf     = grossL > 0 ? grossW / grossL : (grossW > 0 ? 9.99 : 0);
    const maxDD  = Math.abs(Math.min(0, safeNum(appData.account?.max_drawdown, 0) || 0));
    return { totalTrades: resolved.length, profitFactor: pf, maxDD };
  }, [appData.signals, appData.account]);

  return (
    <div className="pp-app-shell">
      {showOnboarding && (
        <OnboardingWizard
          user={user}
          onComplete={() => setShowOnboarding(false)}
          onNavigate={setScreen}
        />
      )}
      {showSetup && <SetupModal account={account} setAccount={handleSetAccount} onClose={() => setShowSetup(false)}/>}
      <UnifiedAppHeader
        screen={screen}
        phase={phase}
        onPhaseChange={setPhase}
        accountView={accountView}
        syncState={appData.syncState}
        rtStatus={appData.rtStatus}
        lastLoadAt={appData.lastLoadAt}
        onRefresh={appData.refresh}
        onSetup={() => setShowSetup(true)}
        notifPerm={notifPerm}
        user={user}
        onLogout={onLogout}
        appData={appData}
        gateData={gateData}
        trades={trades}
        onNotif={async () => {
          const p = await pushMgr?.requestPermission();
          setNotifPerm(p || 'unsupported');
          if (p === 'granted') showToast('Notifications enabled!', 'success');
        }}
      />

      <div className="pp-content">
        {appData.loading ? (
          <div className="pp-grid pp-grid-4x">
            {Array.from({ length: 8 }, (_, i) => <div key={i} className="pp-skeleton" style={{ height: i < 4 ? 120 : 260 }}/>)}
          </div>
        ) : (
          <>
            <TabBoundary key={screen}>
              {screen === 'dashboard' && <TodayScreen data={appData} phase={phase} accountView={accountView} trades={trades} onNavigate={setScreen}/>}
              {screen === 'signals'   && <SignalsWorkspace onNavigate={setScreen}/>}
              {screen === 'news'      && <EconomicCalendarTab/>}
              {screen === 'analyze'   && <CheckTrade account={accountView} phase={phase} onNavigate={setScreen}/>}
              {screen === 'algo'      && <AlgoTradingTab user={user}/>}
              {screen === 'journal'   && <Journal trades={trades} setTrades={t => { setTrades(t); LS.set('trades', t); }} plan={userPlan}/>}
              {screen === 'risk'      && <RiskCalc account={accountView}/>}
              {screen === 'analytics' && <OutcomeAnalyticsPanel data={appData}/>}
              {screen === 'challenge' && <ChallengeMode account={accountView} phase={phase} userId={user?.id}/>}
              {screen === 'settings'  && <SettingsWorkbench data={appData} accountView={accountView} onUpdateAccount={() => setShowSetup(true)} plan={userPlan}/>}
            </TabBoundary>
          </>
        )}
      </div>

      <nav className="pp-bottom-nav" aria-label="Primary">
        {TABS.map(tab => {
          const isActive = screen === tab.id;
          return (
            <button key={tab.id} className={`pp-nav-item${isActive ? ' active' : ''}`} onClick={() => setScreen(tab.id)} title={tab.label}>
              <span className="pp-nav-icon">{tab.icon}</span>
              <span className="pp-nav-label" style={{ opacity: isActive ? 1 : 0.7 }}>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

// ── Service Worker + Push Notifications ──────────────────────────────────
const PushMgr = {
  swReg: null,

  async init() {
    if (!('serviceWorker' in navigator)) return;
    try {
      this.swReg = await navigator.serviceWorker.register('/sw.js');
      console.log('[PWA] Service Worker registered');
    } catch(e) { console.warn('[PWA] SW registration failed:', e); }
  },

  async requestPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    const result = await Notification.requestPermission();
    return result;
  },

  notify(title, body, tag = 'proppilot', url = '/index.html') {
    if (Notification.permission !== 'granted') return;
    const n = new Notification(title, {
      body,
      tag,
      icon: '/manifest.json',
      requireInteraction: false,
      silent: false,
    });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 8000);
  },

  // Subscribe to Supabase Realtime for outcome changes
  subscribeOutcomes(sbClient, onOutcome) {
    if (!sbClient) return;
    sbClient
      .channel('outcome-notifs')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'signal_analyses',
        filter: 'outcome=neq.OPEN',
      }, payload => {
        const s = payload.new;
        const isWin = ['TP1_HIT','TP2_HIT'].includes(s.outcome);
        const emoji = s.outcome === 'TP2_HIT' ? '🎯' : s.outcome === 'TP1_HIT' ? '✅' : '❌';
        const title = `${emoji} ${s.symbol} — ${s.outcome?.replace('_',' ')}`;
        const body  = `${s.signal_state} · ${s.pnl_r != null ? (s.pnl_r > 0 ? '+' : '') + s.pnl_r.toFixed(2) + 'R' : ''}`;
        this.notify(title, body, `outcome-${s.id}`, '/index.html#analytics');
        if (onOutcome) onOutcome(s, isWin);
      })
      .subscribe();
  },
};

PushMgr.init();

// ── Error Boundary ────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[PropPilot ErrorBoundary]', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight:'100vh', display:'flex', alignItems:'center',
          justifyContent:'center', background:'#05070f', color:'#F1F5F9',
          flexDirection:'column', gap:20, padding:32, textAlign:'center'
        }}>
          <div style={{ fontSize:56 }}>⚠️</div>
          <div style={{ fontSize:22, fontWeight:900, letterSpacing:'-0.5px' }}>Something went wrong</div>
          <div style={{
            color:'#94A3B8', fontSize:13, maxWidth:480,
            fontFamily:'monospace', background:'rgba(255,255,255,0.05)',
            padding:'12px 16px', borderRadius:10, wordBreak:'break-all'
          }}>
            {this.state.error?.message || 'Unknown error'}
          </div>
          <div style={{ display:'flex', gap:12 }}>
            <button
              onClick={() => this.setState({ hasError:false, error:null })}
              style={{
                padding:'10px 24px', background:'rgba(59,130,246,0.2)',
                border:'1px solid rgba(59,130,246,0.4)', borderRadius:10,
                color:'#fff', cursor:'pointer', fontSize:14, fontWeight:600
              }}
            >
              ↺ Retry
            </button>
            <button
              onClick={() => { this.setState({ hasError:false, error:null }); window.location.reload(); }}
              style={{
                padding:'10px 24px', background:'rgba(255,255,255,0.07)',
                border:'1px solid rgba(255,255,255,0.12)', borderRadius:10,
                color:'#94A3B8', cursor:'pointer', fontSize:14
              }}
            >
              Hard Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <ToastProvider>
      <AuthGate>
        {({ user, onLogout }) => (
          <PropPilotAI pushMgr={PushMgr} user={user} onLogout={onLogout}/>
        )}
      </AuthGate>
    </ToastProvider>
  </ErrorBoundary>
);
