import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';
import { autoAssignEntry } from '../services/entryRouting.js';
import { runDiversionAndIdleFlagSweep } from '../services/diversionSweep.js';
import { notify, notifyAllAdmins } from '../services/notify.js';

type CreateEntryBody = {
  sourceType: 'checkpoint' | 'event' | 'competition';
  levelId?: string;
  eventId?: string;
  competitionId?: string;
  khatImageStorageKey: string;
  originalFilename?: string;
};
type ReviewDecisionBody = {
  decision: 'pass' | 'redo';
  feedback?: string;
  correctionImageStorageKey?: string;
  correctionVoiceStorageKey?: string;
};
type DivertBody = { teacherId: string; reason?: string };
type RedoBody = { khatImageStorageKey: string; originalFilename?: string };

export async function entryRoutes(app: FastifyInstance) {
  // ---- Admin: searchable entry inventory for the control panel ----
  app.get<{ Querystring: { status?: string; branchId?: string; khatTypeId?: string } }>(
    '/',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request) => {
      const { status, branchId, khatTypeId } = request.query;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (status === 'reviewed') {
        conditions.push(`e.status IN ('reviewed', 'redo_needed')`);
      } else if (status) {
        params.push(status);
        conditions.push(`e.status = $${params.length}`);
      }
      if (branchId) { params.push(branchId); conditions.push(`u.branch_id = $${params.length}`); }
      if (khatTypeId) { params.push(khatTypeId); conditions.push(`COALESCE(c.khat_type_id, comp.khat_type_id) = $${params.length}`); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await pool.query(
        `SELECT e.id, e.status, e.student_id, u.name AS student_name, u.branch_id AS student_branch_id,
                COALESCE(c.khat_type_id, comp.khat_type_id) AS khat_type_id,
                e.assigned_teacher_id, e.created_at, e.idle_flagged, e.source_type
         FROM entries e
         JOIN users u ON u.id = e.student_id
         LEFT JOIN levels l ON l.id = e.level_id
         LEFT JOIN courses c ON c.id = l.course_id
         LEFT JOIN competitions comp ON comp.id = e.competition_id
         ${where}
         ORDER BY e.created_at DESC
         LIMIT 1000`,
        params
      );
      return rows;
    }
  );

  // ---- Student: submit a checkpoint/event/competition entry ----
  app.post<{ Body: CreateEntryBody }>(
    '/',
    { preHandler: [app.authenticate, app.requireRole('student')] },
    async (request, reply) => {
      const { sourceType, levelId, eventId, competitionId, khatImageStorageKey, originalFilename } = request.body;
      if (!sourceType || !khatImageStorageKey) {
        return reply.code(400).send({ error: 'sourceType and khatImageStorageKey are required' });
      }
      if (sourceType === 'checkpoint' && !levelId) {
        return reply.code(400).send({ error: 'levelId is required for a checkpoint entry' });
      }

      const studentId = (request.user as AuthUser).id;
      if (sourceType === 'checkpoint') {
        const { rows: levelRows } = await pool.query(
          `SELECT l.id, l.course_id, l.order_index, l.level_type, c.category
           FROM levels l JOIN courses c ON c.id = l.course_id WHERE l.id = $1`,
          [levelId]
        );
        const level = levelRows[0];
        if (!level) return reply.code(404).send({ error: 'Checkpoint level not found' });
        if (level.level_type !== 'test') return reply.code(400).send({ error: 'Entries can only be submitted to checkpoint test levels' });

        await pool.query(
          `INSERT INTO enrollments (student_id, course_id) VALUES ($1, $2)
           ON CONFLICT (student_id, course_id) DO NOTHING`,
          [studentId, level.course_id]
        );
        const { rows: enrollmentRows } = await pool.query(
          'SELECT current_level_index FROM enrollments WHERE student_id = $1 AND course_id = $2',
          [studentId, level.course_id]
        );
        if (level.category !== 'secondary' && level.order_index > enrollmentRows[0].current_level_index) {
          return reply.code(403).send({ error: 'This checkpoint is locked — complete the earlier levels first' });
        }

        const { rows: blockingCheckpoints } = await pool.query(
          `SELECT l.title FROM levels l
           WHERE l.course_id = $1 AND l.level_type = 'test' AND l.order_index < $2
             AND NOT EXISTS (
               SELECT 1 FROM entries e
               WHERE e.student_id = $3 AND e.level_id = l.id
                 AND e.source_type = 'checkpoint' AND e.status = 'reviewed'
             )
           ORDER BY l.order_index LIMIT 1`,
          [level.course_id, level.order_index, studentId]
        );
        if (blockingCheckpoints[0]) {
          return reply.code(403).send({ error: `Pass the earlier checkpoint “${blockingCheckpoints[0].title}” before continuing` });
        }
      }

      const { rows } = await pool.query(
        `INSERT INTO entries (student_id, source_type, level_id, event_id, competition_id, khat_image_storage_key, original_filename)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [studentId, sourceType, levelId ?? null, eventId ?? null, competitionId ?? null, khatImageStorageKey, originalFilename ?? null]
      );
      const entry = rows[0];

      if (sourceType === 'checkpoint') {
        await autoAssignEntry(entry.id);
      }
      // Event/competition routing (judge assignment, etc.) is handled by those
      // modules once built — this entry sits at 'pending' until then.

      const { rows: finalRows } = await pool.query('SELECT * FROM entries WHERE id = $1', [entry.id]);
      return reply.code(201).send(finalRows[0]);
    }
  );

  // ---- Student: their own entries (dashboard/profile) ----
  app.get('/mine', { preHandler: [app.authenticate, app.requireRole('student')] }, async (request) => {
    const studentId = (request.user as AuthUser).id;
    const { rows } = await pool.query(
      `SELECT e.*, l.title AS level_title, c.khat_type_id, reviewer.name AS reviewed_by_name
       FROM entries e
       LEFT JOIN levels l ON l.id = e.level_id
       LEFT JOIN courses c ON c.id = l.course_id
       LEFT JOIN users reviewer ON reviewer.id = e.reviewed_by
       WHERE e.student_id = $1
       ORDER BY e.created_at DESC`,
      [studentId]
    );
    return rows;
  });

  // ---- Teacher: my review queue ----
  app.get('/queue', { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = request.user as AuthUser;
    if (user.role !== 'teacher' && user.role !== 'admin') {
      return reply.code(403).send({ error: 'Not authorized to view the review queue' });
    }
    if (user.role === 'admin') {
      const { rows } = await pool.query(
        `SELECT e.id, e.source_type, e.status, e.created_at, e.locked_at,
            l.title AS level_title, c.khat_type_id, kt.code AS khat_type_code, kt.display_name AS khat_type_name,
            u.name AS student_name, u.branch_id AS student_branch_id
         FROM entries e
         LEFT JOIN levels l ON l.id = e.level_id
         LEFT JOIN courses c ON c.id = l.course_id
          LEFT JOIN khat_types kt ON kt.id = c.khat_type_id
         JOIN users u ON u.id = e.student_id
         WHERE e.status = 'assigned'
         ORDER BY e.created_at ASC LIMIT 200`
      );
      return rows;
    }
    const teacherId = user.id;
    const { rows } = await pool.query(
      `SELECT e.id, e.source_type, e.status, e.created_at, e.locked_at,
        l.title AS level_title, c.khat_type_id, kt.code AS khat_type_code, kt.display_name AS khat_type_name,
        u.name AS student_name, u.branch_id AS student_branch_id
       FROM entries e
       LEFT JOIN levels l ON l.id = e.level_id
       LEFT JOIN courses c ON c.id = l.course_id
      LEFT JOIN khat_types kt ON kt.id = c.khat_type_id
       JOIN users u ON u.id = e.student_id
       WHERE e.assigned_teacher_id = $1 AND e.status IN ('assigned', 'in_review')
       ORDER BY e.created_at ASC`,
      [teacherId]
    );
    return rows;
  });

  // ---- Teacher: completed reviews and review-performance metrics ----
  app.get('/reviews', { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = request.user as AuthUser;
    if (user.role !== 'teacher' && user.role !== 'admin') {
      return reply.code(403).send({ error: 'Not authorized to view review history' });
    }
    const teacherId = user.id;
    const [reviews, reviewStats] = await Promise.all([
      pool.query(
        `SELECT e.id, e.reviewed_at, e.status,
                CASE e.status WHEN 'reviewed' THEN 'pass' WHEN 'redo_needed' THEN 'redo' END AS decision,
                e.source_type, e.feedback, l.title AS level_title,
                kt.display_name AS script_name, u.name AS student_name
         FROM entries e
         JOIN users u ON u.id = e.student_id
         LEFT JOIN levels l ON l.id = e.level_id
         LEFT JOIN courses c ON c.id = l.course_id
         LEFT JOIN khat_types kt ON kt.id = c.khat_type_id
         WHERE e.reviewed_by = $1 AND e.reviewed_at IS NOT NULL
           AND e.status IN ('reviewed', 'redo_needed')
         ORDER BY e.reviewed_at DESC`,
        [teacherId]
      ),
      pool.query(
        `SELECT COUNT(*) AS total_reviewed,
                AVG(TIMESTAMPDIFF(SECOND, locked_at, reviewed_at) / 3600) AS avg_response_hours,
                COUNT(*) FILTER (WHERE is_diverted = true) AS escalated_away_count
         FROM entries WHERE reviewed_by = $1`,
        [teacherId]
      ),
    ]);

    const stats = reviewStats.rows[0];
    return {
      reviews: reviews.rows,
      stats: {
        totalReviewed: Number(stats.total_reviewed),
        avgResponseHours: stats.avg_response_hours == null ? null : Number(stats.avg_response_hours),
        escalatedAwayCount: Number(stats.escalated_away_count),
      },
    };
  });

  // ---- Teacher/Admin: scoped entry detail ----
  // For a checkpoint entry, this returns ONLY the level_submissions between the
  // previous checkpoint (exclusive) and this one (exclusive) — never the
  // student's full history. That fuller view is a separate, later endpoint.
  app.get<{ Params: { id: string } }>('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = request.user as AuthUser;
    const { rows } = await pool.query(
      `SELECT e.*, u.name AS student_name FROM entries e JOIN users u ON u.id = e.student_id WHERE e.id = $1`,
      [request.params.id]
    );
    const entry = rows[0];
    if (!entry) return reply.code(404).send({ error: 'Entry not found' });

    const isOwner = entry.student_id === user.id;
    const isAssignedTeacher = entry.assigned_teacher_id === user.id;
    if (!isOwner && !isAssignedTeacher && user.role !== 'admin') {
      return reply.code(403).send({ error: 'Not authorized to view this entry' });
    }

    let scopedSubmissions: unknown[] = [];
    if (entry.source_type === 'checkpoint' && entry.level_id) {
      const { rows: levelRows } = await pool.query(
        `SELECT l.order_index, l.course_id FROM levels l WHERE l.id = $1`,
        [entry.level_id]
      );
      const thisLevel = levelRows[0];
      if (thisLevel) {
        const { rows: prevTestRows } = await pool.query(
          `SELECT COALESCE(MAX(order_index), -1) AS prev_test_index
           FROM levels WHERE course_id = $1 AND level_type = 'test' AND order_index < $2`,
          [thisLevel.course_id, thisLevel.order_index]
        );
        const prevTestIndex = prevTestRows[0].prev_test_index;

        const { rows: submissions } = await pool.query(
          `SELECT ls.* FROM level_submissions ls
           JOIN levels l ON l.id = ls.level_id
           WHERE ls.student_id = $1 AND l.course_id = $2
             AND l.order_index > $3 AND l.order_index < $4
           ORDER BY l.order_index`,
          [entry.student_id, thisLevel.course_id, prevTestIndex, thisLevel.order_index]
        );
        scopedSubmissions = submissions;
      }
    }

    return { ...entry, scopedSubmissions };
  });

  // ---- Teacher: open/lock an entry to review it ----
  app.post<{ Params: { id: string } }>(
    '/:id/open',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      if (user.role !== 'teacher' && user.role !== 'admin') {
        return reply.code(403).send({ error: 'Not authorized to open entries for review' });
      }
      const teacherId = user.id;
      const { rows } = await pool.query('SELECT * FROM entries WHERE id = $1', [request.params.id]);
      const entry = rows[0];
      if (!entry) return reply.code(404).send({ error: 'Entry not found' });
      if (user.role === 'teacher' && entry.assigned_teacher_id !== teacherId) {
        return reply.code(403).send({ error: 'This entry is not assigned to you' });
      }
      if (entry.status === 'in_review') {
        return reply.code(409).send({ error: 'Already locked for review' });
      }
      if (entry.status !== 'assigned') {
        return reply.code(409).send({ error: `Cannot open an entry with status '${entry.status}'` });
      }

      const { rows: updated } = await pool.query(
        `UPDATE entries SET status = 'in_review', locked_at = now(),
           assigned_teacher_id = CASE WHEN $2 = 'admin' THEN $3 ELSE assigned_teacher_id END
         WHERE id = $1 AND status = 'assigned' RETURNING *`,
        [entry.id, user.role, teacherId]
      );
      if (!updated[0]) return reply.code(409).send({ error: 'This entry was opened by someone else. Refresh the queue.' });
      await pool.query(`INSERT INTO entry_logs (entry_id, action, actor_id) VALUES ($1, 'locked', $2)`, [
        entry.id,
        teacherId,
      ]);
      return updated[0];
    }
  );

  // ---- Teacher: submit the pass/redo decision ----
  app.post<{ Params: { id: string }; Body: ReviewDecisionBody }>(
    '/:id/review',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      if (user.role !== 'teacher' && user.role !== 'admin') {
        return reply.code(403).send({ error: 'Not authorized to review entries' });
      }
      const teacherId = user.id;
      const { decision, feedback, correctionImageStorageKey, correctionVoiceStorageKey } = request.body;
      if (decision !== 'pass' && decision !== 'redo') {
        return reply.code(400).send({ error: "decision must be 'pass' or 'redo'" });
      }

      const { rows } = await pool.query('SELECT * FROM entries WHERE id = $1', [request.params.id]);
      const entry = rows[0];
      if (!entry) return reply.code(404).send({ error: 'Entry not found' });
      if (entry.assigned_teacher_id !== teacherId || entry.status !== 'in_review') {
        return reply.code(403).send({ error: 'You do not have this entry locked for review' });
      }

      const newStatus = decision === 'pass' ? 'reviewed' : 'redo_needed';
      const { rows: updated } = await pool.query(
        `UPDATE entries
         SET status = $1, feedback = $2, correction_image_storage_key = $3,
           correction_voice_storage_key = $4, reviewed_at = now(), reviewed_by = $5
         WHERE id = $6 RETURNING *`,
        [newStatus, feedback ?? null, correctionImageStorageKey ?? null, correctionVoiceStorageKey ?? null, teacherId, entry.id]
      );
      await pool.query(`INSERT INTO entry_logs (entry_id, action, actor_id, notes) VALUES ($1, 'reviewed', $2, $3)`, [
        entry.id,
        teacherId,
        `Decision: ${decision}`,
      ]);

      // On a pass: unlock the next block of levels, recompute progress,
      // auto-allocate a certificate (pending admin approval) if a template
      // exists for this checkpoint, and auto-award the badge tier if
      // configured — badges are NOT gated on admin approval, certificates are.
      if (decision === 'pass' && entry.level_id) {
        const { rows: levelRows } = await pool.query(
          `SELECT l.course_id, l.order_index, l.badge_tier, c.category
           FROM levels l JOIN courses c ON c.id = l.course_id WHERE l.id = $1`,
          [entry.level_id]
        );
        const level = levelRows[0];
        if (level) {
          const { rows: totalRows } = await pool.query('SELECT COUNT(*) AS total FROM levels WHERE course_id = $1', [
            level.course_id,
          ]);
          const totalLevels = Number(totalRows[0].total);
          const newIndex = level.order_index + 1;
          const justCompleted = newIndex >= totalLevels;

          await pool.query(
            `UPDATE enrollments SET
               current_level_index = GREATEST(current_level_index, $1),
               percent_complete = CASE WHEN $2 > 0
                 THEN LEAST(100, (GREATEST(current_level_index, $1)::numeric / $2) * 100)
                 ELSE 0 END,
               status = CASE WHEN $3 THEN 'completed' ELSE status END
             WHERE student_id = $4 AND course_id = $5`,
            [newIndex, totalLevels, justCompleted, entry.student_id, level.course_id]
          );

          // Certificate: automatic allocation, but pending until admin approves.
          if (level.category === 'certification') {
            const { rows: templateRows } = await pool.query(
              `SELECT * FROM certificate_templates WHERE level_id = $1`,
              [entry.level_id]
            );
            const template = templateRows[0];
            if (template) {
              const { rows: certificateRows } = await pool.query(
                `INSERT INTO certificates (student_id, khat_type_id, level_id, title, file_storage_key, status, template_id)
                 SELECT $1, $2, $3, $4, $5, 'pending', $6
                 WHERE NOT EXISTS (
                   SELECT 1 FROM certificates WHERE student_id = $1 AND template_id = $6
                 ) RETURNING id, title`,
                [entry.student_id, template.khat_type_id, entry.level_id, template.title, template.file_storage_key, template.id]
              );
              const certificate = certificateRows[0];
              if (certificate) {
                await Promise.all([
                  notify(entry.student_id, 'certificate_pending_review', { certificateId: certificate.id, title: certificate.title }),
                  notifyAllAdmins('certificate_pending_review', { certificateId: certificate.id, studentId: entry.student_id, title: certificate.title }),
                ]);
              }
            }
          }

          // A secondary course may also end with a teacher-reviewed checkpoint.
          // Passing that final level completes the course and awards its course template.
          if (justCompleted && level.category === 'secondary') {
            const { rows: templateRows } = await pool.query(
              'SELECT * FROM certificate_templates WHERE course_id = $1',
              [level.course_id]
            );
            const template = templateRows[0];
            if (template) {
              const { rows: certificateRows } = await pool.query(
                `INSERT INTO certificates (student_id, khat_type_id, course_id, title, file_storage_key, status, template_id)
                 SELECT $1, $2, $3, $4, $5, 'pending', $6
                 WHERE NOT EXISTS (
                   SELECT 1 FROM certificates WHERE student_id = $1 AND template_id = $6
                 ) RETURNING id, title`,
                [entry.student_id, template.khat_type_id, level.course_id, template.title, template.file_storage_key, template.id]
              );
              const certificate = certificateRows[0];
              if (certificate) {
                await Promise.all([
                  notify(entry.student_id, 'certificate_pending_review', { certificateId: certificate.id, title: certificate.title }),
                  notifyAllAdmins('certificate_pending_review', { certificateId: certificate.id, studentId: entry.student_id, title: certificate.title }),
                ]);
              }
            }
          }

          // Badge: fully automatic, no approval step.
          if (level.badge_tier) {
            const { rows: courseRows } = await pool.query('SELECT khat_type_id FROM courses WHERE id = $1', [
              level.course_id,
            ]);
            const khatTypeId = courseRows[0]?.khat_type_id;
            if (khatTypeId) {
              await pool.query(
                `INSERT INTO badges (student_id, khat_type_id, tier)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (student_id, khat_type_id) DO UPDATE SET tier = $3, awarded_at = now()`,
                [entry.student_id, khatTypeId, level.badge_tier]
              );
            }
          }
        }
      }

      await notify(entry.student_id, 'test_result', { entryId: entry.id, decision });

      return updated[0];
    }
  );

  // ---- Student: resubmit after a redo — a brand-new entry, same letters/text ----
  app.post<{ Params: { id: string }; Body: RedoBody }>(
    '/:id/redo',
    { preHandler: [app.authenticate, app.requireRole('student')] },
    async (request, reply) => {
      const studentId = (request.user as AuthUser).id;
      const { khatImageStorageKey, originalFilename } = request.body;
      if (!khatImageStorageKey) return reply.code(400).send({ error: 'khatImageStorageKey is required' });

      const { rows } = await pool.query('SELECT * FROM entries WHERE id = $1', [request.params.id]);
      const original = rows[0];
      if (!original) return reply.code(404).send({ error: 'Entry not found' });
      if (original.student_id !== studentId) return reply.code(403).send({ error: 'Not your entry' });
      if (original.status !== 'redo_needed') {
        return reply.code(409).send({ error: 'This entry is not awaiting a redo' });
      }

      // A NEW row, linked back for history — never a status reset on the old one.
      // Explicitly clear both teacher-only correction assets: the redo's assigned
      // reviewer must never receive the failed attempt's annotated sheet or voice note.
      const { rows: created } = await pool.query(
        `INSERT INTO entries (
           student_id, source_type, level_id, khat_image_storage_key, original_filename, redo_of_entry_id,
           correction_image_storage_key, correction_voice_storage_key
         ) VALUES ($1, 'checkpoint', $2, $3, $4, $5, NULL, NULL) RETURNING *`,
        [studentId, original.level_id, khatImageStorageKey, originalFilename ?? null, original.id]
      );
      const newEntry = created[0];
      await autoAssignEntry(newEntry.id);

      const { rows: finalRows } = await pool.query('SELECT * FROM entries WHERE id = $1', [newEntry.id]);
      return reply.code(201).send(finalRows[0]);
    }
  );

  // ---- Admin: full list / overflow queue (status='pending' = unassigned) ----
  app.get<{ Querystring: { branchId?: string; khatTypeId?: string; action?: string; from?: string; to?: string } }>(
    '/logs',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request) => {
      const { branchId, khatTypeId, action, from, to } = request.query;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (branchId) { params.push(branchId); conditions.push(`u.branch_id = $${params.length}`); }
      if (khatTypeId) { params.push(khatTypeId); conditions.push(`COALESCE(c.khat_type_id, comp.khat_type_id) = $${params.length}`); }
      if (action) { params.push(action); conditions.push(`el.action = $${params.length}`); }
      if (from) { params.push(from); conditions.push(`el.created_at >= $${params.length}`); }
      if (to) { params.push(to); conditions.push(`el.created_at <= $${params.length}`); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await pool.query(
        `SELECT el.*, e.student_id, u.name AS student_name, u.branch_id AS student_branch_id,
                COALESCE(c.khat_type_id, comp.khat_type_id) AS khat_type_id,
                actor.name AS actor_name
         FROM entry_logs el
         JOIN entries e ON e.id = el.entry_id
         JOIN users u ON u.id = e.student_id
         LEFT JOIN users actor ON actor.id = el.actor_id
         LEFT JOIN levels l ON l.id = e.level_id
         LEFT JOIN courses c ON c.id = l.course_id
         LEFT JOIN competitions comp ON comp.id = e.competition_id
         ${where}
         ORDER BY el.created_at DESC
         LIMIT 300`,
        params
      );
      return rows;
    }
  );

  // ---- Admin: manual diversion (bypasses khat-type/threshold matching; never bypasses a lock) ----
  app.post<{ Params: { id: string }; Body: DivertBody }>(
    '/:id/divert',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const adminId = (request.user as AuthUser).id;
      const { teacherId, reason } = request.body;
      if (!teacherId) return reply.code(400).send({ error: 'teacherId is required' });

      const { rows } = await pool.query('SELECT * FROM entries WHERE id = $1', [request.params.id]);
      const entry = rows[0];
      if (!entry) return reply.code(404).send({ error: 'Entry not found' });
      if (entry.status === 'in_review') {
        return reply.code(409).send({ error: 'Cannot divert a locked entry — it is currently being reviewed' });
      }

      const { rows: updated } = await pool.query(
        `UPDATE entries
         SET assigned_teacher_id = $1, status = 'assigned', is_diverted = true,
             diversion_reason = $2, diverted_by_admin_id = $3
         WHERE id = $4 RETURNING *`,
        [teacherId, reason ?? 'Manual admin reassignment', adminId, entry.id]
      );
      await pool.query(
        `INSERT INTO entry_logs (entry_id, action, actor_id, notes) VALUES ($1, 'manual_diverted', $2, $3)`,
        [entry.id, adminId, reason ?? 'Manual admin reassignment']
      );
      await notify(teacherId, 'new_entry_to_check', { entryId: entry.id, manuallyAssigned: true });
      return updated[0];
    }
  );

  // ---- Admin: audit trail for one entry ----
  app.get<{ Params: { id: string } }>(
    '/:id/logs',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request) => {
      const { rows } = await pool.query('SELECT * FROM entry_logs WHERE entry_id = $1 ORDER BY created_at', [
        request.params.id,
      ]);
      return rows;
    }
  );

  // ---- Admin: manually trigger the diversion/idle-flag sweep (also runs on a schedule — see server.ts) ----
  app.post(
    '/run-diversion-sweep',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async () => {
      return runDiversionAndIdleFlagSweep();
    }
  );
}
