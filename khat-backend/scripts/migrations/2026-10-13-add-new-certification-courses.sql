-- Adds the remaining certification courses required for the revised curriculum.
-- Safe to rerun; it will not overwrite existing course or khat_type records.
-- Includes:
--  - Cut pen: Istinsaakh, Tehseen Al Khat
--  - Normal pen: Istinsaakh, Tehseen Al Khat
-- The normal-pen tracks are treated as distinct khat types, so they can be managed separately.

START TRANSACTION;

INSERT INTO `khat_types` (`code`, `display_name`)
VALUES
  ('istinsaakh', 'Istinsaakh'),
  ('tehseen_al_khat', 'Tehseen Al Khat'),
  ('istinsaakh_normal_pen', 'Istinsaakh (Normal Pen)'),
  ('tehseen_al_khat_normal_pen', 'Tehseen Al Khat (Normal Pen)')
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
  SELECT 'istinsaakh' AS `khat_type_code`, 'Istinsaakh certification course' AS `title`, 'The cut-pen Istinsaakh certification path.' AS `description`
  UNION ALL
  SELECT 'tehseen_al_khat', 'Tehseen Al Khat certification course', 'The cut-pen Tehseen Al Khat certification path.'
  UNION ALL
  SELECT 'istinsaakh_normal_pen', 'Istinsaakh normal pen certification course', 'The normal-pen Istinsaakh certification path.'
  UNION ALL
  SELECT 'tehseen_al_khat_normal_pen', 'Tehseen Al Khat normal pen certification course', 'The normal-pen Tehseen Al Khat certification path.'
) AS course_data
JOIN `khat_types` kt ON kt.`code` = course_data.`khat_type_code`
WHERE @admin_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `courses` existing
    WHERE existing.`khat_type_id` = kt.`id` AND existing.`category` = 'certification'
  );

COMMIT;
SELECT IF(@admin_user_id IS NULL, 'Create an active admin account, then rerun this migration.', 'Migration complete.') AS `migration_status`;
