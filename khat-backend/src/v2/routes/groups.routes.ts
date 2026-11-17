import type { FastifyInstance, FastifyReply } from 'fastify';
import { pool } from '../../db.js';
import { getActor, requireStaff, type Actor } from '../lib/access.js';
import { logAudit } from '../lib/audit.js';
import { SqlParams } from '../lib/insightsData.js';
import { toDate } from '../lib/insightsLogic.js';
import type { Attachment, GroupMessage, StudentGroup } from '../contracts.js';

// owner: insights — communities: staff-made student groups (delegation, special cohorts)
// with a simple WhatsApp-like group chat. Registered under prefix '/v2'.

/** Extra (non-contract) shapes used by the community screen. */
export type GroupMember = { userId: string; name: string; trNumber: string | null; className: string | null; branchName: string | null; role: string; memberRole: string };
export type GroupCandidate = { userId: string; name: string; trNumber: string | null; className: string | null; branchName: string | null };

type GroupRow = { id: string; name: string; purpose: string | null; branch_id: string | null; created_by: string | null; archived_at: Date | null; created_at: Date };

const iso = (value: unknown): string | null => toDate(value)?.toISOString() ?? null;

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') { try { return JSON.parse(value) as T; } catch { return fallback; } }
  return value as T;
}

function toGroup(row: any): StudentGroup {
  return {
    id: String(row.id),
    name: String(row.name),
    purpose: row.purpose ?? null,
    branchId: row.branch_id ?? null,
    memberCount: Number(row.member_count ?? 0),
    createdByName: row.created_by_name ?? null,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    lastMessageAt: iso(row.last_message_at),
  };
}

function toMessage(row: any): GroupMessage {
  const role = String(row.sender_role ?? 'student');
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    senderId: String(row.sender_id),
    senderName: String(row.sender_name ?? 'Someone'),
    senderRole: role === 'admin' ? 'admin' : role === 'teacher' ? 'teacher' : 'student',
    body: row.body ?? null,
    attachments: parseJson<Attachment[]>(row.attachments, []),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

const GROUP_SELECT = `
  SELECT g.id, g.name, g.purpose, g.branch_id, g.created_at, cu.name AS created_by_name,
         (SELECT COUNT(*) FROM student_group_members m WHERE m.group_id = g.id) AS member_count,
         (SELECT MAX(gm.created_at) FROM group_messages gm WHERE gm.group_id = g.id) AS last_message_at
  FROM student_groups g LEFT JOIN users cu ON cu.id = g.created_by`;

/** Staff manage a group of their own branch (or a cross-branch group they created); master: any. */
function canManageGroup(actor: Actor, group: GroupRow): boolean {
  if (actor.isMaster) return true;
  if (!actor.isStaff) return false;
  return group.branch_id === actor.branchId || (group.branch_id === null && group.created_by === actor.id);
}

async function loadGroup(id: string): Promise<GroupRow | null> {
  const { rows } = await pool.query(`SELECT id, name, purpose, branch_id, created_by, archived_at, created_at FROM student_groups WHERE id = $1`, [id]);
  return (rows[0] as GroupRow) ?? null;
}

async function isMember(groupId: string, userId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 AS ok FROM student_group_members WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);
  return rows.length > 0;
}

/** May read and write in the chat: managers, or members. */
async function canChat(actor: Actor, group: GroupRow): Promise<boolean> {
  if (canManageGroup(actor, group)) return true;
  return isMember(group.id, actor.id);
}

async function groupOr404(id: string, reply: FastifyReply): Promise<GroupRow | null> {
  const group = await loadGroup(id);
  if (!group) { reply.code(404).send({ error: 'This group no longer exists.' }); return null; }
  return group;
}

function cleanAttachments(value: unknown): Attachment[] | null {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 10) return null;
  const out: Attachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const a = item as Record<string, unknown>;
    if (typeof a.storageKey !== 'string' || !a.storageKey || a.storageKey.length > 512 || a.storageKey.includes('..')) return null;
    out.push({
      storageKey: a.storageKey,
      originalFilename: typeof a.originalFilename === 'string' ? a.originalFilename.slice(0, 255) : 'file',
      contentType: typeof a.contentType === 'string' ? a.contentType.slice(0, 100) : 'application/octet-stream',
    });
  }
  return out;
}

export async function groupsV2Routes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: [app.authenticate] };
  const staff = { preHandler: [app.authenticate, requireStaff(app)] };

  // ---- List: staff → their branch (+ cross-branch ones they made), master → all / ?branchId; students → their groups
  app.get<{ Querystring: { branchId?: string; archived?: string } }>('/groups', auth, async request => {
    const actor = await getActor(request);
    const p = new SqlParams();
    const where: string[] = [request.query.archived === '1' ? 'g.archived_at IS NOT NULL' : 'g.archived_at IS NULL'];
    if (!actor.isStaff) {
      where.push(`g.id IN (SELECT m.group_id FROM student_group_members m WHERE m.user_id = ${p.add(actor.id)})`);
    } else if (actor.isMaster) {
      if (request.query.branchId) where.push(`(g.branch_id = ${p.add(request.query.branchId)} OR g.branch_id IS NULL)`);
    } else {
      where.push(`(g.branch_id = ${p.add(actor.branchId)} OR g.created_by = ${p.add(actor.id)} OR g.id IN (SELECT m.group_id FROM student_group_members m WHERE m.user_id = ${p.add(actor.id)}))`);
    }
    const { rows } = await pool.query(
      `SELECT * FROM (${GROUP_SELECT} WHERE ${where.join(' AND ')}) x ORDER BY COALESCE(x.last_message_at, x.created_at) DESC`,
      p.values,
    );
    return rows.map(toGroup);
  });

  app.post<{ Body: { name?: string; purpose?: string | null; branchId?: string | null } }>('/groups', staff, async (request, reply) => {
    const actor = await getActor(request);
    const name = (request.body?.name ?? '').trim();
    const purpose = (request.body?.purpose ?? '').toString().trim() || null;
    if (!name) return reply.code(400).send({ error: 'Please give the group a name.' });
    if (name.length > 191) return reply.code(400).send({ error: 'The name is too long.' });
    let branchId: string | null;
    if (actor.isMaster) branchId = request.body?.branchId ?? null;
    else {
      if (request.body?.branchId && request.body.branchId !== actor.branchId) return reply.code(403).send({ error: 'You can only make groups for your own branch.' });
      branchId = actor.branchId;
    }
    const { rows } = await pool.query(
      `INSERT INTO student_groups (name, purpose, branch_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, purpose, branchId, actor.id],
    );
    const id = String(rows[0].id);
    await logAudit({ actorId: actor.id, branchId, action: 'group.create', entityType: 'student_group', entityId: id, summary: `Group “${name}” created`, after: { name, purpose, branchId } });
    const created = await pool.query(`${GROUP_SELECT} WHERE g.id = $1`, [id]);
    return reply.code(201).send(toGroup(created.rows[0]));
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; purpose?: string | null; archived?: boolean } }>('/groups/:id', staff, async (request, reply) => {
    const actor = await getActor(request);
    const group = await groupOr404(request.params.id, reply);
    if (!group) return reply;
    if (!canManageGroup(actor, group)) return reply.code(403).send({ error: 'Only staff of this branch can change this group.' });
    const sets: string[] = [];
    const p = new SqlParams();
    const body = request.body ?? {};
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name || name.length > 191) return reply.code(400).send({ error: 'Please give the group a name.' });
      sets.push(`name = ${p.add(name)}`);
    }
    if (body.purpose !== undefined) sets.push(`purpose = ${p.add((body.purpose ?? '').toString().trim() || null)}`);
    if (typeof body.archived === 'boolean') sets.push(body.archived ? 'archived_at = CURRENT_TIMESTAMP(6)' : 'archived_at = NULL');
    if (sets.length) {
      await pool.query(`UPDATE student_groups SET ${sets.join(', ')} WHERE id = ${p.add(group.id)}`, p.values);
      await logAudit({ actorId: actor.id, branchId: group.branch_id, action: 'group.update', entityType: 'student_group', entityId: group.id, summary: `Group “${group.name}” updated`, before: { name: group.name, purpose: group.purpose, archived: Boolean(group.archived_at) }, after: body });
    }
    const { rows } = await pool.query(`${GROUP_SELECT} WHERE g.id = $1`, [group.id]);
    return toGroup(rows[0]);
  });

  // ---- Members
  app.get<{ Params: { id: string } }>('/groups/:id/members', auth, async (request, reply) => {
    const actor = await getActor(request);
    const group = await groupOr404(request.params.id, reply);
    if (!group) return reply;
    if (!(await canChat(actor, group))) return reply.code(403).send({ error: 'You are not part of this group.' });
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.tr_number, u.class_name, u.role, b.name AS branch_name, m.member_role
       FROM student_group_members m JOIN users u ON u.id = m.user_id LEFT JOIN branches b ON b.id = u.branch_id
       WHERE m.group_id = $1 AND u.deleted_at IS NULL ORDER BY u.name`,
      [group.id],
    );
    const members: GroupMember[] = rows.map((r: any) => ({
      userId: String(r.id), name: String(r.name), trNumber: r.tr_number ?? null, className: r.class_name ?? null,
      branchName: r.branch_name ?? null, role: String(r.role), memberRole: String(r.member_role ?? 'member'),
    }));
    return members;
  });

  /** Students who could be added: search by name / TR within the group's branch (master + cross-branch group: any branch). */
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/groups/:id/candidates', staff, async (request, reply) => {
    const actor = await getActor(request);
    const group = await groupOr404(request.params.id, reply);
    if (!group) return reply;
    if (!canManageGroup(actor, group)) return reply.code(403).send({ error: 'Only staff of this branch can add people.' });
    const q = (request.query.q ?? '').trim().slice(0, 80);
    const p = new SqlParams();
    const where = [`u.role = 'student'`, `u.deleted_at IS NULL`, `u.id NOT IN (SELECT m.user_id FROM student_group_members m WHERE m.group_id = ${p.add(group.id)})`];
    const branch = group.branch_id ?? (actor.isMaster ? null : actor.branchId);
    if (branch) where.push(`u.branch_id = ${p.add(branch)}`);
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
      where.push(`(u.name LIKE ${p.add(like)} OR u.tr_number LIKE ${p.add(like)} OR u.class_name LIKE ${p.add(like)})`);
    }
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.tr_number, u.class_name, b.name AS branch_name
       FROM users u LEFT JOIN branches b ON b.id = u.branch_id
       WHERE ${where.join(' AND ')} ORDER BY u.name LIMIT 30`,
      p.values,
    );
    const out: GroupCandidate[] = rows.map((r: any) => ({ userId: String(r.id), name: String(r.name), trNumber: r.tr_number ?? null, className: r.class_name ?? null, branchName: r.branch_name ?? null }));
    return out;
  });

  app.post<{ Params: { id: string }; Body: { userIds?: string[] } }>('/groups/:id/members', staff, async (request, reply) => {
    const actor = await getActor(request);
    const group = await groupOr404(request.params.id, reply);
    if (!group) return reply;
    if (!canManageGroup(actor, group)) return reply.code(403).send({ error: 'Only staff of this branch can add people.' });
    const ids = Array.isArray(request.body?.userIds) ? [...new Set(request.body!.userIds!.filter(id => typeof id === 'string'))].slice(0, 500) : [];
    if (!ids.length) return reply.code(400).send({ error: 'Choose at least one student.' });

    const p = new SqlParams();
    const where = [`u.id IN (${p.list(ids)})`, `u.deleted_at IS NULL`, `u.role = 'student'`];
    const branch = group.branch_id ?? (actor.isMaster ? null : actor.branchId);
    if (branch) where.push(`u.branch_id = ${p.add(branch)}`);
    const { rows: allowed } = await pool.query(`SELECT u.id FROM users u WHERE ${where.join(' AND ')}`, p.values);
    const okIds = allowed.map((r: any) => String(r.id));
    if (!okIds.length) return reply.code(400).send({ error: 'These students cannot be added to this group (different branch?).' });

    const values: unknown[] = [];
    const tuples = okIds.map(id => { values.push(group.id, id); return `($${values.length - 1}, $${values.length})`; });
    const result = await pool.query(`INSERT IGNORE INTO student_group_members (group_id, user_id) VALUES ${tuples.join(', ')}`, values);

    const nValues: unknown[] = [];
    const nTuples = okIds.map(id => {
      nValues.push(id, 'group_added', JSON.stringify({ groupId: group.id, title: group.name, message: `You were added to the group “${group.name}”. Open Community to see it.` }));
      return `($${nValues.length - 2}, $${nValues.length - 1}, $${nValues.length})`;
    });
    await pool.query(`INSERT INTO notifications (user_id, type, payload) VALUES ${nTuples.join(', ')}`, nValues);
    await logAudit({ actorId: actor.id, branchId: group.branch_id, action: 'group.members_add', entityType: 'student_group', entityId: group.id, summary: `${okIds.length} added to “${group.name}”`, after: { userIds: okIds } });
    return { added: result.rowCount, skipped: ids.length - okIds.length };
  });

  app.delete<{ Params: { id: string; userId: string } }>('/groups/:id/members/:userId', auth, async (request, reply) => {
    const actor = await getActor(request);
    const group = await groupOr404(request.params.id, reply);
    if (!group) return reply;
    const self = request.params.userId === actor.id; // a student may leave a group
    if (!self && !canManageGroup(actor, group)) return reply.code(403).send({ error: 'Only staff of this branch can remove people.' });
    await pool.query(`DELETE FROM student_group_members WHERE group_id = $1 AND user_id = $2`, [group.id, request.params.userId]);
    await logAudit({ actorId: actor.id, branchId: group.branch_id, action: 'group.members_remove', entityType: 'student_group', entityId: group.id, summary: self ? `Left “${group.name}”` : `Removed a member from “${group.name}”`, before: { userId: request.params.userId } });
    return { ok: true };
  });

  // ---- Chat
  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>('/groups/:id/messages', auth, async (request, reply) => {
    const actor = await getActor(request);
    const group = await groupOr404(request.params.id, reply);
    if (!group) return reply;
    if (!(await canChat(actor, group))) return reply.code(403).send({ error: 'You are not part of this group.' });
    const limit = Math.min(500, Math.max(1, Number(request.query.limit) || 200));
    const after = toDate(request.query.after);
    const p = new SqlParams();
    const where = [`gm.group_id = ${p.add(group.id)}`];
    if (after) where.push(`gm.created_at > ${p.add(after)}`);
    // newest N, returned oldest first
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT gm.id, gm.group_id, gm.sender_id, gm.body, gm.attachments, gm.created_at, u.name AS sender_name, u.role AS sender_role
         FROM group_messages gm LEFT JOIN users u ON u.id = gm.sender_id
         WHERE ${where.join(' AND ')}
         ORDER BY gm.created_at DESC LIMIT ${limit}
       ) x ORDER BY x.created_at ASC`,
      p.values,
    );
    return rows.map(toMessage);
  });

  app.post<{ Params: { id: string }; Body: { body?: string | null; attachments?: Attachment[] } }>('/groups/:id/messages', auth, async (request, reply) => {
    const actor = await getActor(request);
    const group = await groupOr404(request.params.id, reply);
    if (!group) return reply;
    if (group.archived_at) return reply.code(409).send({ error: 'This group is archived. Messages are read-only.' });
    if (!(await canChat(actor, group))) return reply.code(403).send({ error: 'You are not part of this group.' });
    const text = typeof request.body?.body === 'string' ? request.body.body.trim() : '';
    const attachments = cleanAttachments(request.body?.attachments);
    if (attachments === null) return reply.code(400).send({ error: 'Those attachments could not be read.' });
    if (!text && !attachments.length) return reply.code(400).send({ error: 'Write a message or attach a file.' });
    if (text.length > 4000) return reply.code(400).send({ error: 'The message is too long.' });

    const { rows } = await pool.query(
      `INSERT INTO group_messages (group_id, sender_id, body, attachments) VALUES ($1, $2, $3, $4) RETURNING id`,
      [group.id, actor.id, text || null, JSON.stringify(attachments)],
    );
    const id = String(rows[0].id);

    // Staff messages (instructions, delegation) ping the students; student chatter does not.
    if (actor.isStaff) {
      const preview = text ? (text.length > 140 ? `${text.slice(0, 137)}…` : text) : 'shared a file';
      await pool.query(
        `INSERT INTO notifications (user_id, type, payload)
         SELECT m.user_id, 'group_message', $1 FROM student_group_members m WHERE m.group_id = $2 AND m.user_id <> $3`,
        [JSON.stringify({ groupId: group.id, title: group.name, message: `${actor.name} in “${group.name}”: ${preview}` }), group.id, actor.id],
      );
    }

    const created = await pool.query(
      `SELECT gm.id, gm.group_id, gm.sender_id, gm.body, gm.attachments, gm.created_at, u.name AS sender_name, u.role AS sender_role
       FROM group_messages gm LEFT JOIN users u ON u.id = gm.sender_id WHERE gm.id = $1`,
      [id],
    );
    return reply.code(201).send(toMessage(created.rows[0]));
  });
}
