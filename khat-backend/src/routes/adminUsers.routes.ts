import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { pool } from '../db.js';
import { notify } from '../services/notify.js';

type CreateStaffBody = {
  role: 'teacher' | 'admin';
  name: string;
  email: string;
  branchId: string;
  isCoordinator?: boolean;
  khatTypeIds?: string[]; // teachers only
};
type UpdateStaffBody = { name?: string; branchId?: string; isCoordinator?: boolean; entryLoadThreshold?: number };
type AssignKhatTypesBody = { khatTypeIds: string[] };

function generateTempPassword(): string {
  return randomBytes(9).toString('base64url'); // ~12 readable chars, no ambiguous symbols
}

export async function adminUserRoutes(app: FastifyInstance) {
  app.get('/me/profile', { preHandler: [app.authenticate, app.requireRole('admin')] }, async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT id, email, branch_id, photo_storage_key
       FROM users WHERE id = $1 AND role = 'admin' AND deleted_at IS NULL`,
      [(request.user as { id: string }).id]
    );
    const admin = rows[0];
    if (!admin) return reply.code(404).send({ error: 'Admin account not found' });
    return { id: admin.id, email: admin.email, branchId: admin.branch_id, photoStorageKey: admin.photo_storage_key };
  });

  app.patch<{ Body: { photoStorageKey: string } }>(
    '/me/photo',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { photoStorageKey } = request.body;
      if (!photoStorageKey) return reply.code(400).send({ error: 'photoStorageKey is required' });
      const adminId = (request.user as { id: string }).id;
      const { rows } = await pool.query(
        `UPDATE users SET photo_storage_key = $1 WHERE id = $2 AND role = 'admin' AND deleted_at IS NULL RETURNING id`,
        [photoStorageKey, adminId]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Admin account not found' });
      return { success: true, photoStorageKey };
    }
  );

  // ---- Create a staff account (teacher/coordinator/admin) ----
  // Returns the generated temporary password ONCE — same pattern as an API
  // token: it is never retrievable again, admin shares it with the new
  // staff member directly, who changes it on first login.
  app.post<{ Body: CreateStaffBody }>(
    '/',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { role, name, email, branchId, isCoordinator, khatTypeIds } = request.body;
      if (!role || !name || !email || !branchId) {
        return reply.code(400).send({ error: 'role, name, email, and branchId are required' });
      }
      if (role !== 'teacher' && role !== 'admin') {
        return reply.code(400).send({ error: "role must be 'teacher' or 'admin'" });
      }

      const tempPassword = generateTempPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO users (role, name, email, password_hash, branch_id, is_coordinator, must_change_password)
           VALUES ($1, $2, $3, $4, $5, $6, true)
           RETURNING id, role, name, email, branch_id, is_coordinator`,
          [role, name, email, passwordHash, branchId, Boolean(isCoordinator)]
        );
        const staff = rows[0];

        if (role === 'teacher' && khatTypeIds?.length) {
          for (const khatTypeId of khatTypeIds) {
            await client.query(
              `INSERT INTO teacher_khat_assignments (teacher_id, khat_type_id) VALUES ($1, $2)`,
              [staff.id, khatTypeId]
            );
          }
        }
        await client.query('COMMIT');
        return reply.code(201).send({ ...staff, tempPassword });
      } catch (err) {
        await client.query('ROLLBACK');
        request.log.error(err);
        return reply.code(400).send({ error: 'Failed to create account — that email may already be in use' });
      } finally {
        client.release();
      }
    }
  );

  // ---- List staff (teachers + admins) — admin sees everyone; a coordinator
  // only ever sees their own branch (enforced from their token, matching the
  // same pattern as the student directory listing) ----
  app.get<{ Querystring: { branchId?: string; role?: string } }>(
    '/',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as { id: string; role: string; branchId: string; isCoordinator: boolean };
      let branchFilter: string | null = null;

      if (user.role === 'admin') {
        branchFilter = request.query.branchId ?? null;
      } else if (user.role === 'teacher' && user.isCoordinator) {
        branchFilter = user.branchId; // coordinators cannot widen this to another branch
      } else {
        return reply.code(403).send({ error: 'Not authorized to list staff' });
      }

      const { role } = request.query;
      const conditions = [`role IN ('teacher', 'admin')`, `deleted_at IS NULL`];
      const params: unknown[] = [user.role === 'admin'];
      if (branchFilter) {
        params.push(branchFilter);
        conditions.push(`branch_id = $${params.length}`);
      }
      if (role) {
        params.push(role);
        conditions.push(`role = $${params.length}`);
      }
      const { rows } = await pool.query(
        `SELECT id, role, name, email, branch_id, is_coordinator, entry_load_threshold, created_at,
          CASE WHEN $1::boolean THEN photo_storage_key ELSE NULL END AS photo_storage_key
         FROM users WHERE ${conditions.join(' AND ')} ORDER BY name`,
        params
      );
      return rows;
    }
  );

  // ---- Update a staff account ----
  app.put<{ Params: { id: string }; Body: UpdateStaffBody }>(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { name, branchId, isCoordinator, entryLoadThreshold } = request.body;
      const { rows } = await pool.query(
        `UPDATE users SET
           name = COALESCE($1, name),
           branch_id = COALESCE($2, branch_id),
           is_coordinator = COALESCE($3, is_coordinator),
           entry_load_threshold = COALESCE($4, entry_load_threshold)
         WHERE id = $5 AND role IN ('teacher', 'admin') RETURNING id, role, name, email, branch_id, is_coordinator, entry_load_threshold`,
        [name ?? null, branchId ?? null, isCoordinator ?? null, entryLoadThreshold ?? null, request.params.id]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Staff account not found' });
      const changedFields = Object.keys(request.body ?? {}).filter(key => ['name', 'branchId', 'isCoordinator', 'entryLoadThreshold'].includes(key));
      if (changedFields.length) await notify(rows[0].id, 'profile_updated', { changedFields });
      return rows[0];
    }
  );

  // ---- Assign/reassign a teacher's khat type(s) — replaces the full set each time ----
  app.put<{ Params: { id: string }; Body: AssignKhatTypesBody }>(
    '/:id/khat-types',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { khatTypeIds } = request.body;
      if (!Array.isArray(khatTypeIds)) return reply.code(400).send({ error: 'khatTypeIds must be an array' });

      const adminId = (request.user as { id: string }).id;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM teacher_khat_assignments WHERE teacher_id = $1`, [request.params.id]);
        for (const khatTypeId of khatTypeIds) {
          await client.query(
            `INSERT INTO teacher_khat_assignments (teacher_id, khat_type_id, assigned_by) VALUES ($1, $2, $3)`,
            [request.params.id, khatTypeId, adminId]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        request.log.error(err);
        return reply.code(400).send({ error: 'Failed to update khat-type assignments' });
      } finally {
        client.release();
      }

      const { rows } = await pool.query(
        `SELECT kt.id, kt.code, kt.display_name FROM teacher_khat_assignments tka
         JOIN khat_types kt ON kt.id = tka.khat_type_id WHERE tka.teacher_id = $1`,
        [request.params.id]
      );
      await notify(request.params.id, 'staff_assignment_updated', { khatTypeIds });
      return rows;
    }
  );

  // ---- Soft-delete a staff account ----
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { rows } = await pool.query(
        `UPDATE users SET deleted_at = now() WHERE id = $1 AND role IN ('teacher', 'admin') RETURNING id`,
        [request.params.id]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Staff account not found' });
      await notify(rows[0].id, 'account_deactivated', {});
      return reply.code(204).send();
    }
  );
}
