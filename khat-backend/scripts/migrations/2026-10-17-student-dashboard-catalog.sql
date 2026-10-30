-- Student dashboard catalog and mock curriculum data.
-- MySQL 8.0+. Safe to rerun; real level rows are copied only when missing.
-- Sulus / Nastaaleeq are short crash courses; Naskh secondary becomes Mashq.

START TRANSACTION;

UPDATE `khat_types`
SET `display_name` = 'Naskh (Normal Pen)'
WHERE `code` = 'naskh_normal_pen';
SET @naskh_khat_type_id = (SELECT `id` FROM `khat_types` WHERE `code` = 'naskh' LIMIT 1);

-- Course names and catalog categories now match the student learning path.
UPDATE `courses` c
JOIN `khat_types` kt ON kt.`id` = c.`khat_type_id`
SET c.`title` = CASE kt.`code`
      WHEN 'naskh' THEN 'Naskh — Cut Pen Certification'
      WHEN 'naskh_normal_pen' THEN 'Naskh — Normal Pen Certification'
      WHEN 'sulus' THEN 'Thuluth — Crash Course'
      WHEN 'nastaaleeq' THEN 'Nastaaleeq — Crash Course'
      WHEN 'istinsaakh' THEN 'Istinsaakh — Certification'
      WHEN 'tehseen_al_khat' THEN 'Tehseen Al Khat — Certification'
      WHEN 'istinsaakh_normal_pen' THEN 'Istinsaakh — Normal Pen Certification'
      WHEN 'tehseen_al_khat_normal_pen' THEN 'Tehseen Al Khat — Normal Pen Certification'
      ELSE c.`title`
    END,
    c.`description` = CASE
      WHEN kt.`code` = 'naskh' AND c.`category` = 'certification' THEN 'Practise Naskh handwriting with a cut qalam. Regular practice levels are marked; checkpoint tests receive a thorough assessment.'
      WHEN kt.`code` = 'naskh_normal_pen' THEN 'Practise Naskh handwriting with an everyday pen. Regular practice levels are marked; checkpoint tests receive a thorough assessment.'
      WHEN kt.`code` = 'sulus' THEN 'A short, focused introduction to Thuluth calligraphy.'
      WHEN kt.`code` = 'nastaaleeq' THEN 'A short, focused introduction to Nastaaleeq calligraphy.'
      WHEN kt.`code` = 'istinsaakh' THEN 'Develop Istinsaakh handwriting through marked practice and checkpoint assessments.'
      WHEN kt.`code` = 'tehseen_al_khat' THEN 'Refine Tehseen Al Khat through marked practice and checkpoint assessments.'
      WHEN kt.`code` = 'istinsaakh_normal_pen' THEN 'Develop Istinsaakh handwriting with an everyday pen through marked practice and checkpoint assessments.'
      WHEN kt.`code` = 'tehseen_al_khat_normal_pen' THEN 'Refine Tehseen Al Khat with an everyday pen through marked practice and checkpoint assessments.'
      ELSE c.`description`
    END,
    c.`category` = CASE WHEN kt.`code` IN ('sulus', 'nastaaleeq') AND c.`category` = 'certification'
                        THEN 'secondary' ELSE c.`category` END
WHERE c.`category` IN ('certification', 'secondary')
  AND kt.`code` IN ('naskh', 'naskh_normal_pen', 'sulus', 'nastaaleeq', 'istinsaakh', 'tehseen_al_khat', 'istinsaakh_normal_pen', 'tehseen_al_khat_normal_pen');

UPDATE `courses` c
JOIN `khat_types` kt ON kt.`id` = c.`khat_type_id`
SET c.`description` = CASE
  WHEN kt.`code` = 'naskh' AND c.`category` = 'certification' THEN 'Practise Naskh handwriting with a cut qalam. Regular practice levels are marked; checkpoint tests receive a thorough assessment.'
  WHEN kt.`code` = 'naskh_normal_pen' THEN 'Practise Naskh handwriting with an everyday pen. Regular practice levels are marked; checkpoint tests receive a thorough assessment.'
  WHEN kt.`code` = 'sulus' THEN 'A short, focused introduction to Thuluth calligraphy.'
  WHEN kt.`code` = 'nastaaleeq' THEN 'A short, focused introduction to Nastaaleeq calligraphy.'
  WHEN kt.`code` = 'istinsaakh' THEN 'Develop Istinsaakh handwriting through marked practice and checkpoint assessments.'
  WHEN kt.`code` = 'tehseen_al_khat' THEN 'Refine Tehseen Al Khat through marked practice and checkpoint assessments.'
  WHEN kt.`code` = 'istinsaakh_normal_pen' THEN 'Develop Istinsaakh handwriting with an everyday pen through marked practice and checkpoint assessments.'
  WHEN kt.`code` = 'tehseen_al_khat_normal_pen' THEN 'Refine Tehseen Al Khat with an everyday pen through marked practice and checkpoint assessments.'
  ELSE c.`description`
END
WHERE kt.`code` IN ('naskh', 'naskh_normal_pen', 'sulus', 'nastaaleeq', 'istinsaakh', 'tehseen_al_khat', 'istinsaakh_normal_pen', 'tehseen_al_khat_normal_pen')
  AND c.`title` <> 'Mashq worksheets — Naskh';

-- Ensure every configured khat type has a dashboard course. Existing courses
-- are retained; missing cut/normal certification and crash paths are created.
SET @admin_user_id = (
  SELECT `id` FROM `users`
  WHERE `role` = 'admin' AND `deleted_at` IS NULL
  ORDER BY `created_at` LIMIT 1
);
SET @naskh_mashq_source_course_id = (
  SELECT `id` FROM `courses`
  WHERE `khat_type_id` = @naskh_khat_type_id AND `category` = 'secondary'
    AND `title` <> 'Mashq worksheets — Naskh'
  ORDER BY `created_at` LIMIT 1
);

INSERT INTO `courses` (`khat_type_id`, `category`, `title`, `description`, `is_deletable`, `created_by`)
SELECT kt.`id`, catalog.`category`, catalog.`title`, catalog.`description`, 0, @admin_user_id
FROM (
  SELECT 'naskh' AS `code`, 'certification' AS `category`, 'Naskh — Cut Pen Certification' AS `title`, 'Naskh handwriting with a cut qalam.' AS `description`
  UNION ALL SELECT 'naskh_normal_pen', 'certification', 'Naskh — Normal Pen Certification', 'Naskh handwriting with an everyday pen.'
  UNION ALL SELECT 'sulus', 'secondary', 'Thuluth — Crash Course', 'A short, focused introduction to Thuluth calligraphy.'
  UNION ALL SELECT 'nastaaleeq', 'secondary', 'Nastaaleeq — Crash Course', 'A short, focused introduction to Nastaaleeq calligraphy.'
) catalog
JOIN `khat_types` kt ON kt.`code` = catalog.`code`
WHERE @admin_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM `courses` existing WHERE existing.`khat_type_id` = kt.`id` AND existing.`category` = catalog.`category`);

-- Copy Naskh's authored level structure (including media, sheets, checkpoint
-- positions and badge tiers) to otherwise-empty certification/crash courses.
INSERT INTO `levels` (`id`, `course_id`, `order_index`, `level_type`, `title`, `media`, `sheet_files`, `badge_tier`)
SELECT UUID(), target.`id`, source_level.`order_index`, source_level.`level_type`, source_level.`title`, source_level.`media`, source_level.`sheet_files`, source_level.`badge_tier`
FROM `courses` source_course
JOIN `khat_types` source_type ON source_type.`id` = source_course.`khat_type_id` AND source_type.`code` = 'naskh'
JOIN `levels` source_level ON source_level.`course_id` = source_course.`id`
JOIN `courses` target ON target.`id` <> source_course.`id`
JOIN `khat_types` target_type ON target_type.`id` = target.`khat_type_id`
LEFT JOIN `levels` existing ON existing.`course_id` = target.`id` AND existing.`order_index` = source_level.`order_index`
WHERE source_course.`category` = 'certification'
  AND target.`category` IN ('certification', 'secondary')
  AND target_type.`code` <> 'naskh'
  AND existing.`id` IS NULL;

-- Reuse Naskh's existing secondary course and attachments for the new Mashq
-- section, preserving its IDs, enrollments, history, media, and worksheet files.
UPDATE `courses` c
JOIN `khat_types` kt ON kt.`id` = c.`khat_type_id`
SET c.`title` = 'Mashq worksheets — Naskh',
    c.`description` = 'Downloadable Naskh Mashq worksheet sets for independent practice.'
WHERE kt.`code` = 'naskh' AND c.`category` = 'secondary'
  AND c.`id` = @naskh_mashq_source_course_id;

INSERT INTO `courses` (`khat_type_id`, `category`, `title`, `description`, `is_deletable`, `created_by`)
SELECT @naskh_khat_type_id, 'secondary', 'Mashq worksheets — Naskh',
       'Downloadable Naskh Mashq worksheet sets for independent practice.', 0, @admin_user_id
WHERE @naskh_khat_type_id IS NOT NULL AND @admin_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `courses`
    WHERE `khat_type_id` = @naskh_khat_type_id AND `category` = 'secondary'
      AND `title` = 'Mashq worksheets — Naskh'
  );

-- When the former secondary course is migrated to Mashq, keep old level-based
-- submission/entry history attached but reset those levels into worksheet set
-- names instead of showing them as leftover crash-course lessons.
SET @naskh_mashq_course_id = (
  SELECT `id` FROM `courses`
  WHERE `khat_type_id` = @naskh_khat_type_id AND `category` = 'secondary'
    AND `title` = 'Mashq worksheets — Naskh'
  ORDER BY `created_at` LIMIT 1
);
UPDATE `levels` l
JOIN `courses` c ON c.`id` = l.`course_id`
SET l.`title` = CASE l.`order_index`
  WHEN 0 THEN 'Al-Qasāʾid al-Sharīfa worksheets'
  WHEN 1 THEN 'Munājāt Sharīfa worksheets'
  WHEN 2 THEN 'Rawḍat al-Hidāyāt worksheets'
  ELSE CONCAT('Mashq worksheet set ', l.`order_index` + 1)
END
WHERE c.`id` = @naskh_mashq_course_id;

-- Clarify the first worksheet set labels while retaining all original lesson
-- media and printable worksheet assets. Remaining sets keep their existing names.
UPDATE `levels` l
JOIN `courses` c ON c.`id` = l.`course_id`
JOIN `khat_types` kt ON kt.`id` = c.`khat_type_id`
SET l.`title` = CASE l.`order_index`
  WHEN 0 THEN 'Al-Qasāʾid al-Sharīfa worksheets'
  WHEN 1 THEN 'Munājāt Sharīfa worksheets'
  WHEN 2 THEN 'Rawḍat al-Hidāyāt worksheets'
  ELSE CONCAT('Mashq worksheet set ', l.`order_index` + 1)
END
WHERE kt.`code` = 'naskh' AND c.`category` = 'secondary'
  AND c.`title` = 'Mashq worksheets — Naskh';

-- Correct persisted entry kinds for any existing checkpoint levels in courses
-- that were previously treated as mark-only secondary content.
UPDATE `entries` e
JOIN `levels` l ON l.`id` = e.`level_id`
SET e.`entry_kind` = 'checkpoint_assessment'
WHERE e.`source_type` = 'checkpoint' AND l.`level_type` = 'test';

COMMIT;
