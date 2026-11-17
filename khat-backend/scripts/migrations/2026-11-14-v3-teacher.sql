-- v3 teacher: unique sheet ID on every stamped PDF (student downloads + teacher print packs / bulk downloads).
-- Re-runnable: one change per statement.
CREATE TABLE IF NOT EXISTS sheet_ids (
  sheet_id varchar(16) NOT NULL PRIMARY KEY,
  kind varchar(24) NOT NULL,
  student_id char(36) NOT NULL,
  submission_id char(36) DEFAULT NULL,
  step_file_id char(36) DEFAULT NULL,
  print_code varchar(16) DEFAULT NULL,
  created_by char(36) DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CREATE INDEX IF NOT EXISTS idx_sheet_ids_submission ON sheet_ids (submission_id);
CREATE INDEX IF NOT EXISTS idx_sheet_ids_student ON sheet_ids (student_id, created_at);
-- "Give one more attempt": each row = one extra attempt for a student on a marked step (above assessment.max_attempts).
CREATE TABLE IF NOT EXISTS attempt_grants (
  id char(36) NOT NULL PRIMARY KEY,
  student_id char(36) NOT NULL,
  step_id char(36) NOT NULL,
  granted_by char(36) DEFAULT NULL,
  note varchar(500) DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CREATE INDEX IF NOT EXISTS idx_attempt_grants_student_step ON attempt_grants (student_id, step_id);
