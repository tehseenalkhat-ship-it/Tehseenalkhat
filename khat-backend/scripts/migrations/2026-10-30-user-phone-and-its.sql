-- Phone + ITS number on users. The server runs these itself on startup; importing this file is optional.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(32) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS its_number VARCHAR(8) NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_its_number_key ON users (its_number);
