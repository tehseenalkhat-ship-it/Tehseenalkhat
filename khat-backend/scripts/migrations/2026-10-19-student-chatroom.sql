-- Student course chatroom and private student-to-teacher conversations.
-- MySQL 8.0+. Course chat messages remain keyed by student/course; direct chats
-- are one-to-one and record read state on each message.

ALTER TABLE `course_chat_messages`
  ADD COLUMN IF NOT EXISTS `student_read_at` DATETIME(6) NULL;

CREATE TABLE IF NOT EXISTS `course_chat_read_state` (
  `student_id` CHAR(36) NOT NULL,
  `course_id` CHAR(36) NOT NULL,
  `last_read_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`student_id`, `course_id`),
  INDEX `idx_course_chat_reads_course` (`course_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `direct_chat_messages` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `student_id` CHAR(36) NOT NULL,
  `teacher_id` CHAR(36) NOT NULL,
  `sender_id` CHAR(36) NOT NULL,
  `message_type` VARCHAR(16) NOT NULL,
  `content` LONGTEXT NULL,
  `storage_key` LONGTEXT NULL,
  `read_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE INDEX `direct_chat_message_id_uq` (`id`),
  INDEX `idx_direct_chat_pair_created` (`student_id`, `teacher_id`, `created_at`),
  INDEX `idx_direct_chat_recipient_read` (`teacher_id`, `read_at`, `created_at`),
  CONSTRAINT `direct_chat_messages_type_check` CHECK (`message_type` IN ('text', 'voice'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
