-- v3 admin-comms: announcements & surveys, editable email templates, email queue,
-- JHS branch student roster, per-user "last seen" markers.
-- One change per statement; every statement is safe to run again.

CREATE TABLE IF NOT EXISTS announcements (
  id char(36) NOT NULL DEFAULT uuid(),
  kind varchar(16) NOT NULL DEFAULT 'announcement',          -- announcement | survey
  title varchar(200) NOT NULL,
  body longtext NOT NULL,
  branch_id char(36) DEFAULT NULL,                            -- NULL = every branch (master only)
  show_on_site tinyint(1) NOT NULL DEFAULT 1,                 -- banner when someone opens the site
  send_email tinyint(1) NOT NULL DEFAULT 0,
  audience varchar(16) NOT NULL DEFAULT 'registered',         -- registered | roster (all branch students, also not signed up)
  include_teachers tinyint(1) NOT NULL DEFAULT 1,
  questions longtext DEFAULT NULL,                            -- survey questions JSON
  status varchar(16) NOT NULL DEFAULT 'draft',                -- draft | published | closed
  ends_at datetime(6) DEFAULT NULL,
  created_by char(36) DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT current_timestamp(6),
  updated_at datetime(6) NOT NULL DEFAULT current_timestamp(6),
  published_at datetime(6) DEFAULT NULL,
  emails_queued int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_announcements_status (status, branch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS announcement_seen (
  announcement_id char(36) NOT NULL,
  user_id char(36) NOT NULL,
  seen_at datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (announcement_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS survey_responses (
  id char(36) NOT NULL DEFAULT uuid(),
  announcement_id char(36) NOT NULL,
  user_id char(36) NOT NULL,
  answers longtext NOT NULL,
  created_at datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_survey_response (announcement_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_templates (
  template_key varchar(40) NOT NULL,
  subject varchar(300) NOT NULL,
  body longtext NOT NULL,
  updated_by char(36) DEFAULT NULL,
  updated_at datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (template_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_queue (
  id char(36) NOT NULL DEFAULT uuid(),
  to_email varchar(320) NOT NULL,
  template_key varchar(40) NOT NULL,
  subject varchar(300) NOT NULL,
  body longtext NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'queued',               -- queued | sent | failed
  attempts int(11) NOT NULL DEFAULT 0,
  last_error varchar(500) DEFAULT NULL,
  ref_type varchar(32) DEFAULT NULL,
  ref_id varchar(64) DEFAULT NULL,
  branch_id char(36) DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT current_timestamp(6),
  sent_at datetime(6) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_email_queue_status (status, created_at),
  KEY idx_email_queue_sent (sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_roster (
  id char(36) NOT NULL DEFAULT uuid(),
  branch_id char(36) NOT NULL,
  tr_number varchar(50) NOT NULL,
  name varchar(200) NOT NULL,
  class_name varchar(100) DEFAULT NULL,
  email varchar(320) DEFAULT NULL,
  source varchar(16) NOT NULL DEFAULT 'upload',               -- upload | api
  imported_by char(36) DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT current_timestamp(6),
  updated_at datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_roster_tr (branch_id, tr_number),
  KEY idx_roster_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_markers (
  user_id char(36) NOT NULL,
  marker_key varchar(64) NOT NULL,
  marked_at datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (user_id, marker_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
