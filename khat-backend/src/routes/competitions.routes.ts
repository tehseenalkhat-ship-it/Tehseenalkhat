import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';
import { notify, notifyAllAdmins, notifyAllStudents } from '../services/notify.js';

type CreateCompetitionBody = {
  title: string;
  description?: string;
  khatTypeId?: string;
  startDate: string;
  endDate: string;
  judgingDeadline?: string;
};
type AssignJudgeBody = { teacherId: string };
type SubmitEntryBody = { imageStorageKey: string; originalFilename?: string };
type SubmitWinnersBody = { winners: { competitionEntryId: string; rank: number }[] };

// Normalize older rows (and rows created while the database default was in
// use) from their scheduled dates, without reopening competitions in judging
// or completed states.
const EFFECTIVE_COMPETITION_STATUS = `CASE
  WHEN c.status::text IN ('completed', 'cancelled') THEN c.status::text
  WHEN c.end_date < CURRENT_DATE AND c.judge_teacher_id IS NOT NULL THEN 'judging'
  WHEN c.end_date < CURRENT_DATE THEN 'closed'
  WHEN c.status::text = 'closed' THEN 'closed'
  WHEN c.start_date > CURRENT_DATE THEN 'upcoming'
  ELSE 'open'
END`;

export async function competitionRoutes(app: FastifyInstance) {
  // ---- Admin: create ----
  app.post<{ Body: CreateCompetitionBody }>(
    '/',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { title, description, khatTypeId, startDate, endDate, judgingDeadline } = request.body;
      if (!title || !startDate || !endDate) {
        return reply.code(400).send({ error: 'title, startDate, and endDate are required' });
      }
      const adminId = (request.user as AuthUser).id;
      const { rows } = await pool.query(
        `INSERT INTO competitions (title, description, khat_type_id, start_date, end_date, judging_deadline, created_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $4::date > CURRENT_DATE THEN 'upcoming' ELSE 'open' END) RETURNING *`,
        [title, description ?? null, khatTypeId ?? null, startDate, endDate, judgingDeadline ?? null, adminId]
      );
      await notifyAllStudents('competition_created', { competitionId: rows[0].id, title, startDate, endDate });
      return reply.code(201).send(rows[0]);
    }
  );

  // ---- Anyone logged in: browse competitions (list view only — never includes entries) ----
  app.get<{ Querystring: { status?: string } }>('/', { preHandler: [app.authenticate] }, async (request) => {
    const { status } = request.query;
    const params: unknown[] = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE status = $1`;
    }
    const { rows } = await pool.query(
            `WITH competition_list AS (
          SELECT c.id, c.title, c.description, c.khat_type_id, c.start_date, c.end_date,
            c.judging_deadline, ${EFFECTIVE_COMPETITION_STATUS} AS status,
            c.results_published_at, c.judge_teacher_id
          FROM competitions c
        )
        SELECT id, title, description, khat_type_id, start_date, end_date, judging_deadline, status, results_published_at, judge_teacher_id
        FROM competition_list ${where} ORDER BY start_date DESC`,
      params
    );
    return rows;
  });

  app.get('/mine/achievements', { preHandler: [app.authenticate, app.requireRole('student')] }, async (request) => {
    const studentId = (request.user as AuthUser).id;
    const { rows } = await pool.query(
      `SELECT cw.rank, cw.awarded_at, c.id AS competition_id, c.title AS competition_title,
              c.khat_type_id, kt.display_name AS khat_type_name, ce.image_storage_key
       FROM competition_winners cw
       JOIN competitions c ON c.id = cw.competition_id
       JOIN competition_entries ce ON ce.id = cw.competition_entry_id
       LEFT JOIN khat_types kt ON kt.id = c.khat_type_id
       WHERE cw.student_id = $1 AND c.results_published_at IS NOT NULL
       ORDER BY cw.awarded_at DESC`,
      [studentId]
    );
    return rows;
  });

  // ---- Published winners only — this is what a student/public feed reads ----
  app.get<{ Params: { id: string } }>('/:id/winners', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { rows: compRows } = await pool.query(
      `SELECT results_published_at FROM competitions WHERE id = $1`,
      [request.params.id]
    );
    if (!compRows[0]) return reply.code(404).send({ error: 'Competition not found' });
    if (!compRows[0].results_published_at) {
      return reply.code(404).send({ error: 'Results have not been published yet' });
    }
    const { rows } = await pool.query(
      `SELECT cw.rank, cw.awarded_at, u.name AS student_name, u.branch_id AS student_branch_id,
              ce.image_storage_key
       FROM competition_winners cw
       JOIN users u ON u.id = cw.student_id
       JOIN competition_entries ce ON ce.id = cw.competition_entry_id
       WHERE cw.competition_id = $1 ORDER BY cw.rank`,
      [request.params.id]
    );
    return rows;
  });

  // ---- Admin: assign or reassign the judge ----
  app.post<{ Params: { id: string }; Body: AssignJudgeBody }>(
    '/:id/assign-judge',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { teacherId } = request.body;
      if (!teacherId) return reply.code(400).send({ error: 'teacherId is required' });
      const { rows } = await pool.query(
        `UPDATE competitions
         SET judge_teacher_id = $1,
             status = CASE
               WHEN end_date < CURRENT_DATE THEN 'judging'
               WHEN start_date > CURRENT_DATE THEN 'upcoming'
               ELSE 'open'
             END
         WHERE id = $2 RETURNING *`,
        [teacherId, request.params.id]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Competition not found' });
      await notify(teacherId, 'competition_judging_assigned', { competitionId: rows[0].id, title: rows[0].title, judgingDeadline: rows[0].judging_deadline });
      return rows[0];
    }
  );

  // ---- Student: submit an entry — never exposed via any student-facing profile endpoint ----
  app.post<{ Params: { id: string }; Body: SubmitEntryBody }>(
    '/:id/entries',
    { preHandler: [app.authenticate, app.requireRole('student')] },
    async (request, reply) => {
      const studentId = (request.user as AuthUser).id;
      const { imageStorageKey, originalFilename } = request.body;
      if (!imageStorageKey) return reply.code(400).send({ error: 'imageStorageKey is required' });

      const { rows: compRows } = await pool.query(`SELECT ${EFFECTIVE_COMPETITION_STATUS} AS status FROM competitions c WHERE c.id = $1`, [
        request.params.id,
      ]);
      if (!compRows[0]) return reply.code(404).send({ error: 'Competition not found' });
      if (compRows[0].status !== 'open' && compRows[0].status !== 'upcoming') {
        return reply.code(409).send({ error: 'This competition is no longer accepting entries' });
      }

      const { rows } = await pool.query(
        `INSERT INTO competition_entries (competition_id, student_id, image_storage_key)
         VALUES ($1, $2, $3) RETURNING *`,
        [request.params.id, studentId, imageStorageKey]
      );
      await notifyAllAdmins('competition_entry_received', { competitionId: request.params.id, entryId: rows[0].id });
      return reply.code(201).send(rows[0]);
    }
  );

  // ---- Judge (while assigned) or admin: view entries for judging ----
  // Entries disappear from the JUDGE's view the moment winners are submitted
  // (status leaves 'judging') — they remain visible to admin permanently.
  app.get<{ Params: { id: string } }>('/:id/entries', { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = request.user as AuthUser;
    const { rows: compRows } = await pool.query(
      `SELECT judge_teacher_id, ${EFFECTIVE_COMPETITION_STATUS} AS status
       FROM competitions c WHERE c.id = $1`,
      [request.params.id]
    );
    const comp = compRows[0];
    if (!comp) return reply.code(404).send({ error: 'Competition not found' });

    const isAssignedJudge = comp.judge_teacher_id === user.id;
    if (user.role === 'teacher') {
      if (!isAssignedJudge) return reply.code(403).send({ error: 'You are not the assigned judge' });
      if (comp.status !== 'judging') {
        return reply.code(403).send({ error: 'Judging is closed for this competition' });
      }
    } else if (user.role !== 'admin') {
      return reply.code(403).send({ error: 'Not authorized' });
    }

    const { rows } = await pool.query(
      `SELECT ce.*, u.name AS student_name, u.branch_id AS student_branch_id
       FROM competition_entries ce JOIN users u ON u.id = ce.student_id
       WHERE ce.competition_id = $1 ORDER BY ce.submitted_at`,
      [request.params.id]
    );
    return rows;
  });

  // ---- Judge: submit winners — this is "judge submits to admin," not the public announcement ----
  app.post<{ Params: { id: string }; Body: SubmitWinnersBody }>(
    '/:id/submit-winners',
    { preHandler: [app.authenticate, app.requireRole('teacher', 'admin')] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      const judgeId = user.id;
      const { winners } = request.body;
      if (!Array.isArray(winners) || winners.length === 0) {
        return reply.code(400).send({ error: 'winners must be a non-empty array' });
      }

      const { rows: compRows } = await pool.query(
        `SELECT c.id, c.title, c.judge_teacher_id, ${EFFECTIVE_COMPETITION_STATUS} AS status
         FROM competitions c WHERE c.id = $1`,
        [request.params.id]
      );
      const comp = compRows[0];
      if (!comp) return reply.code(404).send({ error: 'Competition not found' });
      if (user.role !== 'admin' && comp.judge_teacher_id !== judgeId) return reply.code(403).send({ error: 'You are not the assigned judge' });
      if (comp.status !== 'judging') return reply.code(409).send({ error: 'This competition is not open for judging' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const w of winners) {
          const { rows: entryRows } = await client.query(
            `SELECT student_id FROM competition_entries WHERE id = $1 AND competition_id = $2`,
            [w.competitionEntryId, request.params.id]
          );
          if (!entryRows[0]) throw new Error(`Entry ${w.competitionEntryId} does not belong to this competition`);
          await client.query(
            `INSERT INTO competition_winners (competition_id, competition_entry_id, student_id, rank)
             VALUES ($1, $2, $3, $4)`,
            [request.params.id, w.competitionEntryId, entryRows[0].student_id, w.rank]
          );
        }
        await client.query(`UPDATE competitions SET status = 'completed' WHERE id = $1`, [request.params.id]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        request.log.error(err);
        return reply.code(400).send({ error: 'Failed to record winners — check the entry IDs given' });
      } finally {
        client.release();
      }

      await notifyAllAdmins('competition_results_ready', { competitionId: request.params.id, title: comp.title, judgeId });

      return { status: 'completed', message: 'Winners recorded. Awaiting admin publish.' };
    }
  );

  // ---- Admin: the actual public announcement ----
  app.post<{ Params: { id: string } }>(
    '/:id/publish-results',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { rows } = await pool.query(
        `UPDATE competitions
         SET results_published_at = now()
         WHERE id = $1 AND status = 'completed'
         RETURNING *`,
        [request.params.id]
      );

      if (!rows[0]) {
        return reply.code(409).send({
          error: 'Competition not found, or winners have not been submitted yet',
        });
      }

      const { rows: entryStudents } = await pool.query(
        `SELECT DISTINCT student_id
         FROM competition_entries
         WHERE competition_id = $1`,
        [request.params.id]
      );

      for (const row of entryStudents) {
        await notify(row.student_id, 'competition_results', {
          competitionId: request.params.id,
          title: rows[0].title,
        });
      }

      return rows[0];
    }
  );
}
