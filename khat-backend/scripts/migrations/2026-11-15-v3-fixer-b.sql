-- v3 audit fixes (fixer B). Re-runnable.
-- 17: announcements/surveys appear as a slim banner by default; the admin may choose a pop-up.
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS site_style VARCHAR(12) NOT NULL DEFAULT 'banner';
