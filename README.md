# PropPilot AI

Prop trading OS for challenge tracking, risk sizing, live signals, journal analytics, and automated paper trading.

## Run locally

Install dependencies and start Vite:

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite.

Use **Continue in Demo Mode** to test the app without creating an account.

Copy `.env.example` to `.env.local` when using a different Supabase project.

## Production deploy

```bash
bash deploy.sh
```

The script deploys the static app to Vercel and these Supabase Edge Functions:

- `market-data`
- `auto-analyze`
- `candles`
- `calendar`
- `update-outcomes`
- `update-strategy-stats`
- `update-paper-positions`
- `execute-paper-trade`
- `telegram-bot`

## Required Supabase setup

Run the SQL files in Supabase SQL Editor:

1. `supabase/migrations/FULL_MIGRATION.sql`
2. `supabase/migrations/20260422_phase3_paper_engine.sql`
3. `supabase/migrations/20260426_user_profiles_challenges.sql`
4. `supabase/migrations/20260426_security_hardening.sql`
5. `supabase/migrations/20260426_cron_secret_jobs.sql`

Before running `20260426_cron_secret_jobs.sql`, set the cron secret in both
Supabase Edge Functions and Postgres:

```sql
-- Use the same value as PROPILOT_CRON_SECRET.
ALTER DATABASE postgres SET "app.proppilot_cron_secret" = '<long_random_value>';
SELECT set_config('app.proppilot_cron_secret', '<long_random_value>', false);
```

## Optional secrets

```bash
supabase secrets set GROQ_API_KEY=<key>
supabase secrets set TELEGRAM_BOT_TOKEN=<token>
supabase secrets set TELEGRAM_CHAT_ID=<chat_id>
supabase secrets set PROPILOT_CRON_SECRET=<long_random_value>
```

Market data uses Yahoo Finance through `market-data`; no TwelveData key is required.

Privileged Edge Functions accept a signed Supabase user JWT, the Supabase
service-role token, or `x-proppilot-cron-secret` matching `PROPILOT_CRON_SECRET`.

## Preflight

Run this before deploy:

```bash
bash scripts/preflight.sh
```

Production smoke test after deploy:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "x-proppilot-cron-secret: $PROPILOT_CRON_SECRET" \
  -d '{"dryRun":true}' \
  https://nxiednydxyrtxpkmgtof.supabase.co/functions/v1/auto-analyze
```

## Main app routes

- `index.html#dashboard`
- `index.html#signals`
- `index.html#analyze`
- `index.html#algo`
- `index.html#journal`
- `index.html#risk`
- `index.html#challenge`
- `index.html#settings`
