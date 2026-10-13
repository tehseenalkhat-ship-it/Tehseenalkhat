-- Add two cut-pen certification courses and one new normal-pen certification course.
-- The existing normal-pen Naskh track is renamed to Tehseen Al Khat without changing
-- its khat type ID, enrollments, teacher assignments, or student history.

INSERT INTO khat_types (code, display_name)
VALUES
  ('istinsaakh', 'Istinsaakh'),
  ('tehseen_al_khat', 'Tehseen Al Khat'),
  ('istinsaakh_normal_pen', 'Istinsaakh · Normal Pen')
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name);

UPDATE khat_types
SET display_name = 'Tehseen Al Khat'
WHERE code = 'naskh_normal_pen';

UPDATE courses c
JOIN khat_types kt ON kt.id = c.khat_type_id
SET c.title = 'Tehseen Al Khat',
    c.description = 'The Tehseen Al Khat certification path, practised with the ordinary pen.'
WHERE kt.code = 'naskh_normal_pen'
  AND c.category = 'certification';

-- Keep routing operational: duplicate cut-pen Naskh assignments to the two
-- new cut-pen identities, and ordinary-pen Naskh assignments to normal-pen
-- Istinsaakh. Administrators can adjust these assignments afterward.
INSERT IGNORE INTO teacher_khat_assignments (teacher_id, khat_type_id)
SELECT source.teacher_id, target.id
FROM teacher_khat_assignments source
JOIN khat_types source_type ON source_type.id = source.khat_type_id
JOIN khat_types target ON target.code IN ('istinsaakh', 'tehseen_al_khat')
WHERE source_type.code = 'naskh';

INSERT IGNORE INTO teacher_khat_assignments (teacher_id, khat_type_id)
SELECT source.teacher_id, target.id
FROM teacher_khat_assignments source
JOIN khat_types source_type ON source_type.id = source.khat_type_id
JOIN khat_types target ON target.code = 'istinsaakh_normal_pen'
WHERE source_type.code = 'naskh_normal_pen';

INSERT INTO courses (khat_type_id, category, title, description, is_deletable, created_by)
SELECT kt.id, 'certification', course_data.title, course_data.description, 0, admin.id
FROM (
  SELECT 'istinsaakh' AS khat_type_code, 'Istinsaakh' AS title, 'The cut-pen Istinsaakh certification path.' AS description
  UNION ALL SELECT 'tehseen_al_khat', 'Tehseen Al Khat', 'The cut-pen Tehseen Al Khat certification path.'
  UNION ALL SELECT 'istinsaakh_normal_pen', 'Istinsaakh', 'The Istinsaakh certification path, practised with the ordinary pen.'
) AS course_data
JOIN khat_types kt ON kt.code = course_data.khat_type_code
JOIN (SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY created_at LIMIT 1) AS admin
WHERE NOT EXISTS (
  SELECT 1 FROM courses existing
  WHERE existing.khat_type_id = kt.id AND existing.category = 'certification'
);
