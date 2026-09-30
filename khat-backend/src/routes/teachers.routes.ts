import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';

export async function teacherProfileRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { months?: string } }>(
    '/me/branch-stats',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const requester = request.user as AuthUser;
      if (requester.role !== 'teacher' || !requester.isCoordinator) {
        return reply.code(403).send({ error: 'Branch statistics are available to coordinators only' });
      }

      const parsedMonths = Number.parseInt(request.query.months ?? '12', 10);
      const months = Number.isFinite(parsedMonths) ? Math.min(24, Math.max(3, parsedMonths)) : 12;
      const branchId = requester.branchId;

      const [summary, activityTrend, entryTrend, eventTrend, entryStatuses, teacherThroughput, studentProgress] = await Promise.all([
        pool.query(
          `SELECT b.id AS "branchId", b.name AS "branchName",
             (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND u.role = 'student' AND u.deleted_at IS NULL)::int AS "studentCount",
             (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND u.role = 'teacher' AND u.deleted_at IS NULL)::int AS "teacherCount",
             (SELECT COUNT(DISTINCT al.user_id) FROM activity_log al JOIN users u ON u.id = al.user_id
               WHERE u.branch_id = b.id AND u.role = 'student' AND u.deleted_at IS NULL
                 AND al.activity_date >= CURRENT_DATE - INTERVAL '30 days')::int AS "activeStudents30d",
             (SELECT COUNT(*) FROM entries e JOIN users s ON s.id = e.student_id
               WHERE s.branch_id = b.id AND s.role = 'student' AND s.deleted_at IS NULL)::int AS "totalEntries",
             (SELECT COUNT(*) FROM entries e JOIN users s ON s.id = e.student_id
               WHERE s.branch_id = b.id AND s.role = 'student' AND s.deleted_at IS NULL
                 AND e.status IN ('reviewed', 'redo_needed'))::int AS "reviewedEntries",
             (SELECT COUNT(*) FROM entries e JOIN users s ON s.id = e.student_id
               WHERE s.branch_id = b.id AND s.role = 'student' AND s.deleted_at IS NULL
                 AND e.status IN ('pending', 'assigned', 'in_review'))::int AS "openEntries",
             (SELECT AVG(EXTRACT(EPOCH FROM (e.reviewed_at - e.locked_at)) / 3600)
               FROM entries e JOIN users s ON s.id = e.student_id
               WHERE s.branch_id = b.id AND s.role = 'student' AND s.deleted_at IS NULL
                 AND e.reviewed_at IS NOT NULL AND e.locked_at IS NOT NULL) AS "avgResponseHours",
             (SELECT COALESCE(SUM(ls.time_spent_minutes), 0)::int FROM level_submissions ls
               JOIN users s ON s.id = ls.student_id
               WHERE s.branch_id = b.id AND s.role = 'student' AND s.deleted_at IS NULL) AS "practiceMinutes",
             (SELECT AVG(en.percent_complete) FROM enrollments en
               JOIN users s ON s.id = en.student_id
               WHERE s.branch_id = b.id AND s.role = 'student' AND s.deleted_at IS NULL) AS "averageProgress",
             (SELECT COUNT(*) FROM live_events le WHERE le.branch_id = b.id)::int AS "eventCount",
             (SELECT COUNT(*) FROM live_events le WHERE le.branch_id = b.id AND le.status = 'scheduled')::int AS "scheduledEvents",
             (SELECT COUNT(*) FROM live_events le WHERE le.branch_id = b.id AND le.status = 'live')::int AS "liveEvents",
             (SELECT COUNT(*) FROM live_events le WHERE le.branch_id = b.id AND le.status = 'ended')::int AS "endedEvents"
           FROM branches b WHERE b.id = $1`,
          [branchId]
        ),
        pool.query(
          `WITH months AS (
             SELECT generate_series(
               date_trunc('month', CURRENT_DATE) - (($1::int - 1) * INTERVAL '1 month'),
               date_trunc('month', CURRENT_DATE), INTERVAL '1 month'
             ) AS month_start
           ), activity AS (
             SELECT date_trunc('month', al.activity_date) AS month_start,
                    COUNT(DISTINCT u.id)::int AS active_students,
                    COALESCE(SUM(al.login_count), 0)::int AS logins
             FROM activity_log al JOIN users u ON u.id = al.user_id
             WHERE u.branch_id = $2 AND u.role = 'student' AND u.deleted_at IS NULL
               AND al.activity_date >= (SELECT MIN(month_start) FROM months)
             GROUP BY date_trunc('month', al.activity_date)
           )
           SELECT to_char(m.month_start, 'YYYY-MM') AS month,
                  COALESCE(a.active_students, 0)::int AS "activeStudents",
                  COALESCE(a.logins, 0)::int AS logins
           FROM months m LEFT JOIN activity a USING (month_start) ORDER BY m.month_start`,
          [months, branchId]
        ),
        pool.query(
          `WITH months AS (
             SELECT generate_series(
               date_trunc('month', CURRENT_DATE) - (($1::int - 1) * INTERVAL '1 month'),
               date_trunc('month', CURRENT_DATE), INTERVAL '1 month'
             ) AS month_start
           ), submitted AS (
             SELECT date_trunc('month', e.created_at) AS month_start, COUNT(*)::int AS count
             FROM entries e JOIN users s ON s.id = e.student_id
             WHERE s.branch_id = $2 AND s.role = 'student' AND s.deleted_at IS NULL
               AND e.created_at >= (SELECT MIN(month_start) FROM months)
             GROUP BY date_trunc('month', e.created_at)
           ), reviewed AS (
             SELECT date_trunc('month', e.reviewed_at) AS month_start, COUNT(*)::int AS count
             FROM entries e JOIN users s ON s.id = e.student_id
             WHERE s.branch_id = $2 AND s.role = 'student' AND s.deleted_at IS NULL
               AND e.reviewed_at >= (SELECT MIN(month_start) FROM months)
             GROUP BY date_trunc('month', e.reviewed_at)
           )
           SELECT to_char(m.month_start, 'YYYY-MM') AS month,
                  COALESCE(s.count, 0)::int AS submitted,
                  COALESCE(r.count, 0)::int AS reviewed
           FROM months m LEFT JOIN submitted s USING (month_start)
             LEFT JOIN reviewed r USING (month_start)
           ORDER BY m.month_start`,
          [months, branchId]
        ),
        pool.query(
          `WITH months AS (
             SELECT generate_series(
               date_trunc('month', CURRENT_DATE) - (($1::int - 1) * INTERVAL '1 month'),
               date_trunc('month', CURRENT_DATE), INTERVAL '1 month'
             ) AS month_start
           ), events AS (
             SELECT date_trunc('month', le.scheduled_at) AS month_start, COUNT(*)::int AS count
             FROM live_events le
             WHERE le.branch_id = $2 AND le.scheduled_at >= (SELECT MIN(month_start) FROM months)
             GROUP BY date_trunc('month', le.scheduled_at)
           )
           SELECT to_char(m.month_start, 'YYYY-MM') AS month, COALESCE(e.count, 0)::int AS events
           FROM months m LEFT JOIN events e USING (month_start) ORDER BY m.month_start`,
          [months, branchId]
        ),
        pool.query(
          `SELECT e.status, COUNT(*)::int AS count
           FROM entries e JOIN users s ON s.id = e.student_id
           WHERE s.branch_id = $1 AND s.role = 'student' AND s.deleted_at IS NULL
           GROUP BY e.status ORDER BY e.status`,
          [branchId]
        ),
        pool.query(
          `SELECT t.id, t.name, COUNT(e.id)::int AS "entriesReviewed",
                  AVG(EXTRACT(EPOCH FROM (e.reviewed_at - e.locked_at)) / 3600) AS "avgResponseHours"
           FROM users t
           LEFT JOIN entries e ON e.reviewed_by = t.id AND e.reviewed_at IS NOT NULL
             AND EXISTS (SELECT 1 FROM users s WHERE s.id = e.student_id AND s.branch_id = $1
               AND s.role = 'student' AND s.deleted_at IS NULL)
           WHERE t.branch_id = $1 AND t.role = 'teacher' AND t.deleted_at IS NULL
           GROUP BY t.id, t.name ORDER BY COUNT(e.id) DESC, t.name`,
          [branchId]
        ),
        pool.query(
          `SELECT bucket, COUNT(*)::int AS students FROM (
             SELECT CASE
               WHEN en.percent_complete < 25 THEN '0–24%'
               WHEN en.percent_complete < 50 THEN '25–49%'
               WHEN en.percent_complete < 75 THEN '50–74%'
               ELSE '75–100%'
             END AS bucket,
             CASE
               WHEN en.percent_complete < 25 THEN 1
               WHEN en.percent_complete < 50 THEN 2
               WHEN en.percent_complete < 75 THEN 3
               ELSE 4
             END AS bucket_order
             FROM enrollments en JOIN users s ON s.id = en.student_id
             WHERE s.branch_id = $1 AND s.role = 'student' AND s.deleted_at IS NULL
           ) progress GROUP BY bucket, bucket_order ORDER BY bucket_order`,
          [branchId]
        ),
      ]);

      if (!summary.rows[0]) return reply.code(404).send({ error: 'Coordinator branch not found' });
      return {
        summary: summary.rows[0],
        activityTrend: activityTrend.rows,
        entryTrend: entryTrend.rows,
        eventTrend: eventTrend.rows,
        entryStatuses: entryStatuses.rows,
        teacherThroughput: teacherThroughput.rows,
        studentProgress: studentProgress.rows,
      };
    }
  );

  app.get<{ Params: { id: string } }>('/:id/profile', { preHandler: [app.authenticate] }, async (request, reply) => {
    const requester = request.user as AuthUser;

    const { rows: teacherRows } = await pool.query(
      `SELECT id, name, branch_id, is_coordinator, entry_load_threshold, photo_storage_key, created_at, role
       FROM users WHERE id = $1 AND (role = 'teacher' OR (role = 'admin' AND id = $2)) AND deleted_at IS NULL`,
      [request.params.id, requester.id]
    );
    const teacher = teacherRows[0];
    if (!teacher) return reply.code(404).send({ error: 'Teacher not found' });

    const isSelf = requester.id === teacher.id;
    const isAdmin = requester.role === 'admin';
    const isCoordinatorOfSameBranch =
      requester.role === 'teacher' && requester.isCoordinator && requester.branchId === teacher.branch_id;
    if (!isSelf && !isAdmin && !isCoordinatorOfSameBranch) {
      return reply.code(403).send({ error: 'Not authorized to view this profile' });
    }

    const [scripts, showcasePosts, activity, reviewStats] = await Promise.all([
      pool.query(
        `SELECT kt.code, kt.display_name FROM teacher_khat_assignments tka
         JOIN khat_types kt ON kt.id = tka.khat_type_id WHERE tka.teacher_id = $1`,
        [teacher.id]
      ),
      pool.query(
        `SELECT p.*, u.name AS author_name, b.name AS branch_name
         FROM showcase_posts p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN branches b ON b.id = u.branch_id
         WHERE p.user_id = $1 ORDER BY p.created_at DESC`,
        [teacher.id]
      ),
      pool.query(`SELECT activity_date, login_count FROM activity_log WHERE user_id = $1 ORDER BY activity_date`, [
        teacher.id,
      ]),
      pool.query(
        `SELECT
           COUNT(e.id)::int AS total_reviewed,
           AVG(EXTRACT(EPOCH FROM (e.reviewed_at - e.locked_at)) / 3600) AS avg_response_hours,
           COUNT(*) FILTER (WHERE e.is_diverted = true)::int AS escalated_away_count
         FROM entries e
         JOIN users s ON s.id = e.student_id
         WHERE e.reviewed_by = $1
           AND ($3::boolean OR s.branch_id = $2)
           AND s.role = 'student'
           AND s.deleted_at IS NULL`,
        [teacher.id, teacher.branch_id, isAdmin]
      ),
    ]);

    return {
      id: teacher.id,
      name: teacher.name,
      branchId: teacher.branch_id,
      photoStorageKey: teacher.photo_storage_key,
      isCoordinator: teacher.is_coordinator,
      entryLoadThreshold: teacher.entry_load_threshold,
      assignedScripts: scripts.rows,
      showcasePosts: showcasePosts.rows,
      activity: activity.rows,
      totalReviewed: Number(reviewStats.rows[0].total_reviewed),
      avgResponseHours: reviewStats.rows[0].avg_response_hours ? Number(reviewStats.rows[0].avg_response_hours) : null,
      escalatedAwayCount: Number(reviewStats.rows[0].escalated_away_count),
    };
  });

  app.patch<{ Params: { id: string }; Body: { photoStorageKey: string } }>(
    '/:id/photo',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const requester = request.user as AuthUser;
      if (requester.id !== request.params.id && requester.role !== 'admin') {
        return reply.code(403).send({ error: 'You can only update your own photo' });
      }

      const { photoStorageKey } = request.body;
      if (!photoStorageKey) return reply.code(400).send({ error: 'photoStorageKey is required' });

      const { rows } = await pool.query(
        `UPDATE users SET photo_storage_key = $1 WHERE id = $2 AND role = 'teacher' AND deleted_at IS NULL RETURNING id`,
        [photoStorageKey, request.params.id]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Teacher not found' });

      return { success: true, photoStorageKey };
    }
  );
}
