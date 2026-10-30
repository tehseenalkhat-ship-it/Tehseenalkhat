-- Align the retained normal-pen course labels with the student curriculum.
-- The redundant Tehseen Al Khat normal-pen course remains in the database for
-- historical enrollments and records, but is hidden from student course APIs.
-- MySQL 8.0+; safe to rerun.

START TRANSACTION;

UPDATE `khat_types`
SET `display_name` = 'Naskh (Normal Pen)'
WHERE `code` = 'naskh_normal_pen';

UPDATE `courses` c
JOIN `khat_types` kt ON kt.`id` = c.`khat_type_id`
SET c.`title` = 'Naskh — Normal Pen Certification',
    c.`description` = 'Practise Naskh handwriting with an everyday pen. Regular practice levels are marked; checkpoint tests receive a thorough assessment.'
WHERE kt.`code` = 'naskh_normal_pen'
  AND c.`category` = 'certification';

COMMIT;
