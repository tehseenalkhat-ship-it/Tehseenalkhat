import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';
import { notify, notifyAllAdmins } from '../services/notify.js';

type CreatePostBody = { imageStorageKey: string; caption?: string; originalFilename?: string };
type ModerateBody = { decision: 'approve' | 'reject' };

export async function showcaseRoutes(app: FastifyInstance) {
  // ---- Create a post ----
  // Students land in 'pending' and need admin approval. Teachers are treated as
  // professionals and go straight to 'approved' — admin can still moderate a
  // teacher's post afterward via the same /moderate endpoint below, which
  // covers "remove an inappropriate teacher post after the fact."
  app.post<{ Body: CreatePostBody }>(
    '/',
    { preHandler: [app.authenticate, app.requireRole('student', 'teacher', 'admin')] },
    async (request, reply) => {
      const { imageStorageKey, caption, originalFilename } = request.body;
      if (!imageStorageKey) return reply.code(400).send({ error: 'imageStorageKey is required' });

      const user = request.user as AuthUser;
      const showcaseRole = user.role === 'student' ? 'student' : 'teacher';
      const status = showcaseRole === 'teacher' ? 'approved' : 'pending';

      const { rows } = await pool.query(
        `INSERT INTO showcase_posts (user_id, user_role, image_storage_key, caption, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [user.id, showcaseRole, imageStorageKey, caption ?? null, status]
      );
      if (status === 'pending') {
        await notifyAllAdmins('showcase_pending', { postId: rows[0].id, authorId: user.id });
      }
      return reply.code(201).send(rows[0]);
    }
  );

  // ---- Public feed: approved posts only, optionally filtered to one role's tab ----
  app.get<{ Querystring: { role?: 'student' | 'teacher'; status?: string } }>(
    '/',
    { preHandler: [app.authenticate] },
    async (request) => {
      const user = request.user as AuthUser;
      const { role, status } = request.query;
      const params: unknown[] = [user.id];
      let roleFilter = '';
      if (role) { params.push(role); roleFilter = `AND p.user_role = $${params.length}`; }
  
      let statusClause = `p.status = 'approved'`;
      if (user.role === 'admin' && status) {
        if (status === 'all') {
          statusClause = '1=1';
        } else {
          params.push(status);
          statusClause = `p.status = $${params.length}`;
        }
      }
  
      const { rows } = await pool.query(
        `SELECT p.*, u.name AS author_name, b.name AS branch_name,
                (SELECT COUNT(*) FROM showcase_likes sl WHERE sl.post_id = p.id) AS like_count,
                EXISTS (SELECT 1 FROM showcase_likes sl2 WHERE sl2.post_id = p.id AND sl2.user_id = $1) AS liked_by_me
         FROM showcase_posts p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN branches b ON b.id = u.branch_id
         WHERE ${statusClause} ${roleFilter}
         ORDER BY p.created_at DESC`,
        params
      );
      return rows;
    }
  );

  app.get<{ Querystring: { role?: 'student' | 'teacher'; page?: string; pageSize?: string; q?: string } }>(
    '/feed',
    { preHandler: [app.authenticate] },
    async (request) => {
      const user = request.user as AuthUser;
      const { role, q } = request.query;
      const page = Math.max(1, Number.parseInt(request.query.page ?? '1', 10) || 1);
      const pageSize = Math.min(50, Math.max(1, Number.parseInt(request.query.pageSize ?? '12', 10) || 12));
      const params: unknown[] = [];
      const conditions = [`p.status = 'approved'`];
      if (role === 'student' || role === 'teacher') {
        params.push(role);
        conditions.push(`p.user_role = $${params.length}`);
      }
      const query = q?.trim().slice(0, 100);
      if (query) {
        params.push(`%${query}%`);
        const searchParam = `$${params.length}`;
        conditions.push(`(p.caption ILIKE ${searchParam} OR u.name ILIKE ${searchParam} OR b.name ILIKE ${searchParam})`);
      }
      const where = conditions.join(' AND ');
      const [countResult, postsResult] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS total FROM showcase_posts p
           JOIN users u ON u.id = p.user_id
           LEFT JOIN branches b ON b.id = u.branch_id
           WHERE ${where}`,
          params
        ),
        pool.query(
          `SELECT p.*, u.name AS author_name, b.name AS branch_name,
                  (SELECT COUNT(*) FROM showcase_likes sl WHERE sl.post_id = p.id) AS like_count,
                  EXISTS (SELECT 1 FROM showcase_likes sl2 WHERE sl2.post_id = p.id AND sl2.user_id = $${params.length + 1}) AS liked_by_me
           FROM showcase_posts p
           JOIN users u ON u.id = p.user_id
           LEFT JOIN branches b ON b.id = u.branch_id
           WHERE ${where}
           ORDER BY p.created_at DESC
           LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
          [...params, user.id, pageSize, (page - 1) * pageSize]
        ),
      ]);
      return { items: postsResult.rows, total: Number(countResult.rows[0]?.total ?? 0), page, pageSize };
    }
  );

  // ---- My own posts, any status (so a student can see their pending/rejected ones) ----
  app.get('/mine', { preHandler: [app.authenticate, app.requireRole('student', 'teacher', 'admin')] }, async (request) => {
    const user = request.user as AuthUser;
    const { rows } = await pool.query(
      `SELECT p.*, u.name AS author_name, b.name AS branch_name
       FROM showcase_posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN branches b ON b.id = u.branch_id
       WHERE p.user_id = $1 ORDER BY p.created_at DESC`,
      [user.id]
    );
    return rows;
  });

  // ---- Like / unlike ----
  app.post<{ Params: { id: string } }>(
    '/:id/like',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const userId = (request.user as AuthUser).id;
      const { rows: postRows } = await pool.query(`SELECT status FROM showcase_posts WHERE id = $1`, [
        request.params.id,
      ]);
      if (!postRows[0]) return reply.code(404).send({ error: 'Post not found' });
      if (postRows[0].status !== 'approved') {
        return reply.code(409).send({ error: 'Cannot like a post that is not approved' });
      }

      await pool.query(
        `INSERT INTO showcase_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [request.params.id, userId]
      );
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) AS like_count FROM showcase_likes WHERE post_id = $1`,
        [request.params.id]
      );
      return { likeCount: Number(countRows[0].like_count), likedByMe: true };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/:id/like',
    { preHandler: [app.authenticate] },
    async (request) => {
      const userId = (request.user as AuthUser).id;
      await pool.query(`DELETE FROM showcase_likes WHERE post_id = $1 AND user_id = $2`, [
        request.params.id,
        userId,
      ]);
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) AS like_count FROM showcase_likes WHERE post_id = $1`,
        [request.params.id]
      );
      return { likeCount: Number(countRows[0].like_count), likedByMe: false };
    }
  );

  // ---- Admin: pending queue ----
  app.get(
    '/pending',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async () => {
      const { rows } = await pool.query(
        `SELECT p.*, u.name AS author_name, b.name AS branch_name FROM showcase_posts p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN branches b ON b.id = u.branch_id
         WHERE p.status = 'pending' ORDER BY p.created_at ASC`
      );
      return rows;
    }
  );

  // ---- Admin: approve/reject — also how an already-approved (e.g. teacher) post gets removed ----
  app.post<{ Params: { id: string }; Body: ModerateBody }>(
    '/:id/moderate',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const adminId = (request.user as AuthUser).id;
      const { decision } = request.body;
      if (decision !== 'approve' && decision !== 'reject') {
        return reply.code(400).send({ error: "decision must be 'approve' or 'reject'" });
      }

      const { rows } = await pool.query(
        `UPDATE showcase_posts SET status = $1, moderated_by = $2 WHERE id = $3 RETURNING *`,
        [decision === 'approve' ? 'approved' : 'rejected', adminId, request.params.id]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Post not found' });
      await notify(rows[0].user_id, 'showcase_moderated', { postId: rows[0].id, decision });
      return rows[0];
    }
  );

  // ---- Admin: permanently remove any showcase post ----
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { rows } = await pool.query(
        `DELETE FROM showcase_posts WHERE id = $1 RETURNING id, user_id, caption`,
        [request.params.id]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Showcase post not found' });
      await notify(rows[0].user_id, 'showcase_removed', { postId: rows[0].id, caption: rows[0].caption });
      return reply.code(204).send();
    }
  );
}
