-- Create separate Style 1 / Style 2 cut-pen certification courses for Naskh
-- and Istinsaakh, initially copying each existing course's level content.
-- Safe to rerun. Does not copy enrollments or historical submissions.
-- Apply after the student-dashboard-catalog migration.

START TRANSACTION;

SET @course_style_column_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'courses' AND column_name = 'course_style'
);
SET @add_course_style_column = IF(
  @course_style_column_exists = 0,
  'ALTER TABLE `courses` ADD COLUMN `course_style` VARCHAR(32) NOT NULL DEFAULT '''' AFTER `title`',
  'SELECT 1'
);
PREPARE add_course_style_column_stmt FROM @add_course_style_column;
EXECUTE add_course_style_column_stmt;
DEALLOCATE PREPARE add_course_style_column_stmt;

SET @course_type_fk_index_exists = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'courses' AND index_name = 'idx_courses_khat_type_fk'
);
SET @add_course_type_fk_index = IF(
  @course_type_fk_index_exists = 0,
  'CREATE INDEX `idx_courses_khat_type_fk` ON `courses` (`khat_type_id`)',
  'SELECT 1'
);
PREPARE add_course_type_fk_index_stmt FROM @add_course_type_fk_index;
EXECUTE add_course_type_fk_index_stmt;
DEALLOCATE PREPARE add_course_type_fk_index_stmt;

SET @legacy_course_index_exists = (
  SELECT COUNT(*) FROM information_schema.statistics old_index
  WHERE old_index.table_schema = DATABASE()
    AND old_index.table_name = 'courses'
    AND old_index.index_name = 'uq_one_certification_course_per_khat_type'
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.statistics style_column
      WHERE style_column.table_schema = old_index.table_schema
        AND style_column.table_name = old_index.table_name
        AND style_column.index_name = old_index.index_name
        AND style_column.column_name = 'course_style'
    )
);
SET @drop_legacy_course_index = IF(
  @legacy_course_index_exists > 0,
  'ALTER TABLE `courses` DROP INDEX `uq_one_certification_course_per_khat_type`',
  'SELECT 1'
);
PREPARE drop_legacy_course_index_stmt FROM @drop_legacy_course_index;
EXECUTE drop_legacy_course_index_stmt;
DEALLOCATE PREPARE drop_legacy_course_index_stmt;

SET @style_course_index_exists = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'courses'
    AND index_name = 'uq_one_certification_course_per_khat_type'
    AND seq_in_index = 3 AND column_name = 'course_style'
);
SET @add_style_course_index = IF(
  @style_course_index_exists = 0,
  'CREATE UNIQUE INDEX `uq_one_certification_course_per_khat_type` ON `courses` (`khat_type_id`, `certification_guard`, `course_style`)',
  'SELECT 1'
);
PREPARE add_style_course_index_stmt FROM @add_style_course_index;
EXECUTE add_style_course_index_stmt;
DEALLOCATE PREPARE add_style_course_index_stmt;

UPDATE `courses` c
JOIN `khat_types` kt ON kt.`id` = c.`khat_type_id`
SET c.`course_style` = 'style-1'
WHERE c.`category` = 'certification'
  AND kt.`code` IN ('naskh', 'istinsaakh')
  AND c.`title` LIKE '%Style 1';

UPDATE `courses` c
JOIN `khat_types` kt ON kt.`id` = c.`khat_type_id`
SET c.`course_style` = 'style-2'
WHERE c.`category` = 'certification'
  AND kt.`code` IN ('naskh', 'istinsaakh')
  AND c.`title` LIKE '%Style 2';

UPDATE `courses` c
JOIN `khat_types` kt ON kt.`id` = c.`khat_type_id`
SET c.`title` = CASE
  WHEN kt.`code` = 'naskh' AND c.`course_style` = 'style-1' THEN 'Naskh Style One'
  WHEN kt.`code` = 'naskh' AND c.`course_style` = 'style-2' THEN 'Naskh Style Two'
  WHEN kt.`code` = 'istinsaakh' AND c.`course_style` = 'style-1' THEN 'Instinsakh Style One'
  WHEN kt.`code` = 'istinsaakh' AND c.`course_style` = 'style-2' THEN 'Instinsakh Style Two'
  ELSE c.`title`
END
WHERE c.`category` = 'certification'
  AND kt.`code` IN ('naskh', 'istinsaakh')
  AND c.`course_style` IN ('style-1', 'style-2');

UPDATE `courses` c
JOIN `khat_types` kt ON kt.`id` = c.`khat_type_id`
SET c.`title` = CASE
  WHEN kt.`code` = 'naskh' AND c.`title` LIKE '%Style 1%' THEN 'Naskh Style One'
  WHEN kt.`code` = 'naskh' AND c.`title` LIKE '%Style 2%' THEN 'Naskh Style Two'
  WHEN kt.`code` = 'istinsaakh' AND c.`title` LIKE '%Style 1%' THEN 'Instinsakh Style One'
  WHEN kt.`code` = 'istinsaakh' AND c.`title` LIKE '%Style 2%' THEN 'Instinsakh Style Two'
  ELSE c.`title`
END
WHERE c.`category` = 'certification'
  AND kt.`code` IN ('naskh', 'istinsaakh')
  AND c.`title` LIKE '%Style %';

INSERT INTO `courses`
  (`khat_type_id`, `category`, `title`, `course_style`, `description`, `is_deletable`, `created_by`, `guidance_question`)
SELECT source.`khat_type_id`, source.`category`, variants.`title`, variants.`course_style`, source.`description`, source.`is_deletable`, source.`created_by`, source.`guidance_question`
FROM `courses` source
JOIN `khat_types` kt ON kt.`id` = source.`khat_type_id`
JOIN (
  SELECT 'naskh' AS `code`, 'Naskh Style One' AS `title`, 'style-1' AS `course_style`
  UNION ALL SELECT 'naskh', 'Naskh Style Two', 'style-2'
  UNION ALL SELECT 'istinsaakh', 'Instinsakh Style One', 'style-1'
  UNION ALL SELECT 'istinsaakh', 'Instinsakh Style Two', 'style-2'
) variants ON variants.`code` = kt.`code`
WHERE source.`category` = 'certification'
  AND NOT EXISTS (
    SELECT 1 FROM `courses` existing
    WHERE existing.`khat_type_id` = source.`khat_type_id`
      AND existing.`category` = source.`category`
      AND existing.`course_style` = variants.`course_style`
  )
  AND source.`id` = (
    SELECT original.`id`
    FROM `courses` original
    WHERE original.`khat_type_id` = source.`khat_type_id`
      AND original.`category` = 'certification'
      AND original.`course_style` NOT IN ('style-1', 'style-2')
      AND original.`title` NOT LIKE '%Style One%'
      AND original.`title` NOT LIKE '%Style Two%'
    ORDER BY original.`created_at`, original.`id`
    LIMIT 1
  );

INSERT INTO `levels`
  (`id`, `course_id`, `order_index`, `level_type`, `title`, `media`, `sheet_files`, `badge_tier`)
SELECT UUID(), target.`id`, source_level.`order_index`, source_level.`level_type`, source_level.`title`, source_level.`media`, source_level.`sheet_files`, source_level.`badge_tier`
FROM `courses` source
JOIN `khat_types` source_type ON source_type.`id` = source.`khat_type_id`
  AND source_type.`code` IN ('naskh', 'istinsaakh')
JOIN `levels` source_level ON source_level.`course_id` = source.`id`
JOIN `courses` target ON target.`khat_type_id` = source.`khat_type_id`
  AND target.`category` = 'certification'
  AND target.`course_style` IN ('style-1', 'style-2')
LEFT JOIN `levels` existing ON existing.`course_id` = target.`id`
  AND existing.`order_index` = source_level.`order_index`
WHERE source.`category` = 'certification'
  AND source.`course_style` NOT IN ('style-1', 'style-2')
  AND source.`title` NOT LIKE '%Style One%'
  AND source.`title` NOT LIKE '%Style Two%'
  AND existing.`id` IS NULL;

COMMIT;
