import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { mapDatabaseError } from '../utils/dbErrors.js';
import type { AuthUser } from '../plugins/auth.js';
import { notifyAllStudents } from '../services/notify.js';

type MediaItem = { kind: 'video' | 'image' | 'pdf'; storageKey: string; originalFilename?: string };
type SheetFiles = Partial<Record<'1mm' | '2mm' | '3mm', MediaItem>>;

type CreateCourseBody = {
  khatTypeId: string;
  category: 'certification' | 'secondary';
  title: string;
  description?: string;
  guidanceQuestion?: string;
};
type UpdateCourseBody = { title?: string; description?: string; category?: 'certification' | 'secondary'; guidanceQuestion?: string };

type CreateLevelBody = {
  levelType: 'mufradat' | 'writing' | 'test';
  title: string;
  media?: MediaItem[];
  sheetFiles?: SheetFiles;
};
type UpdateLevelBody = { levelType?: 'mufradat' | 'writing' | 'test'; title?: string; media?: MediaItem[]; sheetFiles?: SheetFiles; badgeTier?: string | null };
type ReorderBody = { orderedLevelIds: string[] };

const VALID_CATEGORIES = ['certification', 'secondary'] as const;
const VALID_LEVEL_TYPES = ['mufradat', 'writing', 'test'] as const;
const VALID_BADGE_TIERS = ['foundation', 'composition', 'mastery', 'ijazah'] as const;

// Registered at prefix '/courses'
export async function courseRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { khatTypeId?: string; category?: string } }>(
    '/',
    { preHandler: [app.authenticate] },
    async (request) => {
      const { khatTypeId, category } = request.query;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if ((request.user as AuthUser).role === 'student') {
        conditions.push(`khat_type_id NOT IN (SELECT id FROM khat_types WHERE code = 'tehseen_al_khat_normal_pen')`);
      }
      if (khatTypeId) {
        params.push(khatTypeId);
        conditions.push(`khat_type_id = $${params.length}`);
      }
      if (category) {
        params.push(category);
        conditions.push(`category = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await pool.query(
        `SELECT id, khat_type_id, category, title, description, guidance_question, is_deletable, created_at
         FROM courses ${where}
         ORDER BY category, created_at`,
        params
      );
      return rows;
    }
  );

  app.get<{ Params: { id: string } }>('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = request.user as AuthUser;
    if (user.role === 'student') {
      const { rows: hiddenRows } = await pool.query(
        `SELECT 1 FROM courses c JOIN khat_types kt ON kt.id = c.khat_type_id
         WHERE c.id = $1 AND kt.code = 'tehseen_al_khat_normal_pen'`,
        [request.params.id]
      );
      if (hiddenRows[0]) return reply.code(404).send({ error: 'Course not found' });
    }
    const { rows } = await pool.query('SELECT * FROM courses WHERE id = $1', [request.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'Course not found' });
    return rows[0];
  });

  app.get<{ Params: { id: string } }>(
    '/:id/levels',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      if (user.role === 'student') {
        const { rows: hiddenRows } = await pool.query(
          `SELECT 1 FROM courses c JOIN khat_types kt ON kt.id = c.khat_type_id
           WHERE c.id = $1 AND kt.code = 'tehseen_al_khat_normal_pen'`,
          [request.params.id]
        );
        if (hiddenRows[0]) return reply.code(404).send({ error: 'Course not found' });
      }
      const { rows } = await pool.query('SELECT * FROM levels WHERE course_id = $1 ORDER BY order_index', [
        request.params.id,
      ]);
      return rows;
    }
  );

  app.post<{ Body: CreateCourseBody }>(
    '/',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { khatTypeId, category, title, description, guidanceQuestion } = request.body;
      if (!khatTypeId || !category || !title) {
        return reply.code(400).send({ error: 'khatTypeId, category, and title are required' });
      }
      if (!VALID_CATEGORIES.includes(category)) {
        return reply.code(400).send({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }

      const createdBy = (request.user as AuthUser).id;
      try {
        const { rows } = await pool.query(
          `INSERT INTO courses (khat_type_id, category, title, description, guidance_question, is_deletable, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [khatTypeId, category, title, description ?? null, guidanceQuestion?.trim() || null, category === 'secondary', createdBy]
        );
        await notifyAllStudents('course_created', { courseId: rows[0].id, title });
        return reply.code(201).send(rows[0]);
      } catch (err) {
        const mapped = mapDatabaseError(err);
        if (mapped) {
          // The generated-column unique index enforces one certification course
          // per khat type — provide a specific response for that collision.
          if (category === 'certification' && mapped.status === 409) {
            return reply.code(409).send({ error: 'This khat type already has a certification course.' });
          }
          return reply.code(mapped.status).send(mapped.body);
        }
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to create course' });
      }
    }
  );

  app.put<{ Params: { id: string }; Body: UpdateCourseBody }>(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { title, description, category, guidanceQuestion } = request.body;
      if (category !== undefined && !VALID_CATEGORIES.includes(category)) {
        return reply.code(400).send({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }
      try {
        const { rows } = await pool.query(
          `UPDATE courses SET
             title = COALESCE($1, title),
             description = COALESCE($2, description),
             category = COALESCE($3, category),
             guidance_question = CASE WHEN $4::boolean THEN NULLIF(TRIM($5), '') ELSE guidance_question END
           WHERE id = $6 RETURNING *`,
          [title ?? null, description ?? null, category ?? null, guidanceQuestion !== undefined, guidanceQuestion ?? null, request.params.id]
        );
        if (!rows[0]) return reply.code(404).send({ error: 'Course not found' });
        await notifyAllStudents('course_updated', { courseId: rows[0].id, title: rows[0].title });
        return rows[0];
      } catch (err) {
        const mapped = mapDatabaseError(err);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to update course' });
      }
    }
  );

  // Admins can remove any course from the catalog when it is no longer needed,
  // including certification courses, while preserving the remaining course data model.
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { rows } = await pool.query('SELECT id, title FROM courses WHERE id = $1', [request.params.id]);
      if (!rows[0]) return reply.code(404).send({ error: 'Course not found' });
      await pool.query('DELETE FROM courses WHERE id = $1', [request.params.id]);
      await notifyAllStudents('course_removed', { courseId: rows[0].id, title: rows[0].title });
      return reply.code(204).send();
    }
  );

  app.post<{ Params: { id: string }; Body: CreateLevelBody }>(
    '/:id/levels',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { levelType, title, media, sheetFiles } = request.body;
      if (!levelType || !title) {
        return reply.code(400).send({ error: 'levelType and title are required' });
      }
      if (!VALID_LEVEL_TYPES.includes(levelType)) {
        return reply.code(400).send({ error: `levelType must be one of: ${VALID_LEVEL_TYPES.join(', ')}` });
      }

      const { rows: maxRows } = await pool.query(
        'SELECT COALESCE(MAX(order_index), -1) + 1 AS next_index FROM levels WHERE course_id = $1',
        [request.params.id]
      );
      const nextIndex = maxRows[0].next_index;

      try {
        const { rows } = await pool.query(
          `INSERT INTO levels (course_id, order_index, level_type, title, media, sheet_files)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [
            request.params.id,
            nextIndex,
            levelType,
            title,
            JSON.stringify(media ?? []),
            JSON.stringify(sheetFiles ?? {}),
          ]
        );
        await notifyAllStudents('course_updated', { courseId: request.params.id, title });
        return reply.code(201).send(rows[0]);
      } catch (err) {
        const mapped = mapDatabaseError(err);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to create level' });
      }
    }
  );

  // Reorders every level in a course to match the given array's order. Admin
  // sends the full new order (e.g. after a drag-and-drop reorder in the UI).
  app.patch<{ Params: { id: string }; Body: ReorderBody }>(
    '/:id/levels/reorder',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { orderedLevelIds } = request.body;
      if (!Array.isArray(orderedLevelIds) || orderedLevelIds.length === 0) {
        return reply.code(400).send({ error: 'orderedLevelIds must be a non-empty array' });
      }

      const { rows: existingLevels } = await pool.query(
        'SELECT id, MAX(order_index) OVER () AS max_order_index FROM levels WHERE course_id = $1 ORDER BY order_index',
        [request.params.id]
      );
      const requested = new Set(orderedLevelIds);
      const existing = new Set(existingLevels.map((level: { id: string }) => level.id));
      if (requested.size !== orderedLevelIds.length || requested.size !== existing.size || [...requested].some(id => !existing.has(id))) {
        return reply.code(400).send({ error: 'orderedLevelIds must contain every level in this course exactly once' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Shift every existing index above the current range first so a unique
        // (course_id, order_index) constraint cannot reject a reorder swap.
        const indexOffset = Number(existingLevels[0].max_order_index) + 1;
        await client.query('UPDATE levels SET order_index = order_index + $2 WHERE course_id = $1', [request.params.id, indexOffset]);
        for (let i = 0; i < orderedLevelIds.length; i++) {
          await client.query('UPDATE levels SET order_index = $1 WHERE id = $2 AND course_id = $3', [
            i,
            orderedLevelIds[i],
            request.params.id,
          ]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to reorder levels' });
      } finally {
        client.release();
      }

      const { rows } = await pool.query('SELECT * FROM levels WHERE course_id = $1 ORDER BY order_index', [
        request.params.id,
      ]);
      await notifyAllStudents('course_updated', { courseId: request.params.id });
      return rows;
    }
  );
}

// Registered at prefix '/levels' — operations on a single level by its own ID,
// not nested under a specific course path.
export async function levelRoutes(app: FastifyInstance) {
  app.put<{ Params: { levelId: string }; Body: UpdateLevelBody }>(
    '/:levelId',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { levelType, title, media, sheetFiles, badgeTier } = request.body;
      if (levelType && !VALID_LEVEL_TYPES.includes(levelType)) {
        return reply.code(400).send({ error: `levelType must be one of: ${VALID_LEVEL_TYPES.join(', ')}` });
      }
      if (badgeTier && !(VALID_BADGE_TIERS as readonly string[]).includes(badgeTier)) {
        return reply.code(400).send({ error: `badgeTier must be one of: ${VALID_BADGE_TIERS.join(', ')}` });
      }
      const { rows } = await pool.query(
        `UPDATE levels SET
           level_type = COALESCE($1, level_type),
           title = COALESCE($2, title),
           media = COALESCE($3, media),
           sheet_files = COALESCE($4, sheet_files),
           badge_tier = CASE WHEN $5::boolean THEN $6 ELSE badge_tier END
         WHERE id = $7 RETURNING *`,
        [
          levelType ?? null,
          title ?? null,
          media ? JSON.stringify(media) : null,
          sheetFiles ? JSON.stringify(sheetFiles) : null,
          badgeTier !== undefined,
          badgeTier ?? null,
          request.params.levelId,
        ]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Level not found' });
      await notifyAllStudents('course_updated', { courseId: rows[0].course_id, title: rows[0].title });
      return rows[0];
    }
  );

  // Delete only unused levels so student history and issued certificates remain intact.
  app.delete<{ Params: { levelId: string } }>(
    '/:levelId',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { rows } = await pool.query(
        `SELECT l.id, l.course_id, l.title, l.order_index FROM levels l WHERE l.id = $1`,
        [request.params.levelId]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Level not found' });

      const level = rows[0];
      const { rows: dependencyRows } = await pool.query(
        `SELECT
           EXISTS (SELECT 1 FROM level_submissions WHERE level_id = $1) AS has_submissions,
           EXISTS (SELECT 1 FROM entries WHERE level_id = $1) AS has_entries,
           EXISTS (SELECT 1 FROM certificate_templates WHERE level_id = $1) AS has_templates,
           EXISTS (SELECT 1 FROM certificates WHERE level_id = $1) AS has_certificates`,
        [level.id]
      );
      const dependencies = dependencyRows[0];
      if (dependencies.has_submissions || dependencies.has_entries || dependencies.has_templates || dependencies.has_certificates) {
        return reply.code(409).send({
          error: 'This level has student history or certificate records and cannot be deleted. Remove its certificate assignment first, or keep the level to preserve records.',
        });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM levels WHERE id = $1', [level.id]);
        await client.query(
          'UPDATE levels SET order_index = order_index - 1 WHERE course_id = $1 AND order_index > $2',
          [level.course_id, level.order_index]
        );
        const { rows: countRows } = await client.query('SELECT COUNT(*) AS total FROM levels WHERE course_id = $1', [level.course_id]);
        const remainingLevels = Number(countRows[0].total);
        await client.query(
          `UPDATE enrollments SET
             current_level_index = CASE WHEN current_level_index > $2 THEN current_level_index - 1 ELSE current_level_index END,
             percent_complete = CASE WHEN $3 > 0
               THEN LEAST(100, ((CASE WHEN current_level_index > $2 THEN current_level_index - 1 ELSE current_level_index END)::numeric / $3) * 100)
               ELSE 0 END
           WHERE course_id = $1`,
          [level.course_id, level.order_index, remainingLevels]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to delete this level' });
      } finally {
        client.release();
      }

      await notifyAllStudents('course_updated', { courseId: level.course_id, title: level.title });
      return reply.code(204).send();
    }
  );
}
