import type { FastifyInstance, FastifyReply } from 'fastify';
import { pool } from '../../db.js';
import { clearActorCache, getActor, requireAnyAdmin } from '../lib/access.js';
import { logAudit } from '../lib/audit.js';
import { checkRoleChange, personRole, ROLE_WORDS, roleColumns } from '../lib/commsLogic.js';
import type { PeopleResponse, Person, PersonChange, PersonRole } from '../lib/commsTypes.js';
import { iso } from '../lib/threadData.js';

// owner: admin-comms (v3 note 6.4) — People & roles: one simple list, a toggle per person.
// Registered under prefix '/v2'. Master admins change roles and branches; branch admins can look.

function bad(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

const ROLES: PersonRole[] = ['student', 'teacher', 'branch_admin', 'master_admin'];

const SELECT = `SELECT u.id, u.name, u.email, u.tr_number, u.role, u.admin_scope, u.is_coordinator, u.branch_id, u.created_at, b.name AS branch_name
  FROM users u LEFT JOIN branches b ON b.id = u.branch_id`;

function mapPerson(r: any): Person {
  return {
    id: r.id, name: r.name ?? '', email: r.email ?? '', trNumber: r.tr_number ?? null, role: personRole(r),
    isCoordinator: Boolean(r.is_coordinator), branchId: r.branch_id, branchName: r.branch_name ?? '', createdAt: iso(r.created_at),
  };
}

export async function peopleV2Routes(app: FastifyInstance): Promise<void> {
  const admins = { preHandler: [app.authenticate, requireAnyAdmin(app)] };

  app.get<{ Querystring: { q?: string; branchId?: string; role?: string; limit?: string } }>('/people', admins, async request => {
    const actor = await getActor(request);
    const params: unknown[] = [];
    const cond = ['u.deleted_at IS NULL'];
    const branchId = actor.isMaster ? request.query.branchId || null : actor.branchId;
    if (branchId) { params.push(branchId); cond.push(`u.branch_id = $${params.length}`); }
    const scopeWhere = cond.join(' AND ');
    const role = ROLES.includes(request.query.role as PersonRole) ? (request.query.role as PersonRole) : null;
    if (role) {
      const c = roleColumns(role);
      params.push(c.role); cond.push(`u.role = $${params.length}`);
      if (c.role === 'admin') { params.push(c.adminScope); cond.push(`u.admin_scope = $${params.length}`); }
    } else {
      cond.push(`u.role IN ('teacher', 'admin')`); // default: the staff list
    }
    const q = (request.query.q ?? '').trim();
    if (q) { params.push(`%${q}%`); cond.push(`(u.name LIKE $${params.length} OR u.email LIKE $${params.length} OR u.tr_number LIKE $${params.length})`); }
    const limit = Math.min(300, Math.max(1, Number(request.query.limit) || 200));
    const [list, counts] = await Promise.all([
      pool.query(`${SELECT} WHERE ${cond.join(' AND ')} ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'teacher' THEN 1 ELSE 2 END, b.name, u.name LIMIT ${limit}`, params),
      pool.query(`SELECT u.role, u.admin_scope, COUNT(*) AS n FROM users u WHERE ${scopeWhere} GROUP BY u.role, u.admin_scope`, branchId ? [branchId] : []),
    ]);
    const tally: Record<PersonRole, number> = { student: 0, teacher: 0, branch_admin: 0, master_admin: 0 };
    for (const r of counts.rows) tally[personRole(r)] += Number(r.n ?? 0);
    const body: PeopleResponse = { people: list.rows.map(mapPerson), total: list.rows.length, canEdit: actor.isMaster, counts: tally };
    return body;
  });

  app.patch<{ Params: { id: string }; Body: PersonChange }>('/people/:id', admins, async (request, reply) => {
    const actor = await getActor(request);
    if (!actor.isMaster) return bad(reply, 403, 'Only the master admin team can change roles.');
    const { rows } = await pool.query(`${SELECT} WHERE u.id = $1 AND u.deleted_at IS NULL`, [request.params.id]);
    if (!rows[0]) return bad(reply, 404, 'This person was not found.');
    const before = mapPerson(rows[0]);
    const body = request.body ?? {};
    const to = body.role ?? before.role;
    if (!ROLES.includes(to)) return bad(reply, 400, 'Please choose a role.');
    const { rows: m } = await pool.query(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND admin_scope = 'master' AND deleted_at IS NULL`);
    const problem = checkRoleChange({ actorIsMaster: actor.isMaster, actorId: actor.id, targetId: before.id, from: before.role, to, masterCount: Number(m[0]?.n ?? 0) });
    if (problem) return bad(reply, problem.startsWith('Only') ? 403 : 409, problem);
    let branchId = before.branchId;
    let branchName = before.branchName;
    if (body.branchId && body.branchId !== before.branchId) {
      const { rows: b } = await pool.query(`SELECT id, name FROM branches WHERE id = $1`, [body.branchId]);
      if (!b[0]) return bad(reply, 404, 'Branch not found.');
      branchId = b[0].id; branchName = b[0].name;
    }
    const isCoordinator = to === 'teacher' ? (body.isCoordinator ?? before.isCoordinator) : false;
    const cols = roleColumns(to);
    await pool.query(`UPDATE users SET role = $1, admin_scope = $2, branch_id = $3, is_coordinator = $4 WHERE id = $5`, [cols.role, cols.adminScope, branchId, isCoordinator, before.id]);
    clearActorCache(before.id);
    const changes: string[] = [];
    if (to !== before.role) changes.push(`${ROLE_WORDS[before.role]} → ${ROLE_WORDS[to]}`);
    if (branchId !== before.branchId) changes.push(`${before.branchName} → ${branchName}`);
    if (isCoordinator !== before.isCoordinator) changes.push(isCoordinator ? 'now coordinator' : 'no longer coordinator');
    if (changes.length) {
      await logAudit({
        actorId: actor.id, branchId, action: 'people.change', entityType: 'user', entityId: before.id,
        summary: `${before.name}: ${changes.join(', ')}`,
        before: { role: before.role, branchId: before.branchId, isCoordinator: before.isCoordinator }, after: { role: to, branchId, isCoordinator },
      });
    }
    const { rows: after } = await pool.query(`${SELECT} WHERE u.id = $1`, [before.id]);
    return { person: mapPerson(after[0]), note: changes.length && to !== before.role ? `${before.name.split(/\s+/)[0]} will see the change the next time they sign in.` : null };
  });

  app.get<{ Params: { id: string } }>('/people/:id/history', admins, async (request, reply) => {
    const actor = await getActor(request);
    if (!actor.isMaster) return bad(reply, 403, 'Only the master admin team can see this.');
    const { rows } = await pool.query(
      `SELECT a.summary, a.created_at, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.entity_type = 'user' AND a.entity_id = $1 ORDER BY a.created_at DESC LIMIT 20`, [request.params.id]);
    return rows.map((r: any) => ({ summary: r.summary, at: iso(r.created_at), by: r.actor_name ?? null }));
  });
}
