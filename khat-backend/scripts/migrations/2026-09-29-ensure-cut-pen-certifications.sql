-- Ensure the three cut-qalam khat types have their non-deletable certification course records.
-- Existing courses are left untouched; missing khat types and course rows are created.
-- Author lesson/checkpoint content in Admin > Course Builder before student enrollment.
BEGIN;

DO $$
DECLARE
  admin_user_id UUID;
BEGIN
  INSERT INTO khat_types (code, display_name)
  VALUES
    ('naskh', 'Naskh'),
    ('sulus', 'Sulus (Thuluth)'),
    ('nastaaleeq', 'Nastaaleeq')
  ON CONFLICT (code) DO NOTHING;

  SELECT id INTO admin_user_id
  FROM users
  WHERE role = 'admin' AND deleted_at IS NULL
  ORDER BY created_at
  LIMIT 1;

  IF admin_user_id IS NULL THEN
    RAISE EXCEPTION 'Create an active admin account before adding cut-pen certification courses.';
  END IF;

  INSERT INTO courses (khat_type_id, category, title, description, is_deletable, created_by)
  SELECT kt.id, 'certification', course_data.title, course_data.description, false, admin_user_id
  FROM (VALUES
    ('naskh', 'Naskh certification course', 'The cut-qalam Naskh certification path.'),
    ('sulus', 'Sulus (Thuluth) certification course', 'The cut-qalam Sulus (Thuluth) certification path.'),
    ('nastaaleeq', 'Nastaaleeq certification course', 'The cut-qalam Nastaaleeq certification path.')
  ) AS course_data(khat_type_code, title, description)
  JOIN khat_types kt ON kt.code = course_data.khat_type_code
  WHERE NOT EXISTS (
    SELECT 1 FROM courses existing
    WHERE existing.khat_type_id = kt.id AND existing.category = 'certification'
  );
END $$;

COMMIT;
