import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';
import { notifyAllTeachers } from '../services/notify.js';

type CreateAssetBody = {
  khatTypeId: string;
  title: string;
  tags?: string[];
  fileStorageKey: string;
  originalFilename?: string;
};
type UpdateAssetBody = { title?: string; tags?: string[] };

export async function assetRoutes(app: FastifyInstance) {
  // ---- Teacher/Admin: upload an asset ----
  // Deliberately NOT restricted by the uploader's assigned khat type(s) — a
  // teacher assigned to review Naskh only can still contribute or browse
  // Sulus/Nasta'līq references. That restriction is specific to entry review,
  // not the shared library.
  app.post<{ Body: CreateAssetBody }>(
    '/',
    { preHandler: [app.authenticate, app.requireRole('teacher', 'admin')] },
    async (request, reply) => {
      const { khatTypeId, title, tags, fileStorageKey, originalFilename } = request.body;
      if (!khatTypeId || !title || !fileStorageKey) {
        return reply.code(400).send({ error: 'khatTypeId, title, and fileStorageKey are required' });
      }
      const uploaderId = (request.user as AuthUser).id;
      const { rows } = await pool.query(
        `INSERT INTO assets (uploaded_by, khat_type_id, title, tags, file_storage_key, original_filename)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [uploaderId, khatTypeId, title, tags ?? [], fileStorageKey, originalFilename ?? null]
      );
      await notifyAllTeachers('asset_added', { assetId: rows[0].id, title }, uploaderId);
      return reply.code(201).send(rows[0]);
    }
  );

  // ---- Teacher/Admin: search + browse ----
  // ?q= does a full-text search (title + tags, via the trigger-maintained
  // search_vector); results rank by relevance when searching, otherwise by
  // newest first. ?khatTypeId= narrows to one script.
  app.get<{ Querystring: { q?: string; khatTypeId?: string } }>(
    '/',
    { preHandler: [app.authenticate, app.requireRole('teacher', 'admin')] },
    async (request) => {
      const { q, khatTypeId } = request.query;
      const params: unknown[] = [q ?? null, khatTypeId ?? null];

      const { rows } = await pool.query(
        `SELECT a.*, u.name AS uploader_name,
                CASE WHEN $1 IS NOT NULL AND a.title LIKE CONCAT('%', $1, '%') THEN 1 ELSE 0 END AS relevance
         FROM assets a
         JOIN users u ON u.id = a.uploaded_by
         WHERE ($1 IS NULL OR a.title LIKE CONCAT('%', $1, '%') OR CAST(a.tags AS CHAR) LIKE CONCAT('%', $1, '%'))
           AND ($2 IS NULL OR a.khat_type_id = $2)
         ORDER BY
           relevance DESC,
           a.created_at DESC`,
        params
      );
      return rows;
    }
  );

  app.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole('teacher', 'admin')] },
    async (request, reply) => {
      const { rows } = await pool.query(
        `SELECT a.*, u.name AS uploader_name FROM assets a JOIN users u ON u.id = a.uploaded_by WHERE a.id = $1`,
        [request.params.id]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Asset not found' });
      return rows[0];
    }
  );

  // ---- Owner or admin: edit title/tags ----
  app.put<{ Params: { id: string }; Body: UpdateAssetBody }>(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole('teacher', 'admin')] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      const { rows: existing } = await pool.query(`SELECT uploaded_by FROM assets WHERE id = $1`, [
        request.params.id,
      ]);
      if (!existing[0]) return reply.code(404).send({ error: 'Asset not found' });
      if (existing[0].uploaded_by !== user.id && user.role !== 'admin') {
        return reply.code(403).send({ error: 'You can only edit your own assets' });
      }

      const { title, tags } = request.body;
      const { rows } = await pool.query(
        `UPDATE assets SET title = COALESCE($1, title), tags = COALESCE($2, tags) WHERE id = $3 RETURNING *`,
        [title ?? null, tags ?? null, request.params.id]
      );
      return rows[0];
    }
  );

  // ---- Owner or admin: delete ----
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole('teacher', 'admin')] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      const { rows: existing } = await pool.query(`SELECT uploaded_by FROM assets WHERE id = $1`, [
        request.params.id,
      ]);
      if (!existing[0]) return reply.code(404).send({ error: 'Asset not found' });
      if (existing[0].uploaded_by !== user.id && user.role !== 'admin') {
        return reply.code(403).send({ error: 'You can only delete your own assets' });
      }

      await pool.query(`DELETE FROM assets WHERE id = $1`, [request.params.id]);
      return reply.code(204).send();
    }
  );
}
