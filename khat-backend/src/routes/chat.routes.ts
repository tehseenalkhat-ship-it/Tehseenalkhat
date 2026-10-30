import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';

type MessageBody = { type: 'text' | 'voice'; content?: string; storageKey?: string; threadKey?: string };

function normalizeThreadKey(value: string | undefined): string | null {
  if (!value || value === 'course') return 'course';
  if (/^level:[0-9a-f-]{36}$/i.test(value)) return value;
  return null;
}

async function canAccessCourseChat(studentId: string, courseId: string, threadKey: string, user: AuthUser): Promise<boolean> {
  const { rows: courseRows } = await pool.query(
    `SELECT category, title FROM courses WHERE id = $1`,
    [courseId]
  );
  const course = courseRows[0];
  if (!course || (course.category === 'secondary' && /mashq|worksheet/i.test(course.title))) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'student') {
    if (user.id !== studentId) return false;
    if (threadKey.startsWith('level:')) {
      const levelId = threadKey.slice('level:'.length);
      const { rows } = await pool.query(
        `SELECT 1 FROM levels l JOIN enrollments en ON en.course_id = l.course_id
         WHERE l.id = $1 AND l.course_id = $2 AND en.student_id = $3 LIMIT 1`,
        [levelId, courseId, studentId]
      );
      return Boolean(rows[0]);
    }
    const { rows } = await pool.query(
      `SELECT 1 FROM enrollments WHERE student_id = $1 AND course_id = $2 LIMIT 1`,
      [studentId, courseId]
    );
    return Boolean(rows[0]);
  }
  if (threadKey.startsWith('level:')) {
    const levelId = threadKey.slice('level:'.length);
    const { rows } = await pool.query(
      `SELECT 1 FROM entries e JOIN levels l ON l.id = e.level_id
       WHERE e.student_id = $1 AND e.level_id = $2 AND l.course_id = $4
         AND (e.assigned_teacher_id = $3 OR e.reviewed_by = $3) LIMIT 1`,
      [studentId, levelId, user.id, courseId]
    );
    return Boolean(rows[0]);
  }
  const { rows } = await pool.query(
    `SELECT 1 FROM entries e JOIN levels l ON l.id = e.level_id
     WHERE e.student_id = $1 AND l.course_id = $2
       AND (e.assigned_teacher_id = $3 OR e.reviewed_by = $3) LIMIT 1`,
    [studentId, courseId, user.id]
  );
  return Boolean(rows[0]);
}

export async function chatRoutes(app: FastifyInstance) {
  app.get('/teachers', { preHandler: [app.authenticate, app.requireRole('student')] }, async () => {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.branch_id, b.name AS branch_name, u.photo_storage_key
       FROM users u LEFT JOIN branches b ON b.id = u.branch_id
       WHERE u.role = 'teacher' AND u.deleted_at IS NULL ORDER BY u.name`
    );
    return { teachers: rows };
  });

  app.get('/threads', { preHandler: [app.authenticate, app.requireRole('student')] }, async (request) => {
    const studentId = (request.user as AuthUser).id;
    const [courses, direct] = await Promise.all([
      pool.query(
        `SELECT c.id AS course_id, c.title AS course_title, c.category, kt.display_name AS khat_type_name,
                en.current_level_index, en.percent_complete, en.enrolled_at,
                ((SELECT COUNT(*) FROM course_chat_messages unread
                  WHERE unread.student_id = en.student_id AND unread.course_id = c.id
                    AND unread.thread_key = 'course' AND unread.sender_id <> en.student_id
                    AND unread.created_at > COALESCE((SELECT last_read_at FROM course_chat_read_state cr
                      WHERE cr.student_id = en.student_id AND cr.course_id = c.id), '1970-01-01'))
                 + (SELECT COUNT(*) FROM entries reviewed
                    JOIN levels l ON l.id = reviewed.level_id
                    WHERE reviewed.student_id = en.student_id AND l.course_id = c.id
                      AND reviewed.reviewed_at IS NOT NULL
                      AND reviewed.reviewed_at > COALESCE((SELECT last_read_at FROM course_chat_read_state cr
                        WHERE cr.student_id = en.student_id AND cr.course_id = c.id), '1970-01-01'))) AS unread_count,
                 GREATEST(COALESCE((SELECT MAX(m.created_at) FROM course_chat_messages m
                   WHERE m.student_id = en.student_id AND m.course_id = c.id AND m.thread_key = 'course'), '1970-01-01'),
                  COALESCE((SELECT MAX(e.reviewed_at) FROM entries e JOIN levels l ON l.id = e.level_id
                   WHERE e.student_id = en.student_id AND l.course_id = c.id), '1970-01-01')) AS last_message_at
         FROM enrollments en JOIN courses c ON c.id = en.course_id
         JOIN khat_types kt ON kt.id = c.khat_type_id
         WHERE en.student_id = $1
           AND (c.category <> 'secondary' OR (LOWER(c.title) NOT LIKE '%mashq%' AND LOWER(c.title) NOT LIKE '%worksheet%'))
         ORDER BY last_message_at DESC, en.enrolled_at DESC`,
        [studentId]
      ),
      pool.query(
        `SELECT t.id AS teacher_id, t.name AS teacher_name, t.branch_id, b.name AS branch_name,
                t.photo_storage_key,
                SUM(CASE WHEN m.sender_id = t.id AND m.read_at IS NULL THEN 1 ELSE 0 END) AS unread_count,
                MAX(m.created_at) AS last_message_at
         FROM direct_chat_messages m JOIN users t ON t.id = m.teacher_id
         LEFT JOIN branches b ON b.id = t.branch_id
         WHERE m.student_id = $1 AND t.deleted_at IS NULL
         GROUP BY t.id, t.name, t.branch_id, b.name, t.photo_storage_key
         ORDER BY last_message_at DESC`,
        [studentId]
      ),
    ]);
    return { courses: courses.rows, teachers: direct.rows };
  });

  app.get('/teacher-threads', { preHandler: [app.authenticate, app.requireRole('teacher')] }, async (request) => {
    const teacherId = (request.user as AuthUser).id;
    const { rows } = await pool.query(
      `SELECT s.id AS student_id, s.name AS student_name, s.branch_id, b.name AS branch_name,
              s.photo_storage_key,
              SUM(CASE WHEN m.sender_id = s.id AND m.read_at IS NULL THEN 1 ELSE 0 END) AS unread_count,
              MAX(m.created_at) AS last_message_at
       FROM direct_chat_messages m JOIN users s ON s.id = m.student_id
       LEFT JOIN branches b ON b.id = s.branch_id
       WHERE m.teacher_id = $1 AND s.deleted_at IS NULL
       GROUP BY s.id, s.name, s.branch_id, b.name, s.photo_storage_key
       ORDER BY last_message_at DESC`,
      [teacherId]
    );
    return { students: rows };
  });

  app.get<{ Params: { studentId: string; courseId: string }; Querystring: { threadKey?: string } }>(
    '/students/:studentId/courses/:courseId/messages',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      const { studentId, courseId } = request.params;
      const threadKey = normalizeThreadKey(request.query.threadKey);
      if (!threadKey) return reply.code(400).send({ error: 'Unknown chat thread' });
      if (!await canAccessCourseChat(studentId, courseId, threadKey, user)) return reply.code(403).send({ error: 'Not authorized to view this course chat' });
      if (user.role === 'student' && threadKey === 'course') {
        await pool.query(
          `INSERT INTO course_chat_read_state (student_id, course_id, last_read_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP(6))
           ON DUPLICATE KEY UPDATE last_read_at = CURRENT_TIMESTAMP(6)`,
          [studentId, courseId]
        );
        await pool.query(
          `UPDATE course_chat_messages SET student_read_at = CURRENT_TIMESTAMP(6)
           WHERE student_id = $1 AND course_id = $2 AND thread_key = 'course'
             AND sender_id <> $1 AND student_read_at IS NULL`,
          [studentId, courseId]
        );
      }
      const { rows } = await pool.query(
        `SELECT m.id, m.sender_id, u.name AS sender_name, u.role AS sender_role,
                m.message_type AS type, m.content, m.storage_key, m.created_at
         FROM course_chat_messages m JOIN users u ON u.id = m.sender_id
         WHERE m.student_id = $1 AND m.course_id = $2 AND m.thread_key = $3 ORDER BY m.created_at ASC, m.id ASC`,
        [studentId, courseId, threadKey]
      );
      return { messages: rows };
    }
  );

  app.post<{ Params: { studentId: string; courseId: string }; Body: MessageBody }>(
    '/students/:studentId/courses/:courseId/messages',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      const { studentId, courseId } = request.params;
      const { type, content, storageKey } = request.body ?? {};
      const threadKey = normalizeThreadKey(request.body?.threadKey);
      if (!threadKey) return reply.code(400).send({ error: 'Unknown chat thread' });
      if (!await canAccessCourseChat(studentId, courseId, threadKey, user)) return reply.code(403).send({ error: 'Not authorized to send messages in this course chat' });
      if (type === 'text') {
        const text = content?.trim();
        if (!text || text.length > 4000) return reply.code(400).send({ error: 'Text messages must be between 1 and 4000 characters' });
        const { rows } = await pool.query(
          `INSERT INTO course_chat_messages (student_id, course_id, sender_id, message_type, content, thread_key)
           VALUES ($1, $2, $3, 'text', $4, $5) RETURNING id, sender_id, message_type AS type, content, storage_key, created_at`,
          [studentId, courseId, user.id, text, threadKey]
        );
        return reply.code(201).send({ message: { ...rows[0], sender_role: user.role } });
      }
      if (type === 'voice') {
        if (!storageKey?.startsWith('chat-audio/')) return reply.code(400).send({ error: 'A valid chat voice note is required' });
        const { rows } = await pool.query(
          `INSERT INTO course_chat_messages (student_id, course_id, sender_id, message_type, storage_key, thread_key)
           VALUES ($1, $2, $3, 'voice', $4, $5) RETURNING id, sender_id, message_type AS type, content, storage_key, created_at`,
          [studentId, courseId, user.id, storageKey, threadKey]
        );
        return reply.code(201).send({ message: { ...rows[0], sender_role: user.role } });
      }
      return reply.code(400).send({ error: "type must be 'text' or 'voice'" });
    }
  );

  app.get<{ Params: { teacherId: string } }>(
    '/direct/teachers/:teacherId/messages',
    { preHandler: [app.authenticate, app.requireRole('student')] },
    async (request, reply) => {
      const studentId = (request.user as AuthUser).id;
      const { rows: teacherRows } = await pool.query(
        `SELECT id FROM users WHERE id = $1 AND role = 'teacher' AND deleted_at IS NULL`,
        [request.params.teacherId]
      );
      if (!teacherRows[0]) return reply.code(404).send({ error: 'Teacher not found' });
      await pool.query(
        `UPDATE direct_chat_messages SET read_at = CURRENT_TIMESTAMP(6)
         WHERE student_id = $1 AND teacher_id = $2 AND sender_id = $2 AND read_at IS NULL`,
        [studentId, request.params.teacherId]
      );
      const { rows } = await pool.query(
        `SELECT m.id, m.sender_id, u.name AS sender_name, u.role AS sender_role,
                m.message_type AS type, m.content, m.storage_key, m.created_at
         FROM direct_chat_messages m JOIN users u ON u.id = m.sender_id
         WHERE m.student_id = $1 AND m.teacher_id = $2 ORDER BY m.created_at ASC, m.id ASC`,
        [studentId, request.params.teacherId]
      );
      return { messages: rows };
    }
  );

  app.post<{ Params: { teacherId: string }; Body: MessageBody }>(
    '/direct/teachers/:teacherId/messages',
    { preHandler: [app.authenticate, app.requireRole('student')] },
    async (request, reply) => {
      const studentId = (request.user as AuthUser).id;
      const { rows: teacherRows } = await pool.query(
        `SELECT id FROM users WHERE id = $1 AND role = 'teacher' AND deleted_at IS NULL`,
        [request.params.teacherId]
      );
      if (!teacherRows[0]) return reply.code(404).send({ error: 'Teacher not found' });
      const { type, content, storageKey } = request.body ?? {};
      if (type === 'text') {
        const text = content?.trim();
        if (!text || text.length > 4000) return reply.code(400).send({ error: 'Text messages must be between 1 and 4000 characters' });
        const { rows } = await pool.query(
          `INSERT INTO direct_chat_messages (student_id, teacher_id, sender_id, message_type, content)
           VALUES ($1, $2, $1, 'text', $3) RETURNING id, sender_id, message_type AS type, content, storage_key, created_at`,
          [studentId, request.params.teacherId, text]
        );
        return reply.code(201).send({ message: { ...rows[0], sender_role: 'student' } });
      }
      if (type === 'voice') {
        if (!storageKey?.startsWith('chat-audio/')) return reply.code(400).send({ error: 'A valid chat voice note is required' });
        const { rows } = await pool.query(
          `INSERT INTO direct_chat_messages (student_id, teacher_id, sender_id, message_type, storage_key)
           VALUES ($1, $2, $1, 'voice', $3) RETURNING id, sender_id, message_type AS type, content, storage_key, created_at`,
          [studentId, request.params.teacherId, storageKey]
        );
        return reply.code(201).send({ message: { ...rows[0], sender_role: 'student' } });
      }
      return reply.code(400).send({ error: "type must be 'text' or 'voice'" });
    }
  );

  app.get<{ Params: { studentId: string; teacherId: string } }>(
    '/direct/students/:studentId/teachers/:teacherId/messages',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      if (user.role !== 'admin' && user.id !== request.params.studentId && user.id !== request.params.teacherId) {
        return reply.code(403).send({ error: 'Not authorized to view this conversation' });
      }
      if (user.role === 'teacher' && user.id === request.params.teacherId) {
        const { rows: conversationRows } = await pool.query(
          `SELECT 1 FROM direct_chat_messages WHERE student_id = $1 AND teacher_id = $2 LIMIT 1`,
          [request.params.studentId, request.params.teacherId]
        );
        if (!conversationRows[0]) return reply.code(404).send({ error: 'Conversation not found' });
        await pool.query(
          `UPDATE direct_chat_messages SET read_at = CURRENT_TIMESTAMP(6)
           WHERE student_id = $1 AND teacher_id = $2 AND sender_id = $1 AND read_at IS NULL`,
          [request.params.studentId, request.params.teacherId]
        );
      }
      const { rows } = await pool.query(
        `SELECT m.id, m.sender_id, u.name AS sender_name, u.role AS sender_role,
                m.message_type AS type, m.content, m.storage_key, m.created_at
         FROM direct_chat_messages m JOIN users u ON u.id = m.sender_id
         WHERE m.student_id = $1 AND m.teacher_id = $2 ORDER BY m.created_at ASC, m.id ASC`,
        [request.params.studentId, request.params.teacherId]
      );
      return { messages: rows };
    }
  );

  app.post<{ Params: { studentId: string; teacherId: string }; Body: MessageBody }>(
    '/direct/students/:studentId/teachers/:teacherId/messages',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      const { studentId, teacherId } = request.params;
      if (user.role !== 'admin' && user.id !== studentId && user.id !== teacherId) {
        return reply.code(403).send({ error: 'Not authorized to send messages in this conversation' });
      }
      const { type, content, storageKey } = request.body ?? {};
      if (type !== 'text' && type !== 'voice') return reply.code(400).send({ error: "type must be 'text' or 'voice'" });
      if (type === 'text' && (!content?.trim() || content.trim().length > 4000)) return reply.code(400).send({ error: 'Text messages must be between 1 and 4000 characters' });
      if (type === 'voice' && !storageKey?.startsWith('chat-audio/')) return reply.code(400).send({ error: 'A valid chat voice note is required' });
      const { rows: teacherRows } = await pool.query(`SELECT id FROM users WHERE id = $1 AND role = 'teacher' AND deleted_at IS NULL`, [teacherId]);
      const { rows: studentRows } = await pool.query(`SELECT id FROM users WHERE id = $1 AND role = 'student' AND deleted_at IS NULL`, [studentId]);
      if (!teacherRows[0] || !studentRows[0]) return reply.code(404).send({ error: 'Conversation participant not found' });
      if (user.role === 'teacher') {
        const { rows: conversationRows } = await pool.query(
          `SELECT 1 FROM direct_chat_messages WHERE student_id = $1 AND teacher_id = $2 LIMIT 1`,
          [studentId, teacherId]
        );
        if (!conversationRows[0]) return reply.code(403).send({ error: 'The student must start this guidance conversation first' });
      }
      const { rows } = await pool.query(
        `INSERT INTO direct_chat_messages (student_id, teacher_id, sender_id, message_type, content, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, sender_id, message_type AS type, content, storage_key, created_at`,
        [studentId, teacherId, user.id, type, type === 'text' ? content?.trim() : null, type === 'voice' ? storageKey : null]
      );
      return reply.code(201).send({ message: { ...rows[0], sender_role: user.role } });
    }
  );
}