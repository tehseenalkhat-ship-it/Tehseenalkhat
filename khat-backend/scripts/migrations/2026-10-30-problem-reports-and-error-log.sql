-- Report a problem + error log (2026-10-30). Only creates two new tables; existing data is untouched.
-- The server also runs these on startup, so importing this file is optional.

CREATE TABLE IF NOT EXISTS problem_reports (
    id CHAR(36) NOT NULL,
    person_role VARCHAR(20) NOT NULL,
    person_id CHAR(36) NULL,
    name VARCHAR(200) NULL,
    page TEXT NULL,
    text TEXT NOT NULL,
    screenshot VARCHAR(255) NULL,
    browser_info TEXT NULL,
    recent_errors MEDIUMTEXT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    fixed_at DATETIME(6) NULL,
    fix_note TEXT NULL,
    answer VARCHAR(10) NULL,
    answered_at DATETIME(6) NULL,
    reply TEXT NULL,
    reply_shot VARCHAR(255) NULL,
    reporter_token CHAR(64) NULL,
    PRIMARY KEY (id),
    INDEX problem_reports_person (person_id),
    INDEX problem_reports_token (reporter_token),
    INDEX problem_reports_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS error_log (
    id BIGINT NOT NULL AUTO_INCREMENT,
    source VARCHAR(10) NOT NULL,
    message TEXT NOT NULL,
    stack MEDIUMTEXT NULL,
    url TEXT NULL,
    person VARCHAR(255) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    INDEX error_log_created (created_at),
    INDEX error_log_source (source, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
