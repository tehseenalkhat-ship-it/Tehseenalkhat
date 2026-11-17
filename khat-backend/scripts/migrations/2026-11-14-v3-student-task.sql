-- v3 student-task: Mashq / crash courses need ONE final upload step so the student can
-- "upload all sheets as one PDF for assessment & remarks" (owner note 2.9).
-- course_types.final_submission = 1 says such a step belongs at the end, but courses built
-- from files only (worksheets) never got one. Adds it to the last level of every v2 course
-- whose type asks for it and that has no final_submission step yet. Re-runnable (NOT EXISTS).
INSERT INTO level_steps (id, level_id, course_id, code, order_index, title, step_type, message, max_marks, status, source, created_at)
SELECT UUID(), l.id, c.id, 'FS', 999, 'Send all your sheets for assessment', 'final_submission', NULL, 10, 'published', 'manual', NOW(6)
  FROM courses c
  JOIN course_types ct ON ct.type_key = c.course_type AND ct.final_submission = 1
  JOIN levels l ON l.course_id = c.id
                AND l.order_index = (SELECT MAX(l2.order_index) FROM levels l2 WHERE l2.course_id = c.id)
 WHERE c.structure_version = 2
   AND NOT EXISTS (SELECT 1 FROM level_steps s WHERE s.course_id = c.id AND s.step_type = 'final_submission')
   AND NOT EXISTS (SELECT 1 FROM level_steps s WHERE s.level_id = l.id AND s.code = 'FS');
