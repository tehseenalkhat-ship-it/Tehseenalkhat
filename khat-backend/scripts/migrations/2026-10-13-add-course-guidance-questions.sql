-- Adds editable course-choice questions shown on the student dashboard cards.
-- Existing rows receive a sensible starter question; admins can revise it in Course Builder.

BEGIN;

ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS guidance_question text;

UPDATE courses AS c
SET guidance_question = CASE
  WHEN c.category = 'certification' AND kt.code = 'naskh'
    THEN 'Would you like to improve your Naskh handwriting with a cut pen and earn a certificate?'
  WHEN c.category = 'certification' AND kt.code = 'sulus'
    THEN 'Would you like to learn Thuluth calligraphy with a cut pen and earn a certificate?'
  WHEN c.category = 'certification' AND kt.code = 'nastaaleeq'
    THEN 'Would you like to develop your Nastaaleeq handwriting and earn a certificate?'
  WHEN c.category = 'certification' AND kt.code = 'istinsaakh'
    THEN 'Would you like to improve your Istinsaakh handwriting with a cut pen and earn a certificate?'
  WHEN c.category = 'certification' AND kt.code = 'tehseen_al_khat'
    THEN 'Would you like to refine your Tehseen Al Khat with a cut pen and earn a certificate?'
  WHEN c.category = 'certification' AND kt.code = 'naskh_normal_pen'
    THEN 'Would you like to improve your Naskh handwriting with an everyday pen and earn a certificate?'
  WHEN c.category = 'certification' AND kt.code = 'istinsaakh_normal_pen'
    THEN 'Would you like to refine your Istinsaakh handwriting with an everyday pen and earn a certificate?'
  WHEN c.category = 'certification' AND kt.code = 'tehseen_al_khat_normal_pen'
    THEN 'Would you like to polish your Tehseen Al Khat with an everyday pen and earn a certificate?'
  WHEN c.category = 'secondary' AND kt.code = 'naskh'
    THEN 'Would you like to practise Naskh at your own pace with a cut pen?'
  WHEN c.category = 'secondary' AND kt.code = 'naskh_normal_pen'
    THEN 'Would you like to practise Naskh at your own pace with a normal pen?'
  WHEN c.category = 'secondary' AND kt.code = 'sulus'
    THEN 'Would you like to explore Thuluth calligraphy at your own pace?'
  WHEN c.category = 'secondary' AND kt.code = 'nastaaleeq'
    THEN 'Would you like to explore Nastaaleeq calligraphy at your own pace?'
  ELSE 'Would you like to explore this subject at your own pace?'
END
FROM khat_types AS kt
WHERE c.khat_type_id = kt.id
  AND (c.guidance_question IS NULL OR btrim(c.guidance_question) = '');

COMMIT;
