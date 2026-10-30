-- Course journey support and explicit teacher review categories.
-- Timeline items are derived from existing enrollments, level_submissions, and entries.
-- New teacher-marked practice is stored as entries so assignment and review stay canonical.

BEGIN;

ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS entry_kind text,
  ADD COLUMN IF NOT EXISTS time_spent_minutes integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entries_entry_kind_check'
  ) THEN
    ALTER TABLE entries
      ADD CONSTRAINT entries_entry_kind_check
      CHECK (entry_kind IS NULL OR entry_kind IN ('practice_marking', 'checkpoint_assessment', 'secondary_marking'));
  END IF;
END $$;

UPDATE entries e
SET entry_kind = CASE
  WHEN c.category = 'secondary' THEN 'secondary_marking'
  WHEN l.level_type = 'test' THEN 'checkpoint_assessment'
  ELSE 'practice_marking'
END
FROM levels l
JOIN courses c ON c.id = l.course_id
WHERE e.level_id = l.id
  AND e.source_type = 'checkpoint'
  AND e.entry_kind IS NULL;

CREATE INDEX IF NOT EXISTS idx_entries_student_level_created
  ON entries (student_id, level_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_course_review_queue
  ON entries (assigned_teacher_id, status, entry_kind, created_at);
CREATE INDEX IF NOT EXISTS idx_level_submissions_student_level_date
  ON level_submissions (student_id, level_id, submitted_at DESC);

COMMIT;
