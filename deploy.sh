#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# PropPilot AI — Deploy Script
# Запусти один раз: bash deploy.sh
# ═══════════════════════════════════════════════════════════════════════════
set -e

PROJECT_REF="nxiednydxyrtxpkmgtof"
TD_KEY="552e649e1b1f4bba97d590c37e981118"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     PropPilot AI — Full Deploy           ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Step 1: Git ──────────────────────────────────────────────────────────────
echo "▶ 1/6  Git init + commit..."
if [ ! -d ".git" ]; then
  git init
fi
git add -A
git commit -m "PropPilot AI — deploy $(date +%Y-%m-%d)" || echo "(nothing to commit)"

# ── Step 2: Vercel ────────────────────────────────────────────────────────────
echo ""
echo "▶ 2/6  Vercel deploy..."
if command -v vercel &>/dev/null; then
  vercel --prod --yes
else
  echo "  ⚠ vercel not found. Install: npm i -g vercel"
  echo "  Then run: vercel --prod"
fi

# ── Step 3: Supabase CLI ──────────────────────────────────────────────────────
echo ""
echo "▶ 3/6  Installing Supabase CLI if needed..."
if ! command -v supabase &>/dev/null; then
  if command -v brew &>/dev/null; then
    brew install supabase/tap/supabase
  elif command -v npm &>/dev/null; then
    npm install -g supabase
  else
    echo "  ✗ Cannot install supabase CLI automatically."
    echo "  Install manually: https://supabase.com/docs/guides/cli/getting-started"
    exit 1
  fi
fi

# ── Step 4: Link project ──────────────────────────────────────────────────────
echo ""
echo "▶ 4/6  Linking Supabase project $PROJECT_REF..."
supabase link --project-ref "$PROJECT_REF"

# ── Step 5: Secrets ───────────────────────────────────────────────────────────
echo ""
echo "▶ 5/6  Setting secrets..."
supabase secrets set TWELVE_DATA_KEY="$TD_KEY"

# Set GROQ_API_KEY if provided
if [ -n "$GROQ_API_KEY" ]; then
  supabase secrets set GROQ_API_KEY="$GROQ_API_KEY"
  echo "  ✓ GROQ_API_KEY set"
else
  echo "  ⚠ GROQ_API_KEY not set. Set it manually:"
  echo "    supabase secrets set GROQ_API_KEY=<your_key>"
fi

# ── Step 6: Deploy Edge Functions ─────────────────────────────────────────────
echo ""
echo "▶ 6/6  Deploying Edge Functions..."

FUNCTIONS=(
  "auto-analyze"
  "update-outcomes"
  "update-strategy-stats"
  "update-paper-positions"
  "execute-paper-trade"
)

for fn in "${FUNCTIONS[@]}"; do
  echo "  → Deploying $fn..."
  supabase functions deploy "$fn" --no-verify-jwt
  echo "  ✓ $fn deployed"
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║           DEPLOY COMPLETE! ✓             ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "NEXT STEP: Run SQL migration in Supabase Dashboard"
echo "→ https://supabase.com/dashboard/project/$PROJECT_REF/sql/new"
echo "→ Open file: supabase/SETUP_ALL.sql"
echo "→ Paste contents → Run"
echo ""
echo "Then test Edge Functions:"
echo "  curl https://$PROJECT_REF.supabase.co/functions/v1/auto-analyze"
echo "  curl https://$PROJECT_REF.supabase.co/functions/v1/update-outcomes"
echo ""
