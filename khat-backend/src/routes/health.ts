import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    const result = await pool.query('SELECT 1 as ok');
    return { status: 'ok', db: result.rows[0]?.ok === 1 };
  });
}
