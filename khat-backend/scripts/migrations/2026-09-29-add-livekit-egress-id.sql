-- Track the LiveKit egress job that forwards each event to its YouTube broadcast.
-- MySQL 8.0+: run once if this column is not already present in the imported dump.
ALTER TABLE `live_events`
  ADD COLUMN `livekit_egress_id` TEXT NULL;
