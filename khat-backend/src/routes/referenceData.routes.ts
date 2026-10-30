import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';

export async function referenceDataRoutes(app: FastifyInstance) {
  app.get('/branches', async () => {
    const { rows } = await pool.query(`SELECT id, name FROM branches ORDER BY name`);
    return rows;
  });

  app.get('/khat-types', async () => {
    const { rows } = await pool.query(
      `SELECT id, code,
              CASE WHEN code = 'naskh_normal_pen' THEN 'Naskh (Normal Pen)' ELSE display_name END AS display_name
       FROM khat_types ORDER BY display_name`
    );
    return rows;
  });
}
