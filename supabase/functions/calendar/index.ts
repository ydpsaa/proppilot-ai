const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,apikey',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  return json({
    status: 'live',
    source: 'empty-calendar',
    events: [],
    updated_at: new Date().toISOString(),
  });
});
