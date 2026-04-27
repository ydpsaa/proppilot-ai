#!/usr/bin/env bash
set -euo pipefail

echo "PropPilot AI preflight"
echo "======================"

if [ ! -f package.json ]; then
  echo "✗ package.json not found. Run from the project root."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "→ Installing npm dependencies..."
  npm install
fi

echo "→ Checking frontend build..."
npm run build

echo "→ Checking lint baseline..."
npm run lint

echo "→ Checking required files..."
required=(
  "supabase/migrations/FULL_MIGRATION.sql"
  "supabase/migrations/20260426_user_profiles_challenges.sql"
  "supabase/migrations/20260426_security_hardening.sql"
  "supabase/migrations/20260426_cron_secret_jobs.sql"
  "supabase/functions/auto-analyze/index.ts"
  "supabase/functions/execute-paper-trade/index.ts"
  "supabase/functions/update-paper-positions/index.ts"
  "supabase/functions/update-outcomes/index.ts"
  "supabase/functions/update-strategy-stats/index.ts"
)

for file in "${required[@]}"; do
  if [ ! -f "$file" ]; then
    echo "✗ Missing $file"
    exit 1
  fi
done

echo "✓ Preflight passed"
echo ""
echo "Before production deploy, set:"
echo "  export PROPILOT_CRON_SECRET=<long_random_value>"
echo "  supabase secrets set PROPILOT_CRON_SECRET=\$PROPILOT_CRON_SECRET"
echo "  ALTER DATABASE postgres SET \"app.proppilot_cron_secret\" = '<same_value>';"
