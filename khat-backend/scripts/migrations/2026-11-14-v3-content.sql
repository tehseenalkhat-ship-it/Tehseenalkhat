-- v3 content (owner notes 1.9, 1.10, 4.2, 4.5, 4.6, 4.7 + curriculum audit).
-- Re-runnable with: npm run migrate:v2 -- 2026-11-14-v3-content.sql  (duplicate column / table errors are skipped)

-- Gallery = reference work by calligraphers, uploaded by admins / faculty only (note 1.9).
-- branch_id NULL = shown to every branch (master team only); otherwise one branch.
CREATE TABLE IF NOT EXISTS gallery_works (
  id char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  title varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  calligrapher varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  script varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  note text COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  image_storage_key varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  branch_id char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  status varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'visible',
  uploaded_by char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_gallery_works_branch (branch_id),
  KEY idx_gallery_works_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Showcase: the reflection question the student answered + time taken (shown as effort) (note 4.7).
ALTER TABLE showcase_posts ADD COLUMN reflection_question varchar(255) DEFAULT NULL;
ALTER TABLE showcase_posts ADD COLUMN time_minutes int DEFAULT NULL;

-- Events: recordings are YouTube links played on the site (note 4.5).
ALTER TABLE live_events ADD COLUMN recording_youtube_url varchar(500) DEFAULT NULL;

-- Resources: books with author / language / description for the filter (note 4.6).
ALTER TABLE books ADD COLUMN author varchar(255) DEFAULT NULL;
ALTER TABLE books ADD COLUMN language varchar(32) DEFAULT NULL;
ALTER TABLE books ADD COLUMN description text DEFAULT NULL;

-- Note 1.10: "Selected for decoration" is no longer used; it becomes "Selected".
UPDATE competition_entries SET selection_label = 'Selected' WHERE selection_label = 'Selected for decoration';
UPDATE showcase_posts SET award_label = 'Selected' WHERE award_label = 'Selected for decoration';
UPDATE showcase_posts SET caption = TRIM(SUBSTRING(caption, 27)) WHERE caption LIKE 'Selected for decoration — %';
UPDATE student_badges SET label = CONCAT('Selected', SUBSTRING(label, 24)) WHERE label LIKE 'Selected for decoration%';

-- Curriculum audit: spelling "Istinsakh" (not "Instinsakh").
UPDATE courses SET title = REPLACE(title, 'Instinsakh', 'Istinsakh') WHERE title LIKE '%Instinsakh%';
