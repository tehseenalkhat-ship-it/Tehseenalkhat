-- Ensure the three cut-qalam khat types have their non-deletable certification course records.
-- MySQL 8.0+. Safe to rerun; existing certification courses are left untouched.
-- Author lesson/checkpoint content in Admin > Course Builder before student enrollment.
START TRANSACTION;

INSERT INTO `khat_types` (`code`, `display_name`)
VALUES
  ('naskh', 'Naskh'),
  ('sulus', 'Sulus (Thuluth)'),
  ('nastaaleeq', 'Nastaaleeq')
ON DUPLICATE KEY UPDATE `display_name` = VALUES(`display_name`);

SET @admin_user_id = (
  SELECT `id` FROM `users`
  WHERE `role` = 'admin' AND `deleted_at` IS NULL
  ORDER BY `created_at`
  LIMIT 1
);

INSERT INTO `courses` (`khat_type_id`, `category`, `title`, `description`, `is_deletable`, `created_by`)
SELECT kt.`id`, 'certification', course_data.`title`, course_data.`description`, 0, @admin_user_id
FROM (
  SELECT 'naskh' AS `khat_type_code`, 'Naskh certification course' AS `title`, 'The cut-qalam Naskh certification path.' AS `description`
  UNION ALL
  SELECT 'sulus', 'Sulus (Thuluth) certification course', 'The cut-qalam Sulus (Thuluth) certification path.'
  UNION ALL
  SELECT 'nastaaleeq', 'Nastaaleeq certification course', 'The cut-qalam Nastaaleeq certification path.'
) AS course_data
JOIN `khat_types` kt ON kt.`code` = course_data.`khat_type_code`
WHERE @admin_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `courses` existing
    WHERE existing.`khat_type_id` = kt.`id` AND existing.`category` = 'certification'
  );

COMMIT;
SELECT IF(@admin_user_id IS NULL, 'Create an active admin account, then rerun this migration.', 'Migration complete.') AS `migration_status`;
