-- v3 chat: one "Chat with Funun al-Quran Department" conversation per student.
-- Staff of the student's branch (teachers, branch admins) answer; master admins see every branch.
-- Re-runnable: CREATE ... IF NOT EXISTS only.
CREATE TABLE IF NOT EXISTS dept_messages (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  student_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  branch_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  sender_id char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  sender_role varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  kind varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  body longtext COLLATE utf8mb4_unicode_ci,
  attachments json DEFAULT NULL,
  meta json DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  student_read_at datetime(6) DEFAULT NULL,
  staff_read_at datetime(6) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_dept_messages_student (student_id, created_at),
  KEY idx_dept_messages_branch (branch_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
