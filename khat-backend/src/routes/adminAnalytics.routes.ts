import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';

export async function adminAnalyticsRoutes(app: FastifyInstance) {
  app.get('/statistics', { preHandler: [app.authenticate, app.requireRole('admin')] }, async () => {
    const [summary, activityTrend, branchEnrollment, entryStatuses, teacherThroughput, competitionParticipation] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE role = 'student' AND deleted_at IS NULL)::int AS students,
           (SELECT COUNT(*) FROM users WHERE role = 'teacher' AND deleted_at IS NULL)::int AS teachers,
           (SELECT COUNT(*) FROM users WHERE role = 'admin' AND deleted_at IS NULL)::int AS admins,
           (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL)::int AS total_users,
           (SELECT COUNT(DISTINCT user_id) FROM activity_log WHERE activity_date >= DATE_SUB(CURRENT_DATE, INTERVAL 30 DAY))::int AS active_users_30d,
           (SELECT COALESCE(SUM(login_count), 0)::int FROM activity_log) AS total_logins,
           (SELECT COALESCE(SUM(login_count), 0)::int FROM activity_log WHERE activity_date = CURRENT_DATE) AS logins_today,
           (SELECT COUNT(*) FROM entries)::int AS entries_submitted,
           (SELECT COUNT(*) FROM entries WHERE status IN ('reviewed', 'redo_needed'))::int AS entries_reviewed,
           (SELECT COUNT(*) FROM entries WHERE status = 'pending')::int AS entries_pending,
           (SELECT COUNT(*) FROM entries WHERE status = 'assigned')::int AS entries_assigned,
           (SELECT COUNT(*) FROM entries WHERE status = 'in_review')::int AS entries_in_review,
           (SELECT COUNT(*) FROM entries WHERE status = 'redo_needed')::int AS entries_needing_redo,
           (SELECT COUNT(*) FROM certificates WHERE status = 'approved')::int AS certificates_approved,
           (SELECT COUNT(*) FROM certificates WHERE status = 'pending')::int AS certificates_pending,
           (SELECT COUNT(*) FROM showcase_posts WHERE status = 'approved')::int AS showcase_approved,
           (SELECT COUNT(*) FROM showcase_posts WHERE status = 'pending')::int AS showcase_pending,
           (SELECT COUNT(*) FROM competitions)::int AS competitions_total,
           (SELECT COUNT(*) FROM competitions WHERE status IN ('open', 'upcoming', 'judging'))::int AS competitions_active,
           (SELECT COUNT(*) FROM competition_entries)::int AS competition_entries,
           (SELECT COUNT(*) FROM live_events)::int AS events_total,
           (SELECT COUNT(*) FROM live_events WHERE status = 'live')::int AS events_live,
           (SELECT COUNT(*) FROM event_attendance WHERE joined_at IS NOT NULL)::int AS live_attendance,
           (SELECT COUNT(*) FROM event_attendance WHERE watched_recording = true)::int AS recording_views,
           (SELECT COUNT(*) FROM books)::int AS books_total,
           (SELECT COUNT(*) FROM courses)::int AS courses_total,
           (SELECT COUNT(*) FROM level_submissions)::int AS practice_submissions`
      ),
      pool.query(
        `WITH RECURSIVE months AS (
           SELECT DATE_SUB(CAST(DATE_FORMAT(CURRENT_DATE, '%Y-%m-01') AS DATE), INTERVAL 11 MONTH) AS month_start
           UNION ALL
           SELECT DATE_ADD(month_start, INTERVAL 1 MONTH)
           FROM months
           WHERE month_start < CAST(DATE_FORMAT(CURRENT_DATE, '%Y-%m-01') AS DATE)
         ), logins AS (
           SELECT CAST(DATE_FORMAT(activity_date, '%Y-%m-01') AS DATE) AS month_start,
                  COALESCE(SUM(login_count), 0)::int AS logins,
                  COUNT(DISTINCT user_id)::int AS active_users
           FROM activity_log
           WHERE activity_date >= DATE_SUB(CAST(DATE_FORMAT(CURRENT_DATE, '%Y-%m-01') AS DATE), INTERVAL 11 MONTH)
           GROUP BY month_start
         ), submissions AS (
           SELECT CAST(DATE_FORMAT(created_at, '%Y-%m-01') AS DATE) AS month_start, COUNT(*)::int AS submitted
           FROM entries
           WHERE created_at >= DATE_SUB(CAST(DATE_FORMAT(CURRENT_DATE, '%Y-%m-01') AS DATE), INTERVAL 11 MONTH)
           GROUP BY month_start
         ), reviews AS (
           SELECT CAST(DATE_FORMAT(reviewed_at, '%Y-%m-01') AS DATE) AS month_start, COUNT(*)::int AS reviewed
           FROM entries
           WHERE reviewed_at >= DATE_SUB(CAST(DATE_FORMAT(CURRENT_DATE, '%Y-%m-01') AS DATE), INTERVAL 11 MONTH)
           GROUP BY month_start
         )
         SELECT DATE_FORMAT(m.month_start, '%Y-%m') AS month,
                COALESCE(l.logins, 0)::int AS logins,
                COALESCE(l.active_users, 0)::int AS active_users,
                COALESCE(s.submitted, 0)::int AS submitted,
                COALESCE(r.reviewed, 0)::int AS reviewed
         FROM months m
         LEFT JOIN logins l USING (month_start)
         LEFT JOIN submissions s USING (month_start)
         LEFT JOIN reviews r USING (month_start)
         ORDER BY m.month_start`
      ),
      pool.query(
        `SELECT b.id, b.name, COUNT(u.id)::int AS students
         FROM branches b
         LEFT JOIN users u ON u.branch_id = b.id AND u.role = 'student' AND u.deleted_at IS NULL
         GROUP BY b.id, b.name ORDER BY b.name`
      ),
      pool.query(`SELECT status, COUNT(*)::int AS count FROM entries GROUP BY status ORDER BY status`),
      pool.query(
        `SELECT u.id, u.name, COUNT(e.id)::int AS reviewed
         FROM users u
         LEFT JOIN entries e ON e.reviewed_by = u.id AND e.reviewed_at IS NOT NULL
         WHERE u.role = 'teacher' AND u.deleted_at IS NULL
         GROUP BY u.id, u.name ORDER BY reviewed DESC, u.name`
      ),
      pool.query(
        `SELECT c.id, c.title, COUNT(ce.id)::int AS entries
         FROM competitions c
         LEFT JOIN competition_entries ce ON ce.competition_id = c.id
         GROUP BY c.id, c.title ORDER BY c.start_date DESC`
      ),
    ]);

    return {
      summary: summary.rows[0],
      activityTrend: activityTrend.rows,
      branchEnrollment: branchEnrollment.rows,
      entryStatuses: entryStatuses.rows,
      teacherThroughput: teacherThroughput.rows,
      competitionParticipation: competitionParticipation.rows,
    };
  });
}