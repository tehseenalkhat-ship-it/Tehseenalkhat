-- Add a separate certification identity for Naskh practiced with an ordinary pen.
-- MySQL 8.0+. Safe to rerun; it does not overwrite an existing certification course.
-- After running this migration, use Admin > Course Builder > Naskh (Normal Pen)
-- to author the actual lesson and checkpoint curriculum before opening enrollment.
START TRANSACTION;

INSERT INTO `khat_types` (`code`, `display_name`)
VALUES ('naskh_normal_pen', 'Naskh (Normal Pen)')
ON DUPLICATE KEY UPDATE `display_name` = VALUES(`display_name`);

SET @normal_pen_khat_type_id = (
  SELECT `id` FROM `khat_types` WHERE `code` = 'naskh_normal_pen' LIMIT 1
);
SET @admin_user_id = (
  SELECT `id` FROM `users`
  WHERE `role` = 'admin' AND `deleted_at` IS NULL
  ORDER BY `created_at`
  LIMIT 1
);

INSERT INTO `courses` (`khat_type_id`, `category`, `title`, `description`, `is_deletable`, `created_by`)
SELECT @normal_pen_khat_type_id,
       'certification',
       'Naskh with the normal pen',
       'A separate Naskh certification path for practice with an ordinary pen rather than a cut qalam.',
       0,
       @admin_user_id
FROM DUAL
WHERE @admin_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `courses`
    WHERE `khat_type_id` = @normal_pen_khat_type_id AND `category` = 'certification'
  );

COMMIT;
SELECT IF(@admin_user_id IS NULL, 'Create an active admin account, then rerun this migration.', 'Migration complete.') AS `migration_status`;
