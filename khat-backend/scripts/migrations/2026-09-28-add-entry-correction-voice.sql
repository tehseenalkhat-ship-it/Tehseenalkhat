-- Store the teacher's optional recorded voice feedback alongside the written feedback.
-- MySQL 8.0+: run once if this column is not already present in the imported dump.
ALTER TABLE `entries`
  ADD COLUMN `correction_voice_storage_key` TEXT NULL;
