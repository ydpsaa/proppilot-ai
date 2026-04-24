// PropPilot AI — Telegram Bot Edge Function
// Handles two modes:
//   1. Webhook from Telegram (incoming /start, /status, /signals, /positions)
//   2. Outbound push — called by pg_cron or auto-analyze to notify on new signals/outcomes
//
// Env vars required (set in Supabase Dashboard → Project Settings → Edge Functions):
//   TELEGRAM_BOT_TOKEN   — from @BotFather
//   TELEGRAM_CHAT_ID     — your personal chat_id (run /start once to get it logged)
//   SUPABASE_URL         — injected automatically
//   SUPABASE_SERVICE_ROLE_KEY — injected automatically

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BOT_TOKEN  = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const CHAT_ID    = Deno.env.get('TELEGRAM_CHAT_ID')   || '';
const SB_URL     = Deno.env.get('SUPABASE_URL')        || '';
const SB_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Supabase client ────────────────────────────────────────────────────────
const sb = createClient(SB_URL, SB_KEY);

// ── Telegram helpers ───────────────────────────────────────────────────────
async function sendMessage(chatId: string | number, text: string, parseMode = 'HTML') {
  if (!BOT_TOKEN) return;
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  });
}

// ── Format helpers ─────────────────────────────────────────────────────────
const fmtPrice = (v: number | null) =>
  v == null ? '—' : v >= 100 ? v.toFixed(2) : v.toFixed(5);

const fmtR = (v: number | null) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;

const fmtUsd = (v: number | null) =>
  v == null ? '—' : `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(0)}`;

const outcomeEmoji = (outcome: string) => ({
  TP2_HIT:       '🎯',
  TP1_HIT:       '✅',
  SL_HIT:        '❌',
  MANUAL_CLOSE:  '🔒',
  EXPIRED:       '⏰',
  KILL_SWITCH:   '🚨',
  OPEN:          '⚡',
}[outcome] ?? '❓');

const dirEmoji = (dir: string) => dir === 'LONG' ? '🟢 LONG' : '🔴 SHORT';

// ── Signal notification ────────────────────────────────────────────────────
async function notifyNewSignal(signal: Record<string, unknown>, chatId?: string) {
  const id     = chatId || CHAT_ID;
  const sym    = signal.symbol as string;
  const state  = (signal.signal_state as string)?.replace(/_/g, ' ') ?? 'SIGNAL';
  const dir    = signal.direction as string;
  const conf   = signal.confidence as number;
  const entry  = signal.price as number;
  const tp1    = signal.tp1 as number;
  const tp2    = signal.tp2 as number;
  const sl     = signal.sl as number;
  const tf     = signal.timeframe as string ?? '15m';
  const sess   = (signal.session_name as string)?.replace(/_/g, ' ').toUpperCase() ?? '';

  const rrStr = sl && tp1
    ? `R:R 1:${(Math.abs(tp1 - entry) / Math.abs(entry - sl)).toFixed(1)}`
    : '';

  const msg = [
    `⚡ <b>NEW SIGNAL — ${sym}</b>`,
    ``,
    `${dirEmoji(dir)} · <b>${state}</b> · ${tf} · ${sess}`,
    `Confidence: <b>${conf ?? 0}%</b>`,
    ``,
    `Entry:  <code>${fmtPrice(entry)}</code>`,
    tp1 ? `TP1:    <code>${fmtPrice(tp1)}</code>` : null,
    tp2 ? `TP2:    <code>${fmtPrice(tp2)}</code>` : null,
    sl  ? `SL:     <code>${fmtPrice(sl)}</code>` : null,
    rrStr ? `${rrStr}` : null,
  ].filter(Boolean).join('\n');

  await sendMessage(id, msg);
}

// ── Outcome notification ───────────────────────────────────────────────────
async function notifyOutcome(signal: Record<string, unknown>, chatId?: string) {
  const id      = chatId || CHAT_ID;
  const sym     = signal.symbol as string;
  const outcome = signal.outcome as string;
  const pnlR    = signal.pnl_r as number;
  const pnlUsd  = signal.pnl_usd as number;
  const dir     = signal.direction as string;
  const emoji   = outcomeEmoji(outcome);
  const label   = outcome?.replace(/_/g, ' ') ?? 'CLOSED';

  const msg = [
    `${emoji} <b>${sym} — ${label}</b>`,
    ``,
    `${dirEmoji(dir)}`,
    pnlR   != null ? `P&L: <b>${fmtR(pnlR)}</b>  (${fmtUsd(pnlUsd)})` : null,
    ``,
    `<a href="https://proppilot-ai.vercel.app/analytics.html">View Analytics →</a>`,
  ].filter(Boolean).join('\n');

  await sendMessage(id, msg);
}

// ── /status command ────────────────────────────────────────────────────────
async function handleStatus(chatId: string | number) {
  const [accRes, posRes] = await Promise.all([
    sb.from('paper_account').select('*').eq('id', 1).single(),
    sb.from('paper_positions').select('*').eq('status', 'OPEN'),
  ]);

  const acc = accRes.data;
  const positions = posRes.data ?? [];

  if (!acc) { await sendMessage(chatId, '⚠️ Account data unavailable'); return; }

  const killIcon = acc.kill_switch_active ? '🚨 KILL-SWITCH' : '✅ LIVE';
  const pauseIcon = acc.is_paused ? '⏸ PAUSED' : '';

  const msg = [
    `📊 <b>PropPilot Status</b>`,
    ``,
    `Balance:  <code>$${Number(acc.balance || 0).toLocaleString()}</code>`,
    `Equity:   <code>$${Number(acc.equity || 0).toLocaleString()}</code>`,
    `Daily P&L: <code>${fmtUsd(acc.daily_pnl_usd)}</code>`,
    `Max DD:   <code>${(acc.max_drawdown ?? 0).toFixed(2)}%</code>`,
    ``,
    `Status: ${killIcon} ${pauseIcon}`,
    `Open positions: <b>${positions.length}</b>`,
    ``,
    `<a href="https://proppilot-ai.vercel.app">Open Dashboard →</a>`,
  ].filter(Boolean).join('\n');

  await sendMessage(chatId, msg);
}

// ── /signals command ───────────────────────────────────────────────────────
async function handleSignals(chatId: string | number) {
  const { data } = await sb
    .from('signal_analyses')
    .select('*')
    .eq('outcome', 'OPEN')
    .order('created_at', { ascending: false })
    .limit(5);

  if (!data?.length) {
    await sendMessage(chatId, '📭 No open signals right now.\n\nSignals are generated at London Open, NY Pre-Market, and NY Open.');
    return;
  }

  const lines = [`⚡ <b>Open Signals (${data.length})</b>\n`];
  for (const s of data) {
    lines.push(
      `<b>${s.symbol}</b> · ${dirEmoji(s.direction)} · Conf: ${s.confidence ?? 0}%`,
      `  Entry: <code>${fmtPrice(s.price)}</code>  SL: <code>${fmtPrice(s.sl)}</code>  TP1: <code>${fmtPrice(s.tp1)}</code>`,
      ``
    );
  }
  await sendMessage(chatId, lines.join('\n'));
}

// ── /positions command ─────────────────────────────────────────────────────
async function handlePositions(chatId: string | number) {
  const { data } = await sb
    .from('paper_positions')
    .select('*')
    .eq('status', 'OPEN')
    .order('opened_at', { ascending: false });

  if (!data?.length) {
    await sendMessage(chatId, '📭 No open paper positions.');
    return;
  }

  const lines = [`📋 <b>Paper Positions (${data.length})</b>\n`];
  for (const p of data) {
    const pnl = p.pnl_usd ?? p.partial_pnl_usd ?? 0;
    const pnlR = p.pnl_r ?? p.partial_pnl_r ?? 0;
    lines.push(
      `<b>${p.symbol}</b> · ${dirEmoji(p.direction)}`,
      `  Entry: <code>${fmtPrice(p.entry_price)}</code>  SL: <code>${fmtPrice(p.sl)}</code>`,
      `  P&L: <b>${fmtR(pnlR)}</b> (${fmtUsd(pnl)})`,
      ``
    );
  }
  await sendMessage(chatId, lines.join('\n'));
}

// ── /help command ──────────────────────────────────────────────────────────
async function handleHelp(chatId: string | number) {
  await sendMessage(chatId, [
    `🤖 <b>PropPilot AI Bot</b>`,
    ``,
    `/start   — Register & get your chat ID`,
    `/status  — Account balance, equity, kill-switch`,
    `/signals — Open signals (last 5)`,
    `/positions — Open paper positions`,
    `/help    — This message`,
    ``,
    `Push notifications are sent automatically on:`,
    `• New signal generated`,
    `• TP1/TP2 hit`,
    `• SL hit`,
    `• Kill-switch triggered`,
  ].join('\n'));
}

// ── Main handler ───────────────────────────────────────────────────────────
serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // ── Mode 1: Outbound push (called internally) ──────────────────────────
    // POST { mode: 'signal', signal: {...} }
    // POST { mode: 'outcome', signal: {...} }
    // POST { mode: 'status' }
    if (body.mode === 'signal' && body.signal) {
      await notifyNewSignal(body.signal, body.chat_id);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (body.mode === 'outcome' && body.signal) {
      await notifyOutcome(body.signal, body.chat_id);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (body.mode === 'status') {
      await handleStatus(body.chat_id || CHAT_ID);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // ── Mode 2: Telegram webhook ───────────────────────────────────────────
    if (body.message) {
      const msg     = body.message;
      const chatId  = msg.chat?.id;
      const text    = (msg.text as string || '').trim().toLowerCase();
      const userId  = msg.from?.id;

      if (!chatId) throw new Error('No chat_id in message');

      // Log the incoming chat_id so user can configure TELEGRAM_CHAT_ID
      console.log(`[Telegram] Message from chat_id=${chatId} user=${userId}: "${text}"`);

      if (text.startsWith('/start')) {
        await sendMessage(chatId,
          `👋 <b>Welcome to PropPilot AI Bot!</b>\n\n` +
          `Your chat ID is: <code>${chatId}</code>\n\n` +
          `Set this as <code>TELEGRAM_CHAT_ID</code> in Supabase Edge Function secrets to receive push notifications.\n\n` +
          `Type /help to see all commands.`
        );
      } else if (text.startsWith('/status')) {
        await handleStatus(chatId);
      } else if (text.startsWith('/signals')) {
        await handleSignals(chatId);
      } else if (text.startsWith('/positions')) {
        await handlePositions(chatId);
      } else if (text.startsWith('/help')) {
        await handleHelp(chatId);
      } else {
        await sendMessage(chatId, `❓ Unknown command. Type /help for the command list.`);
      }

      return new Response('ok', { headers: cors });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[telegram-bot]', err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
