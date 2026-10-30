-- Mashq category submissions, mark-only teacher review, and category-specific chat threads.
-- MySQL 8.0+. Safe to rerun; current Naskh worksheet levels receive stable set keys.

START TRANSACTION;

ALTER TABLE `levels`
  ADD COLUMN IF NOT EXISTS `mashq_category_key` VARCHAR(32) NULL;
ALTER TABLE `entries`
  ADD COLUMN IF NOT EXISTS `mashq_category_key` VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS `entry_kind` VARCHAR(40) NULL;
ALTER TABLE `entries`
  ADD COLUMN IF NOT EXISTS `mark_out_of_ten` SMALLINT NULL,
  ADD COLUMN IF NOT EXISTS `mark_passed` TINYINT(1) NULL;

-- Replace the older three-value entry kind check where the imported schema has it.
SET @entry_kind_check_exists = (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE() AND table_name = 'entries'
    AND constraint_name = 'entries_entry_kind_check' AND constraint_type = 'CHECK'
);
SET @drop_entry_kind_check_sql = IF(
  @entry_kind_check_exists > 0,
  'ALTER TABLE `entries` DROP CHECK `entries_entry_kind_check`',
  'SELECT 1'
);
PREPARE drop_entry_kind_check FROM @drop_entry_kind_check_sql;
EXECUTE drop_entry_kind_check;
DEALLOCATE PREPARE drop_entry_kind_check;
ALTER TABLE `entries`
  ADD CONSTRAINT `entries_entry_kind_check`
  CHECK (`entry_kind` IS NULL OR `entry_kind` IN ('practice_marking', 'checkpoint_assessment', 'secondary_marking', 'mashq_marking'));

ALTER TABLE `course_chat_messages`
  ADD COLUMN IF NOT EXISTS `thread_key` VARCHAR(64) NOT NULL DEFAULT 'course';

UPDATE `levels` l
JOIN `courses` c ON c.`id` = l.`course_id`
JOIN `khat_types` kt ON kt.`id` = c.`khat_type_id`
SET l.`mashq_category_key` = CASE
  WHEN l.`order_index` < 2 THEN 'qs'
  WHEN l.`order_index` < 4 THEN 'ms'
  ELSE 'rh'
END
WHERE kt.`code` = 'naskh' AND c.`category` = 'secondary'
  AND c.`title` = 'Mashq worksheets — Naskh';

COMMIT;
