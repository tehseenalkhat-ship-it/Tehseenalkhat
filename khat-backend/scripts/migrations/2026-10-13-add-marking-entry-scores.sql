-- Normal course submissions and checkpoint tests now receive a teacher score out of 10.
-- Apply once to the MariaDB database before deploying the matching backend.
ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS score SMALLINT NULL;
