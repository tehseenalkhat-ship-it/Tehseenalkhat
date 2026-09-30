import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';

type CreateNotificationBody = { type: string; payload?: Record<string, unknown> };

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/unread-count', { preHandler: [app.authenticate] }, async (request) => {
    const userId = (request.user as AuthUser).id;
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read = false`,
      [userId]
    );
    return { count: Number(rows[0]?.count ?? 0) };
  });

  app.post<{ Body: CreateNotificationBody }>(
    '/',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { type, payload = {} } = request.body ?? {};
      if (type !== 'theme_changed') return reply.code(400).send({ error: 'Unsupported notification type' });
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return reply.code(400).send({ error: 'payload must be an object' });
      }
      const theme = payload.theme;
      if (theme !== 'blue' && theme !== 'green' && theme !== 'gold' && theme !== 'maroon') {
        return reply.code(400).send({ error: 'A valid theme is required' });
      }
      const userId = (request.user as AuthUser).id;
      const { rows } = await pool.query(
        `INSERT INTO notifications (user_id, type, payload) VALUES ($1, $2, $3) RETURNING *`,
        [userId, type, JSON.stringify({ theme })]
      );
      return reply.code(201).send(rows[0]);
    }
  );

  app.get('/', { preHandler: [app.authenticate] }, async (request) => {
    const userId = (request.user as AuthUser).id;
    const { rows } = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY read ASC, created_at DESC LIMIT 100`,
      [userId]
    );
    return rows;
  });

  app.patch<{ Params: { id: string } }>(
    '/:id/read',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const userId = (request.user as AuthUser).id;
      const { rows } = await pool.query(
        `UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING *`,
        [request.params.id, userId]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Notification not found' });
      return rows[0];
    }
  );

  app.patch('/read-all', { preHandler: [app.authenticate] }, async (request) => {
    const userId = (request.user as AuthUser).id;
    await pool.query(`UPDATE notifications SET read = true WHERE user_id = $1 AND read = false`, [userId]);
    return { success: true };
  });
}
