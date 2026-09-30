import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';
import { notifyAllStudents } from '../services/notify.js';

type CreateBookBody = { title: string; khatTypeId?: string; fileStorageKey: string; originalFilename?: string };

export async function bookRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateBookBody }>(
    '/',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { title, khatTypeId, fileStorageKey, originalFilename } = request.body;
      if (!title || !fileStorageKey) return reply.code(400).send({ error: 'title and fileStorageKey are required' });

      const adminId = (request.user as AuthUser).id;
      const { rows } = await pool.query(
        `INSERT INTO books (title, khat_type_id, file_storage_key, original_filename, uploaded_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [title, khatTypeId ?? null, fileStorageKey, originalFilename ?? null, adminId]
      );
      await notifyAllStudents('resource_added', { bookId: rows[0].id, title });
      return reply.code(201).send(rows[0]);
    }
  );

  app.get<{ Querystring: { khatTypeId?: string } }>('/', { preHandler: [app.authenticate] }, async (request) => {
    const { khatTypeId } = request.query;
    const params: unknown[] = [];
    let where = '';
    if (khatTypeId) {
      params.push(khatTypeId);
      where = `WHERE khat_type_id = $1`;
    }
    const { rows } = await pool.query(`SELECT * FROM books ${where} ORDER BY created_at DESC`, params);
    return rows;
  });

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { rows } = await pool.query(`DELETE FROM books WHERE id = $1 RETURNING id, title`, [request.params.id]);
      if (!rows[0]) return reply.code(404).send({ error: 'Book not found' });
      await notifyAllStudents('resource_removed', { bookId: rows[0].id, title: rows[0].title });
      return reply.code(204).send();
    }
  );
}
