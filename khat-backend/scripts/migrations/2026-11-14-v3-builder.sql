-- v3 builder (owner notes 6.6, 6.11, 1.18): badge designs + chosen design per level/course, Urs is Mashq.
-- Re-runnable with: npm run migrate:v2 -- 2026-11-14-v3-builder.sql  (duplicate column / table errors are skipped)

-- Badge artwork uploaded by the master team. One design can be the default for its kind
-- (level / course / competition); a design with badge_code is used only for that exact badge.
CREATE TABLE IF NOT EXISTS badge_designs (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  name varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  kind varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'level',
  badge_code varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  is_default tinyint(1) NOT NULL DEFAULT 0,
  storage_key varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  content_type varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  note varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  updated_by char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_badge_designs_kind (kind),
  KEY idx_badge_designs_code (badge_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which design a level badge / course badge uses (chosen from the drop-down in the builder).
ALTER TABLE levels ADD COLUMN badge_design_id char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL;

ALTER TABLE courses ADD COLUMN badge_design_id char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL;

-- Curriculum audit: the course badge / certificate is given only when the master team says the
-- course is complete ("Course complete — certificate can be given" switch in the builder).
ALTER TABLE courses ADD COLUMN certification_ready tinyint(1) NOT NULL DEFAULT 0;

-- 6.11 / 2.9: the Urs course is Mashq worksheets, not a crash course.
UPDATE courses SET course_type = 'mashq', updated_at = CURRENT_TIMESTAMP(6)
 WHERE structure_version = 2 AND code LIKE 'URS-%' AND (course_type IS NULL OR course_type <> 'mashq');

UPDATE courses SET title = 'Urs Mashq Worksheets', updated_at = CURRENT_TIMESTAMP(6)
 WHERE structure_version = 2 AND code LIKE 'URS-%' AND title = 'Urs Crash Course';

-- Its sheets are Mashq sheets (they were loaded as "Resource").
UPDATE level_steps SET step_type = 'mashq', updated_at = CURRENT_TIMESTAMP(6)
 WHERE step_type = 'resource' AND course_id IN (SELECT id FROM courses WHERE structure_version = 2 AND code LIKE 'URS-%');

-- A Mashq course ends with ONE upload of all sheets (final submission). Add it where missing.
INSERT INTO level_steps (id, level_id, course_id, code, order_index, title, step_type, status, source, updated_at)
SELECT UUID(), l.id, l.course_id,
       CONCAT('S', LPAD((SELECT COUNT(*) FROM level_steps x WHERE x.level_id = l.id) + 1, 2, '0')),
       (SELECT COUNT(*) FROM level_steps x WHERE x.level_id = l.id),
       'Upload all your sheets for assessment', 'final_submission', 'published', 'manual', CURRENT_TIMESTAMP(6)
  FROM levels l JOIN courses c ON c.id = l.course_id
 WHERE c.structure_version = 2 AND c.code LIKE 'URS-%'
   AND l.order_index = (SELECT MIN(l2.order_index) FROM levels l2 WHERE l2.course_id = c.id)
   AND NOT EXISTS (SELECT 1 FROM level_steps s WHERE s.course_id = c.id AND s.step_type = 'final_submission');

-- 2.9: "Prepared in Nairobi on the basis of …" is not shown to students in any course.
UPDATE courses SET description = NULL, updated_at = CURRENT_TIMESTAMP(6)
 WHERE description LIKE 'Prepared in Nairobi%';

-- Curriculum audit: one spelling everywhere (Istinsakh, Nastaleeq, Thuluth).
UPDATE courses SET title = REPLACE(REPLACE(REPLACE(title, 'Istinsaakh', 'Istinsakh'), 'Instinsakh', 'Istinsakh'), 'Nastaaleeq', 'Nastaleeq')
 WHERE title REGEXP 'Istinsaakh|Instinsakh|Nastaaleeq';

UPDATE khat_types SET display_name = REPLACE(REPLACE(REPLACE(display_name, 'Istinsaakh', 'Istinsakh'), 'Instinsakh', 'Istinsakh'), 'Nastaaleeq', 'Nastaleeq')
 WHERE display_name REGEXP 'Istinsaakh|Instinsakh|Nastaaleeq';

UPDATE khat_types SET display_name = 'Thuluth' WHERE display_name = 'Sulus (Thuluth)';

-- Curriculum audit: the Level-assessment wording students see.
UPDATE step_types SET default_instructions = 'Upload all your practice sheets as one PDF, then download the assessment sheet, fill it and upload it for remarks.'
 WHERE type_key = 'assessment';

-- Curriculum audit: badge names are saved student-friendly ("Fann al-Khat 1 · Level 3 — كلمات"), never "FNK-C101 LV03".
UPDATE student_badges b
  JOIN courses c ON c.id = b.course_id
  JOIN levels l ON l.id = b.level_id
   SET b.label = CONCAT(c.title, ' · Level ', l.order_index + 1, IF(l.description IS NULL OR l.description = '', '', CONCAT(' — ', l.description)))
 WHERE b.kind = 'level' AND b.label REGEXP '^[A-Za-z]{2,5}-[A-Za-z][0-9]{3} LV[0-9]';
