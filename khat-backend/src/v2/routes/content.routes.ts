import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { pool } from '../../db.js';
import { getActor, requireStaff, type Actor } from '../lib/access.js';
import { getEffectivePolicies } from '../lib/policies.js';
import { logAudit } from '../lib/audit.js';
import { isSafeStorageKey } from '../lib/filesLogic.js';
import { safeNotify } from '../lib/filesData.js';
import {
  canEditGalleryWork, cleanAwardLabel, cleanCaption, cleanText, normaliseLanguage, normaliseMinutes,
  youTubeId, youTubeWatchUrl,
} from '../lib/contentLogic.js';
import type { GalleryWork, OlderCourse, ShowcaseItem, LibraryBook } from './contentTypes.js';

/**
 * v3 content (owner notes 1.9, 1.10, 4.2, 4.5, 4.6, 4.7, 4.9). Registered under prefix '/v2'.
 *   Gallery    = reference work by calligraphers, uploaded by admins / faculty only, per branch.
 *   Showcase   = student and teacher work, branch-specific, with reflection + time taken.
 *   Events     = recordings are YouTube links played on the site.
 *   Resources  = books with author / language, filterable.
 *   Older courses = old-system courses that are published, for the student's branch, with levels.
 */

const bad = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? new Date(v.includes('T') ? v : v.replace(' ', 'T') + 'Z').toISOString() : new Date(0).toISOString());
const bool = (v: unknown) => v === true || v === 1 || v === '1';

/** Branch the caller is looking at: own branch, or for master admins the one asked for (null = all). */
function viewBranch(actor: Actor, requested?: string): string | null {
  if (actor.isMaster) return requested && requested !== 'all' ? requested : null;
  return actor.branchId ?? '';
}

// ---------------------------------------------------------------- gallery
const GALLERY_SELECT = `SELECT g.*, b.name AS branch_name, u.name AS uploader_name
  FROM gallery_works g
  LEFT JOIN branches b ON b.id = g.branch_id
  LEFT JOIN users u ON u.id = g.uploaded_by`;

function mapGallery(r: any, actor: Actor): GalleryWork {
  return {
    id: r.id, title: r.title, calligrapher: r.calligrapher ?? null, script: r.script ?? null, note: r.note ?? null,
    imageStorageKey: r.image_storage_key, branchId: r.branch_id ?? null, branchName: r.branch_name ?? null,
    uploadedByName: r.uploader_name ?? null, createdAt: iso(r.created_at), canEdit: canEditGalleryWork(actor, r.branch_id ?? null),
  };
}

// ---------------------------------------------------------------- showcase
const SHOWCASE_SELECT = `SELECT p.id, p.user_id, p.user_role, p.image_storage_key, p.caption, p.status, p.source, p.award_label,
    p.reflection_question, p.time_minutes, p.created_at, u.name AS author_name, b.name AS branch_name,
    COALESCE(p.branch_id, u.branch_id) AS effective_branch_id,
    (SELECT COUNT(*) FROM showcase_likes sl WHERE sl.post_id = p.id) AS like_count,
    EXISTS (SELECT 1 FROM showcase_likes sl2 WHERE sl2.post_id = p.id AND sl2.user_id = $1) AS liked_by_me
  FROM showcase_posts p
  JOIN users u ON u.id = p.user_id
  LEFT JOIN branches b ON b.id = COALESCE(p.branch_id, u.branch_id)`;

function mapShowcase(r: any): ShowcaseItem {
  return {
    id: r.id, role: r.user_role === 'teacher' ? 'teacher' : 'student', authorId: r.user_id, authorName: r.author_name ?? '',
    branchName: r.branch_name ?? null, imageStorageKey: r.image_storage_key, caption: cleanCaption(r.caption),
    question: r.reflection_question ?? null, timeMinutes: r.time_minutes === null || r.time_minutes === undefined ? null : Number(r.time_minutes),
    awardLabel: cleanAwardLabel(r.award_label), source: r.source ?? null, status: r.status,
    likes: Number(r.like_count ?? 0), likedByMe: bool(r.liked_by_me), createdAt: iso(r.created_at),
  };
}

// ---------------------------------------------------------------- books
function mapBook(r: any): LibraryBook {
  return {
    id: r.id, title: r.title, author: r.author ?? null, language: r.language ?? null, description: r.description ?? null,
    khatTypeId: r.khat_type_id ?? null, scriptName: r.script_name ?? null, fileStorageKey: r.file_storage_key,
    originalFilename: r.original_filename ?? null, createdAt: iso(r.created_at),
  };
}

export async function contentV2Routes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: [app.authenticate] };
  const staff = { preHandler: [app.authenticate, requireStaff()] };

  // ================= GALLERY (reference work) =================
  app.get<{ Querystring: { q?: string; script?: string; branchId?: string } }>('/gallery', auth, async request => {
    const actor = await getActor(request);
    const params: unknown[] = [];
    const where = [`g.status = 'visible'`];
    const branch = viewBranch(actor, request.query.branchId);
    if (branch !== null) { params.push(branch); where.push(`(g.branch_id IS NULL OR g.branch_id = $${params.length})`); }
    const q = request.query.q?.trim().slice(0, 100);
    if (q) { params.push(`%${q}%`); where.push(`(g.title LIKE $${params.length} OR g.calligrapher LIKE $${params.length} OR g.script LIKE $${params.length})`); }
    if (request.query.script) { params.push(request.query.script); where.push(`g.script = $${params.length}`); }
    const { rows } = await pool.query(`${GALLERY_SELECT} WHERE ${where.join(' AND ')} ORDER BY g.created_at DESC LIMIT 300`, params);
    return rows.map(r => mapGallery(r, actor));
  });

  app.post<{ Body: Record<string, unknown> }>('/gallery', staff, async (request, reply) => {
    const actor = await getActor(request);
    const b = request.body ?? {};
    const title = cleanText(b.title, 255);
    if (!title) return bad(reply, 400, 'Please give the piece a title.');
    if (!isSafeStorageKey(b.storageKey)) return bad(reply, 400, 'Please add a photo of the piece.');
    let branchId: string | null = actor.branchId ?? null;
    if (actor.isMaster) branchId = typeof b.branchId === 'string' && b.branchId && b.branchId !== 'all' ? b.branchId : null;
    if (!actor.isMaster && !branchId) return bad(reply, 400, 'Your account has no branch yet.');
    const id = randomUUID();
    await pool.query(
      `INSERT INTO gallery_works (id, title, calligrapher, script, note, image_storage_key, branch_id, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, title, cleanText(b.calligrapher, 255), cleanText(b.script, 64), cleanText(b.note, 2000), b.storageKey, branchId, actor.id],
    );
    await logAudit({ actorId: actor.id, branchId, action: 'gallery.add', entityType: 'gallery_work', entityId: id, summary: `Gallery piece added: ${title}` });
    const { rows } = await pool.query(`${GALLERY_SELECT} WHERE g.id = $1`, [id]);
    return reply.code(201).send(mapGallery(rows[0], actor));
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/gallery/:id', staff, async (request, reply) => {
    const actor = await getActor(request);
    const { rows } = await pool.query(`SELECT * FROM gallery_works WHERE id = $1`, [request.params.id]);
    const work = rows[0];
    if (!work) return bad(reply, 404, 'This piece could not be found.');
    if (!canEditGalleryWork(actor, work.branch_id ?? null)) return bad(reply, 403, 'Only staff of this branch (or the master team) can change it.');
    const b = request.body ?? {};
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (b.title !== undefined) { const t = cleanText(b.title, 255); if (!t) return bad(reply, 400, 'The title cannot be empty.'); set('title', t); }
    if (b.calligrapher !== undefined) set('calligrapher', cleanText(b.calligrapher, 255));
    if (b.script !== undefined) set('script', cleanText(b.script, 64));
    if (b.note !== undefined) set('note', cleanText(b.note, 2000));
    if (b.storageKey !== undefined) { if (!isSafeStorageKey(b.storageKey)) return bad(reply, 400, 'Please add a photo.'); set('image_storage_key', b.storageKey); }
    if (b.branchId !== undefined && actor.isMaster) set('branch_id', typeof b.branchId === 'string' && b.branchId && b.branchId !== 'all' ? b.branchId : null);
    if (!sets.length) return bad(reply, 400, 'Nothing to change.');
    params.push(work.id);
    await pool.query(`UPDATE gallery_works SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const { rows: after } = await pool.query(`${GALLERY_SELECT} WHERE g.id = $1`, [work.id]);
    return mapGallery(after[0], actor);
  });

  app.delete<{ Params: { id: string } }>('/gallery/:id', staff, async (request, reply) => {
    const actor = await getActor(request);
    const { rows } = await pool.query(`SELECT id, branch_id, title FROM gallery_works WHERE id = $1`, [request.params.id]);
    const work = rows[0];
    if (!work) return bad(reply, 404, 'This piece could not be found.');
    if (!canEditGalleryWork(actor, work.branch_id ?? null)) return bad(reply, 403, 'Only staff of this branch (or the master team) can remove it.');
    await pool.query(`UPDATE gallery_works SET status = 'hidden' WHERE id = $1`, [work.id]);
    await logAudit({ actorId: actor.id, branchId: work.branch_id ?? null, action: 'gallery.remove', entityType: 'gallery_work', entityId: work.id, summary: `Gallery piece removed: ${work.title}` });
    return { ok: true };
  });

  // ================= SHOWCASE (branch-specific) =================
  app.get<{ Querystring: { role?: string; q?: string; page?: string; pageSize?: string; branchId?: string } }>('/showcase/feed', auth, async request => {
    const actor = await getActor(request);
    const page = Math.max(1, Number.parseInt(request.query.page ?? '1', 10) || 1);
    const pageSize = Math.min(48, Math.max(1, Number.parseInt(request.query.pageSize ?? '12', 10) || 12));
    const params: unknown[] = [actor.id];
    const where = [`p.status = 'approved'`];
    const role = request.query.role === 'teacher' ? 'teacher' : request.query.role === 'student' ? 'student' : null;
    if (role) { params.push(role); where.push(`p.user_role = $${params.length}`); }
    const branch = viewBranch(actor, request.query.branchId);
    if (branch !== null) { params.push(branch); where.push(`COALESCE(p.branch_id, u.branch_id) = $${params.length}`); }
    const q = request.query.q?.trim().slice(0, 100);
    if (q) { params.push(`%${q}%`); where.push(`(p.caption LIKE $${params.length} OR u.name LIKE $${params.length})`); }
    const w = where.join(' AND ');
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM showcase_posts p JOIN users u ON u.id = p.user_id WHERE ${w}`,
      params,
    );
    const { rows } = await pool.query(
      `${SHOWCASE_SELECT} WHERE ${w} ORDER BY p.created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    return { items: rows.map(mapShowcase), total: Number(countRows[0]?.total ?? 0), page, pageSize, branchName: rows[0]?.branch_name ?? null };
  });

  app.get('/showcase/mine', auth, async request => {
    const actor = await getActor(request);
    const { rows } = await pool.query(`${SHOWCASE_SELECT} WHERE p.user_id = $1 ORDER BY p.created_at DESC LIMIT 200`, [actor.id]);
    return rows.map(mapShowcase);
  });

  app.post<{ Body: Record<string, unknown> }>('/showcase/posts', auth, async (request, reply) => {
    const actor = await getActor(request);
    const b = request.body ?? {};
    if (!isSafeStorageKey(b.storageKey)) return bad(reply, 400, 'Please add a photo of your work.');
    const caption = cleanText(b.caption, 1000);
    const question = cleanText(b.question, 255);
    const minutes = b.timeMinutes === undefined || b.timeMinutes === null || b.timeMinutes === '' ? null : normaliseMinutes(b.timeMinutes);
    if (b.timeMinutes !== undefined && b.timeMinutes !== null && b.timeMinutes !== '' && minutes === null) {
      return bad(reply, 400, 'Please write the time in minutes (for example 90 for one and a half hours).');
    }
    if (actor.role === 'student' && !caption) return bad(reply, 400, 'Please answer the question about your piece.');
    const isStudent = actor.role === 'student';
    let status = 'approved';
    if (isStudent) {
      const policies = await getEffectivePolicies(actor.branchId);
      status = policies['showcase.requires_approval'] === false ? 'approved' : 'pending';
    }
    const id = randomUUID();
    await pool.query(
      `INSERT INTO showcase_posts (id, user_id, user_role, image_storage_key, caption, status, source, branch_id, reflection_question, time_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, 'post', $7, $8, $9)`,
      [id, actor.id, isStudent ? 'student' : 'teacher', b.storageKey, caption, status, actor.branchId ?? null, question, minutes],
    );
    if (status === 'pending') {
      const { rows: mods } = await pool.query(
        `SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL AND admin_scope = 'branch' AND branch_id = $1`,
        [actor.branchId],
      );
      const targets = mods.length ? mods : (await pool.query(`SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL AND admin_scope = 'master'`)).rows;
      for (const m of targets) await safeNotify(m.id, 'showcase_pending', { postId: id, authorId: actor.id, message: `${actor.name || 'A student'} shared a piece for the showcase.` });
    }
    const { rows } = await pool.query(`${SHOWCASE_SELECT} WHERE p.id = $2`, [actor.id, id]);
    return reply.code(201).send(mapShowcase(rows[0]));
  });

  app.delete<{ Params: { id: string } }>('/showcase/posts/:id', auth, async (request, reply) => {
    const actor = await getActor(request);
    const { rows } = await pool.query(`SELECT id, user_id FROM showcase_posts WHERE id = $1`, [request.params.id]);
    if (!rows[0]) return bad(reply, 404, 'This post could not be found.');
    if (rows[0].user_id !== actor.id) return bad(reply, 403, 'You can only withdraw your own posts.');
    await pool.query(`DELETE FROM showcase_likes WHERE post_id = $1`, [rows[0].id]);
    await pool.query(`DELETE FROM showcase_posts WHERE id = $1`, [rows[0].id]);
    return { ok: true };
  });

  // ================= EVENTS: YouTube recordings =================
  async function canManageEvent(actor: Actor, eventId: string): Promise<{ ok: boolean; event?: any }> {
    const { rows } = await pool.query(`SELECT id, host_teacher_id, branch_id, title FROM live_events WHERE id = $1`, [eventId]);
    const ev = rows[0];
    if (!ev) return { ok: false };
    const ok = actor.isMaster || ev.host_teacher_id === actor.id || (actor.isStaff && actor.branchId === ev.branch_id);
    return { ok, event: ev };
  }

  app.put<{ Params: { id: string }; Body: { youtubeUrl?: unknown } }>('/events/:id/recording', staff, async (request, reply) => {
    const actor = await getActor(request);
    const { ok, event } = await canManageEvent(actor, request.params.id);
    if (!event) return bad(reply, 404, 'This event could not be found.');
    if (!ok) return bad(reply, 403, 'Only teachers of this branch can change its recording.');
    const raw = request.body?.youtubeUrl;
    if (raw === null || raw === '') {
      await pool.query(`UPDATE live_events SET recording_youtube_url = NULL WHERE id = $1`, [event.id]);
      return { id: event.id, recordingYoutubeUrl: null };
    }
    const vid = youTubeId(raw);
    if (!vid) return bad(reply, 400, 'Please paste a YouTube link, for example https://youtu.be/abc123XYZ00');
    const url = youTubeWatchUrl(vid);
    await pool.query(`UPDATE live_events SET recording_youtube_url = $1 WHERE id = $2`, [url, event.id]);
    await logAudit({ actorId: actor.id, branchId: event.branch_id, action: 'event.recording', entityType: 'live_event', entityId: event.id, summary: `YouTube recording set for ${event.title}` });
    return { id: event.id, recordingYoutubeUrl: url };
  });

  app.post<{ Body: Record<string, unknown> }>('/events/recordings', staff, async (request, reply) => {
    const actor = await getActor(request);
    const b = request.body ?? {};
    const title = cleanText(b.title, 255);
    if (!title) return bad(reply, 400, 'Please give the recording a title.');
    const vid = youTubeId(b.youtubeUrl);
    if (!vid) return bad(reply, 400, 'Please paste a YouTube link, for example https://youtu.be/abc123XYZ00');
    const when = typeof b.recordedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.recordedOn) ? `${b.recordedOn} 12:00:00` : null;
    const branchId = actor.isMaster && typeof b.branchId === 'string' && b.branchId ? b.branchId : actor.branchId;
    if (!branchId) return bad(reply, 400, 'Please choose a branch.');
    const id = randomUUID();
    await pool.query(
      `INSERT INTO live_events (id, host_teacher_id, branch_id, title, description, scheduled_at, status, recording_youtube_url)
       VALUES ($1, $2, $3, $4, $5, ${when ? '$6' : 'CURRENT_TIMESTAMP(6)'}, 'ended', $${when ? 7 : 6})`,
      when ? [id, actor.id, branchId, title, cleanText(b.description, 2000), when, youTubeWatchUrl(vid)]
        : [id, actor.id, branchId, title, cleanText(b.description, 2000), youTubeWatchUrl(vid)],
    );
    await logAudit({ actorId: actor.id, branchId, action: 'event.recording_add', entityType: 'live_event', entityId: id, summary: `Recording added: ${title}` });
    return reply.code(201).send({ id, title, recordingYoutubeUrl: youTubeWatchUrl(vid) });
  });

  // ================= RESOURCES: books =================
  app.get<{ Querystring: { q?: string; khatTypeId?: string; language?: string } }>('/books', auth, async request => {
    const params: unknown[] = [];
    const where = ['1=1'];
    const q = request.query.q?.trim().slice(0, 100);
    if (q) { params.push(`%${q}%`); where.push(`(bk.title LIKE $${params.length} OR bk.author LIKE $${params.length} OR bk.description LIKE $${params.length})`); }
    if (request.query.khatTypeId) { params.push(request.query.khatTypeId); where.push(`bk.khat_type_id = $${params.length}`); }
    if (request.query.language) { params.push(request.query.language); where.push(`bk.language = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT bk.*, kt.display_name AS script_name FROM books bk LEFT JOIN khat_types kt ON kt.id = bk.khat_type_id
        WHERE ${where.join(' AND ')} ORDER BY bk.title`,
      params,
    );
    return rows.map(mapBook);
  });

  app.post<{ Body: Record<string, unknown> }>('/books', staff, async (request, reply) => {
    const actor = await getActor(request);
    const b = request.body ?? {};
    const title = cleanText(b.title, 255);
    if (!title) return bad(reply, 400, 'Please give the book a title.');
    if (!isSafeStorageKey(b.storageKey)) return bad(reply, 400, 'Please upload the book (PDF).');
    const id = randomUUID();
    await pool.query(
      `INSERT INTO books (id, title, khat_type_id, file_storage_key, original_filename, uploaded_by, author, language, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, title, typeof b.khatTypeId === 'string' && b.khatTypeId ? b.khatTypeId : null, b.storageKey, cleanText(b.originalFilename, 255),
        actor.id, cleanText(b.author, 255), normaliseLanguage(b.language), cleanText(b.description, 2000)],
    );
    const { rows } = await pool.query(`SELECT bk.*, kt.display_name AS script_name FROM books bk LEFT JOIN khat_types kt ON kt.id = bk.khat_type_id WHERE bk.id = $1`, [id]);
    return reply.code(201).send(mapBook(rows[0]));
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/books/:id', staff, async (request, reply) => {
    const b = request.body ?? {};
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (b.title !== undefined) { const t = cleanText(b.title, 255); if (!t) return bad(reply, 400, 'The title cannot be empty.'); set('title', t); }
    if (b.author !== undefined) set('author', cleanText(b.author, 255));
    if (b.language !== undefined) set('language', normaliseLanguage(b.language));
    if (b.description !== undefined) set('description', cleanText(b.description, 2000));
    if (b.khatTypeId !== undefined) set('khat_type_id', typeof b.khatTypeId === 'string' && b.khatTypeId ? b.khatTypeId : null);
    if (!sets.length) return bad(reply, 400, 'Nothing to change.');
    params.push(request.params.id);
    await pool.query(`UPDATE books SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const { rows } = await pool.query(`SELECT bk.*, kt.display_name AS script_name FROM books bk LEFT JOIN khat_types kt ON kt.id = bk.khat_type_id WHERE bk.id = $1`, [request.params.id]);
    if (!rows[0]) return bad(reply, 404, 'This book could not be found.');
    return mapBook(rows[0]);
  });

  // ================= OLDER COURSES =================
  app.get('/older-courses', auth, async request => {
    const actor = await getActor(request);
    const params: unknown[] = [actor.id];
    let branchClause = '';
    if (!actor.isMaster) {
      params.push(actor.branchId ?? '');
      branchClause = `AND (NOT EXISTS (SELECT 1 FROM course_branches cb WHERE cb.course_id = c.id)
        OR EXISTS (SELECT 1 FROM course_branches cb2 WHERE cb2.course_id = c.id AND cb2.branch_id = $2))`;
    }
    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.description, c.category, c.khat_type_id, kt.display_name AS script_name, kt.code AS script_code,
              (SELECT COUNT(*) FROM levels l WHERE l.course_id = c.id) AS level_count,
              (SELECT l.id FROM levels l WHERE l.course_id = c.id ORDER BY l.order_index LIMIT 1) AS first_level_id,
              e.current_level_index, e.percent_complete, e.enrolled_at
         FROM courses c
         LEFT JOIN khat_types kt ON kt.id = c.khat_type_id
         LEFT JOIN enrollments e ON e.course_id = c.id AND e.student_id = $1
        WHERE COALESCE(c.structure_version, 1) = 1 AND COALESCE(c.status, 'published') = 'published'
          AND EXISTS (SELECT 1 FROM levels l2 WHERE l2.course_id = c.id)
          ${actor.role === 'student' ? `AND (kt.code IS NULL OR kt.code <> 'tehseen_al_khat_normal_pen')` : ''}
          ${branchClause}
        ORDER BY (e.enrolled_at IS NULL), c.category, c.title`,
      params,
    );
    const out: OlderCourse[] = rows.map(r => ({
      id: r.id, title: String(r.title ?? '').replace(/Instinsakh/g, 'Istinsakh'), description: r.description ?? null,
      kind: r.category === 'certification' ? 'Certification course' : 'Crash course',
      scriptName: r.script_name ?? null, levelCount: Number(r.level_count ?? 0), firstLevelId: r.first_level_id ?? null,
      enrolled: r.enrolled_at !== null && r.enrolled_at !== undefined,
      percentComplete: r.percent_complete === null || r.percent_complete === undefined ? 0 : Math.round(Number(r.percent_complete)),
      currentLevelIndex: r.current_level_index === null || r.current_level_index === undefined ? null : Number(r.current_level_index),
    }));
    return out;
  });
}
