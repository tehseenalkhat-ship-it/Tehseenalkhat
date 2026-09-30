-- Track the LiveKit egress job that forwards each event to its YouTube broadcast.
-- Run this once against the PostgreSQL database before starting the updated backend.
ALTER TABLE live_events
  ADD COLUMN IF NOT EXISTS livekit_egress_id TEXT;
