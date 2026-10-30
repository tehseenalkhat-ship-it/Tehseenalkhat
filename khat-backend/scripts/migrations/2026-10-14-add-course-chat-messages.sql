CREATE TABLE IF NOT EXISTS course_chat_messages (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  student_id CHAR(36) NOT NULL,
  course_id CHAR(36) NOT NULL,
  sender_id CHAR(36) NOT NULL,
  message_type VARCHAR(16) NOT NULL,
  content LONGTEXT,
  storage_key LONGTEXT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE INDEX course_chat_message_id_uq (id),
  INDEX idx_course_chat_thread_created (student_id, course_id, created_at),
  CONSTRAINT course_chat_messages_type_check CHECK (message_type IN ('text', 'voice'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;