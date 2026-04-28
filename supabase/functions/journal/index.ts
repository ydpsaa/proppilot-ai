// ═══════════════════════════════════════════════════════════════════════════
// PropPilot AI — journal Edge Function
//
// Endpoints:
//   GET  /journal?action=list&account_id=1&limit=50&offset=0
//   GET  /journal?action=stats&account_id=1
//   GET  /journal?action=patterns&account_id=1
//   GET  /journal?action=weekly&account_id=1
//   POST /journal  { action: 'create', trade: {...} }
//   POST /journal  { action: 'update', id: N, trade: {...} }
//   POST /journal  { action: 'delete', id: N }
//   POST /journal  { action: 'analyze', id: N }          ← triggers Groq AI analysis
//   POST /journal  { action: 'refresh_patterns', account_id: 1 }
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2';

const SB_URL   = Deno.env.get('SUPABASE_URL')!;
const SB_SKEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROQ_KEY = Deno.env.get('GROQ_API_KEY') || '';

const sb = createClient(SB_URL, SB_SKEY, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,apikey,x-proppilot-cron-secret',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function err(msg: string, status = 400) {
  return json({ error: msg }, status);
}

// ── Groq AI analysis for a single trade ─────────────────────────────────────

async function analyzeWithGroq(trade: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!GROQ_KEY) return { error: 'GROQ_API_KEY not set' };

  const prompt = `You are an elite prop trading coach analyzing a trader's trade journal entry.

TRADE DATA:
- Symbol: ${trade.symbol} | Direction: ${trade.direction} | Session: ${trade.session}
- Entry: ${trade.entry_price} | Exit: ${trade.exit_price} | SL: ${trade.sl_price} | TP: ${trade.tp_price}
- P&L: ${trade.pnl_usd} USD | R-Multiple: ${trade.pnl_r}R | Outcome: ${trade.outcome}
- Strategy: ${trade.strategy} | Setup: ${trade.setup_type} | HTF Trend: ${trade.htf_trend}
- Confluence: ${JSON.stringify(trade.confluence)}
- Entry Reason: ${trade.entry_reason || 'Not provided'}
- Exit Reason: ${trade.exit_reason || 'Not provided'}
- What Happened: ${trade.what_happened || 'Not provided'}
- Mindset Score: ${trade.mindset_score}/10 | Emotions: ${JSON.stringify(trade.emotions)}
- Followed Plan: ${trade.followed_plan} | Impulsive: ${trade.impulsive}
- Mistakes: ${JSON.stringify(trade.mistakes)}

Respond ONLY with valid JSON in this exact format:
{
  "entry_score": <0-100>,
  "exit_score": <0-100>,
  "risk_score": <0-100>,
  "overall_score": <0-100>,
  "what_happened": "<objective 1-2 sentence description>",
  "what_went_well": "<what worked in this trade>",
  "what_to_improve": "<specific actionable improvement>",
  "key_lesson": "<the single most important takeaway>",
  "pattern_identified": "<trading pattern name or null>",
  "recommended_action": "<hold|cut_loss|take_profit|no_action>",
  "recommendation_reason": "<why>",
  "verdict": "<good_trade|premature_exit|bad_entry|good_loss|overtraded>"
}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text();
      return { error: `Groq error ${res.status}: ${text}` };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);

    return {
      ...parsed,
      raw_groq_response: content,
      model_used: 'llama-3.3-70b-versatile',
      tokens_used: data.usage?.total_tokens || 0,
    };
  } catch (e) {
    return { error: String(e) };
  }
}

// ── GET handler ──────────────────────────────────────────────────────────────

async function handleGet(url: URL) {
  const action     = url.searchParams.get('action') || 'list';
  const account_id = parseInt(url.searchParams.get('account_id') || '1');
  const limit      = parseInt(url.searchParams.get('limit')  || '50');
  const offset     = parseInt(url.searchParams.get('offset') || '0');

  if (action === 'list') {
    const symbol  = url.searchParams.get('symbol');
    const outcome = url.searchParams.get('outcome');
    const session = url.searchParams.get('session');

    let q = sb
      .from('journal_trades')
      .select('*')
      .eq('account_id', account_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (symbol)  q = q.eq('symbol',  symbol);
    if (outcome) q = q.eq('outcome', outcome);
    if (session) q = q.eq('session', session);

    const { data, error } = await q;
    if (error) return err(error.message);
    return json({ trades: data, count: data?.length ?? 0 });
  }

  if (action === 'stats') {
    const { data, error } = await sb
      .from('v_journal_performance')
      .select('*');
    if (error) return err(error.message);
    return json({ stats: data });
  }

  if (action === 'psychology') {
    const { data, error } = await sb
      .from('v_journal_psychology')
      .select('*');
    if (error) return err(error.message);
    return json({ psychology: data });
  }

  if (action === 'mistakes') {
    const { data, error } = await sb
      .from('v_journal_mistakes')
      .select('*');
    if (error) return err(error.message);
    return json({ mistakes: data });
  }

  if (action === 'patterns') {
    const { data, error } = await sb
      .from('v_journal_patterns')
      .select('*')
      .eq('account_id', account_id);
    if (error) return err(error.message);
    return json({ patterns: data });
  }

  if (action === 'signals') {
    const { data, error } = await sb
      .from('v_journal_signals')
      .select('*');
    if (error) return err(error.message);
    return json({ signals: data });
  }

  if (action === 'weekly') {
    const { data, error } = await sb
      .from('v_journal_weekly')
      .select('*');
    if (error) return err(error.message);
    return json({ weekly: data });
  }

  if (action === 'get') {
    const id = url.searchParams.get('id');
    if (!id) return err('id required');
    const { data, error } = await sb
      .from('journal_trades')
      .select('*, journal_analyses(*)')
      .eq('id', parseInt(id))
      .single();
    if (error) return err(error.message);
    return json({ trade: data });
  }

  return err(`Unknown action: ${action}`);
}

// ── POST handler ─────────────────────────────────────────────────────────────

async function handlePost(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body');
  }

  const action = body.action as string;

  // ── CREATE ────────────────────────────────────────────────────────────────
  if (action === 'create') {
    const trade = body.trade as Record<string, unknown>;
    if (!trade?.symbol || !trade?.direction) {
      return err('trade.symbol and trade.direction are required');
    }

    const { data, error } = await sb
      .from('journal_trades')
      .insert(trade)
      .select()
      .single();

    if (error) return err(error.message);
    return json({ trade: data }, 201);
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────
  if (action === 'update') {
    const id    = body.id as number;
    const trade = body.trade as Record<string, unknown>;
    if (!id) return err('id required');

    const { data, error } = await sb
      .from('journal_trades')
      .update({ ...trade, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) return err(error.message);
    return json({ trade: data });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const id = body.id as number;
    if (!id) return err('id required');

    const { error } = await sb
      .from('journal_trades')
      .delete()
      .eq('id', id);

    if (error) return err(error.message);
    return json({ deleted: id });
  }

  // ── ANALYZE — run Groq AI on a trade ─────────────────────────────────────
  if (action === 'analyze') {
    const id = body.id as number;
    if (!id) return err('id required');

    // Fetch the trade
    const { data: trade, error: fetchErr } = await sb
      .from('journal_trades')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr) return err(fetchErr.message);
    if (!trade)   return err('Trade not found', 404);

    // Run AI analysis
    const analysis = await analyzeWithGroq(trade);
    if (analysis.error) return err(String(analysis.error), 502);

    // Upsert into journal_analyses
    const { error: insErr } = await sb
      .from('journal_analyses')
      .upsert({
        trade_id:             id,
        entry_score:          analysis.entry_score,
        exit_score:           analysis.exit_score,
        risk_score:           analysis.risk_score,
        overall_score:        analysis.overall_score,
        what_happened:        analysis.what_happened,
        what_went_well:       analysis.what_went_well,
        what_to_improve:      analysis.what_to_improve,
        key_lesson:           analysis.key_lesson,
        pattern_identified:   analysis.pattern_identified,
        recommended_action:   analysis.recommended_action,
        recommendation_reason: analysis.recommendation_reason,
        verdict:              analysis.verdict,
        raw_groq_response:    analysis.raw_groq_response,
        model_used:           analysis.model_used,
        tokens_used:          analysis.tokens_used,
      }, { onConflict: 'trade_id' });

    if (insErr) return err(insErr.message);

    // Update denormalized fields on journal_trades
    await sb
      .from('journal_trades')
      .update({
        ai_analyzed:     true,
        ai_analyzed_at:  new Date().toISOString(),
        ai_entry_score:  analysis.entry_score,
        ai_exit_score:   analysis.exit_score,
        ai_risk_score:   analysis.risk_score,
        ai_overall_score: analysis.overall_score,
        ai_verdict:      analysis.verdict,
        ai_key_lesson:   analysis.key_lesson,
        ai_pattern:      analysis.pattern_identified,
      })
      .eq('id', id);

    return json({ analysis, trade_id: id });
  }

  // ── REFRESH PATTERNS ─────────────────────────────────────────────────────
  if (action === 'refresh_patterns') {
    const account_id = (body.account_id as number) || 1;

    const { data, error } = await sb
      .rpc('fn_refresh_journal_patterns', { p_account_id: account_id });

    if (error) return err(error.message);
    return json({ patterns_updated: data });
  }

  // ── PATTERN MATCH for current setup ──────────────────────────────────────
  if (action === 'pattern_match') {
    const { account_id = 1, symbol, session, direction, strategy } = body as Record<string, unknown>;
    if (!symbol || !session || !direction) {
      return err('symbol, session, direction required');
    }

    const { data, error } = await sb.rpc('fn_journal_pattern_match', {
      p_account_id: account_id,
      p_symbol:     symbol,
      p_session:    session,
      p_direction:  direction,
      p_strategy:   strategy || null,
    });

    if (error) return err(error.message);
    return json({ match: data?.[0] || null });
  }

  // ── BATCH ANALYZE — queue all un-analyzed trades ──────────────────────────
  if (action === 'batch_analyze') {
    const account_id = (body.account_id as number) || 1;
    const max = (body.max as number) || 5;

    const { data: pending, error: fetchErr } = await sb
      .from('journal_trades')
      .select('id')
      .eq('account_id', account_id)
      .eq('ai_analyzed', false)
      .not('outcome', 'is', null)
      .order('created_at', { ascending: true })
      .limit(max);

    if (fetchErr) return err(fetchErr.message);
    if (!pending || pending.length === 0) {
      return json({ analyzed: 0, message: 'No pending trades to analyze' });
    }

    const results: Array<{ id: number; ok: boolean; error?: string }> = [];
    for (const { id } of pending) {
      const { data: trade } = await sb.from('journal_trades').select('*').eq('id', id).single();
      if (!trade) { results.push({ id, ok: false, error: 'not found' }); continue; }

      const analysis = await analyzeWithGroq(trade);
      if (analysis.error) {
        results.push({ id, ok: false, error: String(analysis.error) });
        continue;
      }

      await sb.from('journal_analyses').upsert({
        trade_id: id, ...analysis,
      }, { onConflict: 'trade_id' });

      await sb.from('journal_trades').update({
        ai_analyzed: true,
        ai_analyzed_at: new Date().toISOString(),
        ai_entry_score:  analysis.entry_score,
        ai_exit_score:   analysis.exit_score,
        ai_risk_score:   analysis.risk_score,
        ai_overall_score: analysis.overall_score,
        ai_verdict:      analysis.verdict,
        ai_key_lesson:   analysis.key_lesson,
        ai_pattern:      analysis.pattern_identified,
      }).eq('id', id);

      results.push({ id, ok: true });
    }

    return json({ analyzed: results.filter(r => r.ok).length, results });
  }

  return err(`Unknown action: ${action}`);
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  try {
    const url = new URL(req.url);
    if (req.method === 'GET')  return await handleGet(url);
    if (req.method === 'POST') return await handlePost(req);
    return err('Method not allowed', 405);
  } catch (e) {
    console.error('journal function error:', e);
    return err(`Internal error: ${String(e)}`, 500);
  }
});
