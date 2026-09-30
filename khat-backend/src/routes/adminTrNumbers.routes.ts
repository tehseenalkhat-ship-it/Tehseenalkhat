import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';

type BulkImportBody = { trNumbers: string[]; branchId?: string };

export async function adminTrNumberRoutes(app: FastifyInstance) {
  // ---- Bulk import — safe to re-run, duplicates are silently skipped ----
  app.post<{ Body: BulkImportBody }>(
    '/',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { trNumbers, branchId } = request.body;
      if (!Array.isArray(trNumbers) || trNumbers.length === 0) {
        return reply.code(400).send({ error: 'trNumbers must be a non-empty array' });
      }
      if (trNumbers.length > 10_000) {
        return reply.code(413).send({ error: 'Import at most 10,000 TR numbers at a time' });
      }

      const normalized = trNumbers.map(value => typeof value === 'string' ? value.trim().toUpperCase() : '');
      if (normalized.some(value => !value || value.length > 50 || !/[0-9]/.test(value) || !/^[A-Z0-9-]+$/.test(value))) {
        return reply.code(400).send({ error: 'Every TR number must contain a digit and use only letters, numbers, or hyphens' });
      }

      const uniqueNumbers = [...new Set(normalized)];
      let imported = 0;
      // Keep each insert comfortably below MySQL's packet/placeholder limits.
      for (let offset = 0; offset < uniqueNumbers.length; offset += 500) {
        const batch = uniqueNumbers.slice(offset, offset + 500);
        const placeholders = batch.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(', ');
        const values = batch.flatMap(trNumber => [trNumber, branchId ?? null]);
        const { rowCount } = await pool.query(
          `INSERT INTO approved_tr_numbers (tr_number, branch_id) VALUES ${placeholders}
           ON CONFLICT DO NOTHING`,
          values
        );
        imported += rowCount;
      }
      return reply.code(201).send({ imported, skipped: trNumbers.length - imported });
    }
  );

  // ---- List, with status (unused/claimed) ----
  app.get<{ Querystring: { branchId?: string; used?: string } }>(
    '/',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request) => {
      const { branchId, used } = request.query;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (branchId) {
        params.push(branchId);
        conditions.push(`branch_id = $${params.length}`);
      }
      if (used !== undefined) {
        params.push(used === 'true');
        conditions.push(`used = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await pool.query(
        `SELECT * FROM approved_tr_numbers ${where} ORDER BY imported_at DESC`,
        params
      );
      return rows;
    }
  );

  app.delete<{ Params: { trNumber: string } }>(
    '/:trNumber',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { rowCount } = await pool.query(
        `DELETE FROM approved_tr_numbers WHERE tr_number = $1 AND used = false`,
        [request.params.trNumber]
      );
      if (!rowCount) {
        return reply.code(404).send({ error: 'Not found, or it has already been used and cannot be removed' });
      }
      return reply.code(204).send();
    }
  );
}
