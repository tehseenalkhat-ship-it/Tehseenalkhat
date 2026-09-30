import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { getDownloadUrl } from '../storage.js';

type AuthUser = {
  id: string;
  role: string;
};

export async function badgeRoutes(app: FastifyInstance) {
  app.get('/assets', { preHandler: [app.authenticate] }, async () => {
    const { rows } = await pool.query(`SELECT value FROM site_settings WHERE key = 'badge_assets'`);
    const assets = rows[0]?.value && typeof rows[0].value === 'object' ? rows[0].value as Record<string, { storageKey: string; filename: string; mediaType: 'image' | 'pdf' }> : {};
    return Promise.all(Object.entries(assets).map(async ([key, asset]) => ({
      key,
      filename: asset.filename,
      mediaType: asset.mediaType,
      url: await getDownloadUrl(asset.storageKey).catch(() => null),
    })));
  });

  app.get(
    '/',
    {
      preHandler: [
        app.authenticate,
        app.requireRole('student'),
      ],
    },
    async (request) => {
      const studentId = (request.user as AuthUser).id;

      const { rows } = await pool.query(
        `SELECT
           b.id,
           b.student_id,
           b.khat_type_id,
           b.tier,
           b.awarded_at,
           kt.code AS khat_type_code,
           kt.display_name AS khat_type_name
         FROM badges b
         JOIN khat_types kt ON kt.id = b.khat_type_id
         WHERE b.student_id = $1
         ORDER BY b.awarded_at DESC`,
        [studentId]
      );

      return rows;
    }
  );
}