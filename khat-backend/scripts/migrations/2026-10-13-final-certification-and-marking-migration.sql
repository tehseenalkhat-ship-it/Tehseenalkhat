-- Final Neon/Postgres migration for the revised course catalog and marking flow.
-- Compatible with Neon PostgreSQL.

BEGIN;

ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS mark_out_of_ten SMALLINT,
  ADD COLUMN IF NOT EXISTS mark_passed BOOLEAN;

INSERT INTO khat_types (code, display_name)
VALUES
  ('naskh', 'Naskh'),
  ('sulus', 'Sulus (Thuluth)'),
  ('nastaaleeq', 'Nastaaleeq'),
  ('istinsaakh', 'Istinsaakh'),
  ('tehseen_al_khat', 'Tehseen Al Khat'),
  ('naskh_normal_pen', 'Tehseen Al Khat (Normal Pen)'),
  ('istinsaakh_normal_pen', 'Istinsaakh (Normal Pen)'),
  ('tehseen_al_khat_normal_pen', 'Tehseen Al Khat (Normal Pen)')
ON CONFLICT (code) DO UPDATE
SET display_name = EXCLUDED.display_name;

WITH admin_user AS (
  SELECT id
  FROM users
  WHERE role = 'admin' AND deleted_at IS NULL
  ORDER BY created_at
  LIMIT 1
)
INSERT INTO courses (khat_type_id, category, title, description, is_deletable, created_by)
SELECT kt.id, 'certification', course_data.title, course_data.description, true, au.id
FROM (
  VALUES
    ('naskh', 'Naskh certification course', 'The cut-pen Naskh certification path.'),
    ('sulus', 'Sulus (Thuluth) certification course', 'The cut-pen Sulus (Thuluth) certification path.'),
    ('nastaaleeq', 'Nastaaleeq certification course', 'The cut-pen Nastaaleeq certification path.'),
    ('istinsaakh', 'Istinsaakh certification course', 'The cut-pen Istinsaakh certification path.'),
    ('tehseen_al_khat', 'Tehseen Al Khat certification course', 'The cut-pen Tehseen Al Khat certification path.'),
    ('naskh_normal_pen', 'Tehseen Al Khat normal pen certification course', 'The normal-pen Tehseen Al Khat certification path.'),
    ('istinsaakh_normal_pen', 'Istinsaakh normal pen certification course', 'The normal-pen Istinsaakh certification path.'),
    ('tehseen_al_khat_normal_pen', 'Tehseen Al Khat normal pen certification course', 'The normal-pen Tehseen Al Khat certification path.')
) AS course_data(khat_type_code, title, description)
JOIN khat_types kt ON kt.code = course_data.khat_type_code
LEFT JOIN admin_user au ON true
WHERE au.id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM courses existing
    WHERE existing.khat_type_id = kt.id
      AND existing.category = 'certification'
  );

COMMIT;
