-- ══════════════════════════════════════════════════════════════════════════════
-- PropPilot AI — Trade Screenshot Upload
-- Run this in Supabase SQL Editor: Dashboard → SQL Editor → New query → Run
-- ══════════════════════════════════════════════════════════════════════════════

-- 1. Add screenshot_url column to journal_trades
ALTER TABLE journal_trades
  ADD COLUMN IF NOT EXISTS screenshot_url TEXT;

-- 2. Create the storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'trade-screenshots',
  'trade-screenshots',
  true,
  5242880,  -- 5 MB
  ARRAY['image/jpeg','image/jpg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- 3. RLS: authenticated users can upload
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'auth_upload_screenshots'
  ) THEN
    CREATE POLICY "auth_upload_screenshots"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'trade-screenshots');
  END IF;
END $$;

-- 4. RLS: public read (so image URLs work without auth)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'public_read_screenshots'
  ) THEN
    CREATE POLICY "public_read_screenshots"
      ON storage.objects FOR SELECT
      TO public
      USING (bucket_id = 'trade-screenshots');
  END IF;
END $$;

-- 5. RLS: authenticated users can delete their uploads
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'auth_delete_screenshots'
  ) THEN
    CREATE POLICY "auth_delete_screenshots"
      ON storage.objects FOR DELETE
      TO authenticated
      USING (bucket_id = 'trade-screenshots');
  END IF;
END $$;
