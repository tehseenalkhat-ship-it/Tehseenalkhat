-- Add a separate certification identity for Naskh practiced with an ordinary pen.
-- The course uses the existing certification/enrollment/checkpoint/badge engine.
-- After running this migration, use Admin > Course Builder > Naskh (Normal Pen)
-- to author the actual lesson and checkpoint curriculum before opening enrollment.
BEGIN;

DO $$
DECLARE
  normal_pen_khat_type_id UUID;
  admin_user_id UUID;
BEGIN
  SELECT id INTO normal_pen_khat_type_id
  FROM khat_types
  WHERE code = 'naskh_normal_pen'
  LIMIT 1;

  IF normal_pen_khat_type_id IS NULL THEN
    INSERT INTO khat_types (code, display_name)
    VALUES ('naskh_normal_pen', 'Naskh (Normal Pen)')
    RETURNING id INTO normal_pen_khat_type_id;
  ELSE
    UPDATE khat_types
    SET display_name = 'Naskh (Normal Pen)'
    WHERE id = normal_pen_khat_type_id;
  END IF;

  SELECT id INTO admin_user_id
  FROM users
  WHERE role = 'admin' AND deleted_at IS NULL
  ORDER BY created_at
  LIMIT 1;

  IF admin_user_id IS NULL THEN
    RAISE EXCEPTION 'Create an active admin account before adding the Naskh normal-pen certification course.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM courses
    WHERE khat_type_id = normal_pen_khat_type_id AND category = 'certification'
  ) THEN
    INSERT INTO courses (khat_type_id, category, title, description, is_deletable, created_by)
    VALUES (
      normal_pen_khat_type_id,
      'certification',
      'Naskh with the normal pen',
      'A separate Naskh certification path for practice with an ordinary pen rather than a cut qalam.',
      false,
      admin_user_id
    );
  END IF;
END $$;

COMMIT;
