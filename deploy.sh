#!/usr/bin/env bash
# PropPilot AI — One-Command Deploy Script
set -e

PROJECT_REF="${SUPABASE_PROJECT_REF:-nxiednydxyrtxpkmgtof}"
SUPABASE_URL="https://${PROJECT_REF}.supabase.co"
FUNCTIONS=(market-data auto-analyze candles calendar update-outcomes update-strategy-stats update-paper-positions execute-paper-trade telegram-bot)

echo "🚀 PropPilot AI Deploy — Project: ${PROJECT_REF}"

# Step 0: generate secret if missing
if [ -z "$PROPILOT_CRON_SECRET" ]; then
  export PROPILOT_CRON_SECRET=$(openssl rand -hex 32)
  echo "⚡ Generated PROPILOT_CRON_SECRET: $PROPILOT_CRON_SECRET"
  echo "   ⚠️  SAVE IT — you need it for the SQL Editor step!"
fi

# Step 1: link project
supabase link --project-ref "$PROJECT_REF" || true

# Step 2: set secrets
supabase secrets set PROPILOT_CRON_SECRET="$PROPILOT_CRON_SECRET"
[ -n "$GROQ_API_KEY" ] && supabase secrets set GROQ_API_KEY="$GROQ_API_KEY" && echo "✅ GROQ_API_KEY set"
[ -n "$TELEGRAM_BOT_TOKEN" ] && supabase secrets set TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"

# Step 3: deploy 9 Edge Functions
echo "▶ Deploying Edge Functions..."
for fn in "${FUNCTIONS[@]}"; do
  echo "  → $fn"
  supabase functions deploy "$fn" --no-verify-jwt
done
echo "✅ All 9 functions deployed"

# Step 4: SQL reminder
echo ""
echo "════════════════════════════════════════════════════════════"
echo "📋 SQL STEP — open this URL and paste SUPABASE_SETUP.sql:"
echo "   https://supabase.com/dashboard/project/${PROJECT_REF}/sql/new"
echo ""
echo "   1. Replace YOUR_CRON_SECRET_HERE → $PROPILOT_CRON_SECRET"
echo "   2. Run the query"
echo "   3. Verify: SELECT jobname FROM cron.job ORDER BY jobname;"
echo "════════════════════════════════════════════════════════════"

# Step 5: push to GitHub
git add -A
git commit -m "feat: complete PropPilot AI deployment" || true
git push origin main
echo "✅ Pushed to GitHub — Vercel auto-deploy triggered"

# Step 6: smoke tests
echo ""
echo "▶ Smoke tests..."
curl -sf "${SUPABASE_URL}/functions/v1/market-data?type=price&symbol=XAU/USD" | python3 -c "import sys,json; d=json.load(sys.stdin); print('✅ market-data:', d.get('prices',{}))" 2>/dev/null || echo "⚠️  market-data cold-start, retry in 30s"

curl -sf -X POST -H "Content-Type: application/json" -H "x-proppilot-cron-secret: $PROPILOT_CRON_SECRET" -d '{"dryRun":true}' "${SUPABASE_URL}/functions/v1/auto-analyze" | python3 -c "import sys,json; d=json.load(sys.stdin); print('✅ auto-analyze:', d.get('totalSignals',d.get('ok')))" 2>/dev/null || echo "⚠️  auto-analyze: check cron secret matches"

curl -sf -X POST -H "x-proppilot-cron-secret: $PROPILOT_CRON_SECRET" "${SUPABASE_URL}/functions/v1/update-paper-positions" | python3 -c "import sys,json; d=json.load(sys.stdin); print('✅ positions:', d)" 2>/dev/null || echo "⚠️  update-paper-positions failed"

echo ""
echo "✅ Done! App: https://proppilot-ai.vercel.app"
