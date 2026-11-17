-- Tehseen al-Khat v2: manifest-driven course builder, branch autonomy, step threads,
-- annotations with voice pins, level badges, merit points, competitions/calls.
-- MySQL 8 / TiDB compatible. One change per statement so TiDB applies it safely.
-- Existing courses keep working: structure_version stays 1 for them.

-- ---------- Users & branches ----------
ALTER TABLE users ADD COLUMN admin_scope varchar(16) NOT NULL DEFAULT 'master';
ALTER TABLE users ADD COLUMN class_name varchar(100) DEFAULT NULL;
ALTER TABLE users ADD COLUMN mistar_size varchar(8) DEFAULT NULL;
ALTER TABLE branches ADD COLUMN code varchar(32) DEFAULT NULL;

-- ---------- Courses ----------
ALTER TABLE courses DROP INDEX uq_one_certification_course_per_khat_type;
ALTER TABLE courses ADD COLUMN code varchar(32) DEFAULT NULL;
ALTER TABLE courses ADD UNIQUE INDEX uq_courses_code (code);
ALTER TABLE courses ADD COLUMN structure_version tinyint NOT NULL DEFAULT 1;
ALTER TABLE courses ADD COLUMN pen_type varchar(32) DEFAULT NULL;
ALTER TABLE courses ADD COLUMN course_type varchar(32) DEFAULT NULL;
ALTER TABLE courses ADD COLUMN title_ar longtext DEFAULT NULL;
ALTER TABLE courses ADD COLUMN status varchar(16) NOT NULL DEFAULT 'published';
ALTER TABLE courses ADD COLUMN mistar_sizes json DEFAULT NULL;
ALTER TABLE courses ADD COLUMN drive_folder_url longtext DEFAULT NULL;
ALTER TABLE courses ADD COLUMN master_row json DEFAULT NULL;
ALTER TABLE courses ADD COLUMN instructions longtext DEFAULT NULL;
ALTER TABLE courses ADD COLUMN updated_at datetime(6) DEFAULT NULL;

CREATE TABLE IF NOT EXISTS course_branches (
  course_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  branch_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (course_id, branch_id),
  KEY idx_course_branches_branch (branch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- Levels ----------
ALTER TABLE levels ADD COLUMN code varchar(16) DEFAULT NULL;
ALTER TABLE levels ADD COLUMN description longtext DEFAULT NULL;
ALTER TABLE levels ADD COLUMN instructions longtext DEFAULT NULL;
ALTER TABLE levels ADD COLUMN status varchar(16) NOT NULL DEFAULT 'published';
ALTER TABLE levels ADD COLUMN badge_code varchar(64) DEFAULT NULL;
ALTER TABLE levels ADD COLUMN updated_at datetime(6) DEFAULT NULL;

-- ---------- Logic sets (drop-downs) ----------
CREATE TABLE IF NOT EXISTS step_types (
  type_key varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  label varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  file_codes json NOT NULL,
  student_action varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  feedback_mode varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  has_marks tinyint(1) NOT NULL DEFAULT '0',
  gates_progress tinyint(1) NOT NULL DEFAULT '0',
  awards_badge tinyint(1) NOT NULL DEFAULT '0',
  requires_prior_uploads tinyint(1) NOT NULL DEFAULT '0',
  default_instructions longtext COLLATE utf8mb4_unicode_ci,
  sort_order int NOT NULL DEFAULT '0',
  is_system tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (type_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO step_types (type_key, label, file_codes, student_action, feedback_mode, has_marks, gates_progress, awards_badge, requires_prior_uploads, default_instructions, sort_order, is_system) VALUES
('worksheet', 'Worksheet', '["MT","PW","WS","HF"]', 'watch_download', 'none', 0, 0, 0, 0, '1. Watch the video.\n2. Look at the reference image.\n3. Download and print the worksheet for your mistar size.\n4. Practise the worksheet, keep it safe for the level assessment, then press "Mark as done".', 10, 1),
('kitabat', 'Kitabat', '["KT"]', 'watch_download', 'none', 0, 0, 0, 0, 'Download the page, write it out carefully and press "Mark as done".', 20, 1),
('raudat_hidayaat', 'Raudat Hidayaat', '["RH"]', 'watch_download', 'none', 0, 0, 0, 0, 'Download the Raudat Hidayaat page, write it out and press "Mark as done".', 30, 1),
('resource', 'Resource', '["RS"]', 'watch_download', 'none', 0, 0, 0, 0, 'Download and practise this sheet.', 40, 1),
('mashq', 'Mashq sheet', '["MS"]', 'watch_download', 'none', 0, 0, 0, 0, 'Download, print and practise this Mashq sheet.', 50, 1),
('istinsakh', 'Istinsakh', '["IS"]', 'upload', 'feedback', 0, 0, 0, 0, 'Upload one page of your Istinsakh here. Your teacher will reply in this chat.', 60, 1),
('assessment', 'Level assessment', '["AW","AS"]', 'download_upload', 'annotate_mark', 1, 1, 1, 1, '1. Download the assessment sheet and write it once, carefully.\n2. Upload the worksheets of every step of this level and the finished assessment sheet.\n3. Your teacher marks the assessment sheet out of 10 and replies here.', 70, 1),
('final_submission', 'Final submission', '["FS"]', 'upload', 'annotate_mark', 1, 0, 1, 0, 'Upload your final work here (photos or one PDF). Your teacher marks it and replies here.', 80, 1);

CREATE TABLE IF NOT EXISTS course_types (
  type_key varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  label varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  allowed_step_types json NOT NULL,
  has_levels tinyint(1) NOT NULL DEFAULT '1',
  final_submission tinyint(1) NOT NULL DEFAULT '0',
  sort_order int NOT NULL DEFAULT '0',
  PRIMARY KEY (type_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO course_types (type_key, label, allowed_step_types, has_levels, final_submission, sort_order) VALUES
('certification', 'Certification', '["worksheet","kitabat","raudat_hidayaat","istinsakh","assessment"]', 1, 0, 10),
('crash', 'Crash course', '["worksheet","resource","final_submission"]', 0, 1, 20),
('mashq', 'Mashq worksheets', '["mashq","worksheet","final_submission"]', 0, 1, 30);

CREATE TABLE IF NOT EXISTS file_codes (
  file_code varchar(8) COLLATE utf8mb4_unicode_ci NOT NULL,
  step_type varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  file_role varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL,
  label varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (file_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO file_codes (file_code, step_type, file_role, label) VALUES
('MT', 'worksheet', 'worksheet', 'Mufradaat worksheet'),
('PW', 'worksheet', 'worksheet', 'Practice worksheet'),
('WS', 'worksheet', 'worksheet', 'Worksheet'),
('HF', 'worksheet', 'worksheet', 'Harf sheet'),
('KT', 'kitabat', 'worksheet', 'Kitabat page'),
('RH', 'raudat_hidayaat', 'worksheet', 'Raudat Hidayaat page'),
('RS', 'resource', 'resource', 'Resource'),
('MS', 'mashq', 'worksheet', 'Mashq sheet'),
('IS', 'istinsakh', 'reference', 'Istinsakh guide'),
('AW', 'assessment', 'assessment_sheet', 'Assessment sheet'),
('AS', 'assessment', 'assessment_sheet', 'Assessment sheet'),
('FS', 'final_submission', 'reference', 'Final submission brief'),
('VD', '', 'video', 'Video'),
('RF', '', 'reference', 'Reference image');
-- VD / RF have no step_type: they attach to an existing (or new, default worksheet) step.

-- ---------- Steps + files ----------
CREATE TABLE IF NOT EXISTS level_steps (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (uuid()),
  level_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  course_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  code varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  order_index int NOT NULL DEFAULT '0',
  title longtext COLLATE utf8mb4_unicode_ci,
  step_type varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'worksheet',
  template varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  message longtext COLLATE utf8mb4_unicode_ci,
  max_marks int DEFAULT NULL,
  badge_code varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  status varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'published',
  source varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at datetime(6) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_level_steps_code (level_id, code),
  KEY idx_level_steps_course (course_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS step_files (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (uuid()),
  step_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  course_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  role varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL,
  size_code varchar(8) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  page varchar(8) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'P01',
  version int NOT NULL DEFAULT '1',
  is_current tinyint(1) NOT NULL DEFAULT '1',
  storage_key longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  original_filename longtext COLLATE utf8mb4_unicode_ci,
  canonical_name varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  content_type varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  byte_size bigint DEFAULT NULL,
  source varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'upload',
  drive_file_id varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  uploaded_by char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  uploaded_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_step_files_step (step_id, role, size_code, page, is_current),
  KEY idx_step_files_course (course_id),
  KEY idx_step_files_drive (drive_file_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Download steps the student marked as done (no submission)
CREATE TABLE IF NOT EXISTS step_progress (
  student_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  step_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  done_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (student_id, step_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- Policies ----------
-- branch_id '' = global (master) row. locked applies to global rows only.
CREATE TABLE IF NOT EXISTS policy_settings (
  branch_id varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  policy_key varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  value json NOT NULL,
  locked tinyint(1) NOT NULL DEFAULT '0',
  updated_by char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  updated_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (branch_id, policy_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- Submissions, threads, annotations ----------
CREATE TABLE IF NOT EXISTS step_submissions (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (uuid()),
  student_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  branch_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  course_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  level_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  step_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  attempt_no int NOT NULL DEFAULT '1',
  status varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'submitted',
  mark smallint DEFAULT NULL,
  band varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  rubric json DEFAULT NULL,
  files json NOT NULL,
  claimed_by char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  claimed_at datetime(6) DEFAULT NULL,
  reviewed_by char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  reviewed_at datetime(6) DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_step_submissions_student_step (student_id, step_id, attempt_no),
  KEY idx_step_submissions_inbox (branch_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS thread_messages (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (uuid()),
  student_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  step_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  course_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  branch_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  sender_id char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  sender_role varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  kind varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  body longtext COLLATE utf8mb4_unicode_ci,
  attachments json DEFAULT NULL,
  submission_id char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  annotation_id char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  meta json DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  student_read_at datetime(6) DEFAULT NULL,
  staff_read_at datetime(6) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_thread_messages_thread (student_id, step_id, created_at),
  KEY idx_thread_messages_branch (branch_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS annotations (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (uuid()),
  submission_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  file_storage_key varchar(512) COLLATE utf8mb4_unicode_ci NOT NULL,
  page_index int NOT NULL DEFAULT '0',
  strokes json NOT NULL,
  pins json NOT NULL,
  flattened_storage_key longtext COLLATE utf8mb4_unicode_ci,
  created_by char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_annotations_file (submission_id, file_storage_key(191), page_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- Badges + merit ----------
CREATE TABLE IF NOT EXISTS student_badges (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (uuid()),
  student_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  badge_code varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  kind varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  course_id char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  level_id char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  submission_id char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  label varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  awarded_by char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  awarded_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_student_badges (student_id, badge_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS merit_ledger (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (uuid()),
  student_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  branch_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  source varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL,
  source_ref varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  source_label varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  points int NOT NULL,
  earned_month char(7) COLLATE utf8mb4_unicode_ci NOT NULL,
  status varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  given_by char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  given_at datetime(6) DEFAULT NULL,
  note longtext COLLATE utf8mb4_unicode_ci,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_merit_source (student_id, source, source_ref),
  KEY idx_merit_month (branch_id, earned_month, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- Audit (change history + undo) ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (uuid()),
  actor_id char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  branch_id char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  action varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  entity_type varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  entity_id varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  summary longtext COLLATE utf8mb4_unicode_ci,
  before_json json DEFAULT NULL,
  after_json json DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  undone_at datetime(6) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_audit_entity (entity_type, entity_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- Competitions / calls / showcase ----------
ALTER TABLE competitions ADD COLUMN kind varchar(16) NOT NULL DEFAULT 'competition';
ALTER TABLE competitions ADD COLUMN branch_ids json DEFAULT NULL;
ALTER TABLE competitions ADD COLUMN excerpts json DEFAULT NULL;
ALTER TABLE competitions ADD COLUMN cover_storage_key longtext DEFAULT NULL;
ALTER TABLE competition_entries ADD COLUMN selection_label varchar(64) DEFAULT NULL;
ALTER TABLE competition_entries ADD COLUMN selection_rank int DEFAULT NULL;
ALTER TABLE showcase_posts ADD COLUMN source varchar(24) DEFAULT NULL;
ALTER TABLE showcase_posts ADD COLUMN competition_id char(36) DEFAULT NULL;
ALTER TABLE showcase_posts ADD COLUMN award_label varchar(64) DEFAULT NULL;
ALTER TABLE showcase_posts ADD COLUMN submission_id char(36) DEFAULT NULL;
ALTER TABLE showcase_posts ADD COLUMN branch_id char(36) DEFAULT NULL;

-- ---------- Insights nudges + communities ----------
CREATE TABLE IF NOT EXISTS student_nudges (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (uuid()),
  student_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  sent_by char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  kind varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  message longtext COLLATE utf8mb4_unicode_ci,
  emailed tinyint(1) NOT NULL DEFAULT '0',
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_student_nudges_student (student_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_groups (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (uuid()),
  name varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  purpose longtext COLLATE utf8mb4_unicode_ci,
  branch_id char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  created_by char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  archived_at datetime(6) DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_group_members (
  group_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  user_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  member_role varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'member',
  added_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (group_id, user_id),
  KEY idx_group_members_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS group_messages (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (uuid()),
  group_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  sender_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  body longtext COLLATE utf8mb4_unicode_ci,
  attachments json DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_group_messages_group (group_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Submissions: SLA + print code bookkeeping
ALTER TABLE step_submissions ADD COLUMN print_code varchar(16) DEFAULT NULL;
ALTER TABLE step_submissions ADD UNIQUE INDEX uq_step_submissions_print_code (print_code);
ALTER TABLE step_submissions ADD COLUMN auto_marked tinyint(1) NOT NULL DEFAULT '0';
ALTER TABLE step_submissions ADD COLUMN diverted_count int NOT NULL DEFAULT '0';
ALTER TABLE step_submissions ADD COLUMN assigned_teacher_id char(36) DEFAULT NULL;
ALTER TABLE step_submissions ADD COLUMN assigned_at datetime(6) DEFAULT NULL;
ALTER TABLE step_submissions ADD COLUMN first_response_at datetime(6) DEFAULT NULL;

-- ---------- Teacher workload: checking threshold + spill-over network ----------
-- users.entry_load_threshold (existing column) = how many open items a teacher holds at once.
ALTER TABLE users ADD COLUMN review_away_until datetime(6) DEFAULT NULL;
CREATE TABLE IF NOT EXISTS reviewer_spillover (
  teacher_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  target_teacher_id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  priority int NOT NULL DEFAULT '1',
  created_by char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (teacher_id, target_teacher_id),
  KEY idx_reviewer_spillover_target (target_teacher_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Teachers still on the old column default (5 open items) move to the new default limit of 15,
-- matching the small-team reality (2 teachers ≈ 700 students). Explicitly chosen values stay.
ALTER TABLE users ALTER COLUMN entry_load_threshold SET DEFAULT 15;
UPDATE users SET entry_load_threshold = 15 WHERE role = 'teacher' AND entry_load_threshold = 5;
