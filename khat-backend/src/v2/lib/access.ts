import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../../db.js';
import type { AuthUser } from '../../plugins/auth.js';
import type { AdminScope } from '../contracts.js';

/**
 * Who is calling, with the v2 permission facts resolved from the database
 * (the JWT only carries id/role/branch). Cached briefly per user.
 *
 *   master admin  = role 'admin' + admin_scope 'master' (Nairobi team): fundamentals, all branches
 *   branch admin  = role 'admin' + admin_scope 'branch': only their branch's policies, people, moderation
 *   coordinator   = teacher with is_coordinator: branch-level read + review
 *   teacher       = reviews students of their branch (shared branch inbox)
 */
export type Actor = AuthUser & {
  name: string;
  email: string;
  adminScope: AdminScope | null;
  isMaster: boolean;
  isBranchAdmin: boolean;
  isStaff: boolean; // teacher, coordinator or any admin
};

const cache = new Map<string, { actor: Actor; at: number }>();
const TTL_MS = 60_000;

export async function getActor(request: FastifyRequest): Promise<Actor> {
  const user = request.user as AuthUser;
  const hit = cache.get(user.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.actor;
  const { rows } = await pool.query(
    `SELECT id, name, email, role, branch_id, is_coordinator, admin_scope FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [user.id],
  );
  const row = rows[0];
  const role = (row?.role ?? user.role) as AuthUser['role'];
  const adminScope: AdminScope | null = role === 'admin' ? ((row?.admin_scope === 'branch' ? 'branch' : 'master') as AdminScope) : null;
  const actor: Actor = {
    id: user.id,
    role,
    branchId: row?.branch_id ?? user.branchId,
    isCoordinator: Boolean(row?.is_coordinator ?? user.isCoordinator),
    name: row?.name ?? '',
    email: row?.email ?? '',
    adminScope,
    isMaster: adminScope === 'master',
    isBranchAdmin: adminScope === 'branch',
    isStaff: role === 'teacher' || role === 'admin',
  };
  cache.set(user.id, { actor, at: Date.now() });
  return actor;
}

export function clearActorCache(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

/** Master admins manage every branch; branch admins only their own. */
export function canManageBranch(actor: Actor, branchId: string): boolean {
  return actor.isMaster || (actor.isBranchAdmin && actor.branchId === branchId);
}

/** Staff may see a student's work when they belong to the same branch, or are master admins. */
export function canSeeBranch(actor: Actor, branchId: string): boolean {
  return actor.isMaster || (actor.isStaff && actor.branchId === branchId);
}

function deny(reply: FastifyReply, message: string) {
  reply.code(403).send({ error: message });
}

/** preHandlers — use after app.authenticate */
export function requireMaster(_app?: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await getActor(request);
    if (!actor.isMaster) deny(reply, 'Only the master admin team can change this.');
  };
}
export function requireAnyAdmin(_app?: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await getActor(request);
    if (actor.role !== 'admin') deny(reply, 'Admins only.');
  };
}
export function requireStaff(_app?: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await getActor(request);
    if (!actor.isStaff) deny(reply, 'Teachers and admins only.');
  };
}
