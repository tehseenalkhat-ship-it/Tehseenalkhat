import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { deleteObject } from '../storage.js';

type UpdateSettingBody = { value: unknown };
type BadgeAssetBody = { storageKey: string; filename: string; mediaType: 'image' | 'pdf' };
const BADGE_TIERS = ['foundation', 'composition', 'mastery', 'ijazah'] as const;

function badgeAssetKey(khatTypeId: string, tier: string): string {
  return `${khatTypeId}:${tier}`;
}

export async function adminSettingsRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [app.authenticate, app.requireRole('admin')] }, async () => {
    const { rows } = await pool.query(`SELECT * FROM site_settings ORDER BY key`);
    return rows;
  });

  app.put<{ Params: { key: string }; Body: UpdateSettingBody }>(
    '/:key',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { value } = request.body;
      if (value === undefined) return reply.code(400).send({ error: 'value is required' });

      await pool.query(
        `INSERT INTO site_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [request.params.key, JSON.stringify(value)]
      );
      const { rows } = await pool.query('SELECT * FROM site_settings WHERE key = $1', [request.params.key]);
      return rows[0];
    }
  );

  app.put<{ Params: { khatTypeId: string; tier: string }; Body: BadgeAssetBody }>(
    '/badges/:khatTypeId/:tier',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { khatTypeId, tier } = request.params;
      const { storageKey, filename, mediaType } = request.body;
      if (!BADGE_TIERS.includes(tier as (typeof BADGE_TIERS)[number])) {
        return reply.code(400).send({ error: `tier must be one of: ${BADGE_TIERS.join(', ')}` });
      }
      if (!storageKey?.startsWith('badge-assets/') || !filename || !['image', 'pdf'].includes(mediaType)) {
        return reply.code(400).send({ error: 'A badge-assets storage key, filename, and image/pdf mediaType are required' });
      }
      const { rows: khatRows } = await pool.query('SELECT id FROM khat_types WHERE id = $1', [khatTypeId]);
      if (!khatRows[0]) return reply.code(404).send({ error: 'Khat type not found' });

      const { rows: currentRows } = await pool.query(`SELECT value FROM site_settings WHERE key = 'badge_assets'`);
      const assets = currentRows[0]?.value && typeof currentRows[0].value === 'object' ? currentRows[0].value as Record<string, unknown> : {};
      const key = badgeAssetKey(khatTypeId, tier);
      const previous = assets[key] as { storageKey?: string } | undefined;
      assets[key] = { storageKey, filename, mediaType };
      await pool.query(
        `INSERT INTO site_settings (key, value) VALUES ('badge_assets', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
        [JSON.stringify(assets)]
      );
      if (previous?.storageKey && previous.storageKey !== storageKey) {
        await deleteObject(previous.storageKey).catch(err => request.log.warn({ err }, 'Could not remove replaced badge artwork'));
      }
      return { key, ...assets[key] as object };
    }
  );

  app.delete<{ Params: { khatTypeId: string; tier: string } }>(
    '/badges/:khatTypeId/:tier',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { khatTypeId, tier } = request.params;
      if (!BADGE_TIERS.includes(tier as (typeof BADGE_TIERS)[number])) {
        return reply.code(400).send({ error: `tier must be one of: ${BADGE_TIERS.join(', ')}` });
      }
      const { rows } = await pool.query(`SELECT value FROM site_settings WHERE key = 'badge_assets'`);
      const assets = rows[0]?.value && typeof rows[0].value === 'object' ? rows[0].value as Record<string, unknown> : {};
      const key = badgeAssetKey(khatTypeId, tier);
      const previous = assets[key] as { storageKey?: string } | undefined;
      if (!previous) return reply.code(404).send({ error: 'No badge artwork is configured for this award' });
      delete assets[key];
      await pool.query(
        `INSERT INTO site_settings (key, value) VALUES ('badge_assets', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
        [JSON.stringify(assets)]
      );
      if (previous.storageKey) await deleteObject(previous.storageKey).catch(err => request.log.warn({ err }, 'Could not remove badge artwork file'));
      return reply.code(204).send();
    }
  );

}
