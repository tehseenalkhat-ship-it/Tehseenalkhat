-- Store the teacher's optional recorded voice feedback alongside the written feedback.
-- Run this once against the PostgreSQL database before deploying the updated backend.
ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS correction_voice_storage_key TEXT;
