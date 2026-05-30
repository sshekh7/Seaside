-- ─────────────────────────────────────────────────────────────────────────────
-- Supabase pg_cron + pg_net schedule for agent-daily-summary Edge Function
--
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor).
--
-- Prerequisites:
--   1. Enable pg_cron:  Dashboard → Database → Extensions → pg_cron (toggle ON)
--   2. Enable pg_net:   Dashboard → Database → Extensions → pg_net  (toggle ON)
--   3. Deploy the Edge Function:
--        supabase functions deploy agent-daily-summary --project-ref <your-ref>
--   4. Replace the two placeholder values below:
--        <YOUR_PROJECT_REF>   e.g. abcdefghijkl
--        <YOUR_ANON_KEY>      Dashboard → Project Settings → API → anon public key
--        <YOUR_CRON_SECRET>   same value as CRON_SECRET env var on the Edge Function
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1: schedule a daily job at 23:00 UTC using pg_cron + pg_net
select cron.schedule(
  'agent-daily-summary-nightly',   -- job name (unique)
  '0 23 * * *',                    -- every day at 23:00 UTC
  $$
    select net.http_post(
      url     := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/agent-daily-summary',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer <YOUR_CRON_SECRET>'
      ),
      body    := jsonb_build_object('trigger', 'cron')
    );
  $$
);

-- To verify it was created:
-- select * from cron.job;

-- To remove it later:
-- select cron.unschedule('agent-daily-summary-nightly');
