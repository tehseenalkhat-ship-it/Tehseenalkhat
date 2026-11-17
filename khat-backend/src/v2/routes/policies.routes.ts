import type { FastifyInstance } from 'fastify';
import { pool } from '../../db.js';
import type { PoliciesResponse, PolicyKey } from '../contracts.js';
import { canManageBranch, canSeeBranch, getActor, requireAnyAdmin, requireMaster } from '../lib/access.js';
import { logAudit } from '../lib/audit.js';
import {
  ADDITIVE_KEYS, BRANCH_NOTE_MAX, clearBranchPolicy, getBranchOverrides, getEffectivePolicies, getGlobalRows, isLocked, POLICY_KEYS, setPolicy,
} from '../lib/policies.js';
import { validatePolicyValue } from '../lib/policyValidate.js';
import { policyKeyFromEntity } from '../lib/commsLogic.js';
import type { BranchPolicyChanges } from '../lib/commsTypes.js';
import { iso } from '../lib/threadData.js';

const SEEN_MARKER = 'policy_changes_seen';

const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s && s.length > 80 ? `${s.slice(0, 77)}…` : s;
};

async function branchName(branchId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT name FROM branches WHERE id = $1`, [branchId]);
  return rows[0]?.name ?? null;
}

// Registered under prefix '/v2'
export async function policiesV2Routes(app: FastifyInstance): Promise<void> {
  app.get('/policies', { preHandler: [app.authenticate, requireAnyAdmin(app)] }, async request => {
    const actor = await getActor(request);
    const [global, overrides, branches] = await Promise.all([
      getGlobalRows(),
      getBranchOverrides(),
      pool.query(`SELECT id FROM branches ORDER BY name`),
    ]);
    const allIds = branches.rows.map(r => r.id as string);
    const editableBranchIds = actor.isMaster ? allIds : allIds.filter(id => canManageBranch(actor, id));
    const visible: PoliciesResponse['branches'] = {};
    for (const [id, o] of Object.entries(overrides)) if (actor.isMaster || id === actor.branchId) visible[id] = o;
    const body: PoliciesResponse = { global, branches: visible, editableBranchIds, canEditGlobal: actor.isMaster };
    return body;
  });

  app.get<{ Querystring: { branchId?: string } }>('/policies/effective', { preHandler: [app.authenticate] }, async request => {
    const actor = await getActor(request);
    const wanted = request.query.branchId?.trim();
    let branchId: string | null = actor.branchId ?? null;
    if (wanted && actor.isStaff && (actor.isMaster || canSeeBranch(actor, wanted))) branchId = wanted;
    return getEffectivePolicies(branchId);
  });

  app.put<{ Params: { key: string }; Body: { value?: unknown; locked?: boolean } }>(
    '/policies/global/:key',
    { preHandler: [app.authenticate, requireMaster(app)] },
    async (request, reply) => {
      const actor = await getActor(request);
      const key = request.params.key as PolicyKey;
      if (!POLICY_KEYS.includes(key)) return reply.code(404).send({ error: `Unknown setting "${request.params.key}".` });
      const body = request.body ?? {};
      if (!('value' in body)) return reply.code(400).send({ error: 'Please send a value.' });
      const problem = validatePolicyValue(key, body.value);
      if (problem) return reply.code(400).send({ error: problem });
      if (body.locked !== undefined && typeof body.locked !== 'boolean') return reply.code(400).send({ error: 'Locked must be yes or no.' });
      const before = (await getGlobalRows()).find(r => r.policyKey === key);
      const locked = body.locked ?? before?.locked;
      await setPolicy('', key, body.value, actor.id, locked);
      const lockNote = before && locked !== before.locked ? (locked ? ' and locked it for branches' : ' and unlocked it for branches') : '';
      await logAudit({
        actorId: actor.id, action: 'policy.set', entityType: 'policy', entityId: key,
        summary: `Global setting ${key} changed from ${short(before?.value)} to ${short(body.value)}${lockNote}`,
        before: before ? { value: before.value, locked: before.locked } : null,
        after: { value: body.value, locked },
      });
      return (await getGlobalRows()).find(r => r.policyKey === key);
    },
  );

  app.put<{ Params: { branchId: string; key: string }; Body: { value?: unknown } }>(
    '/policies/branch/:branchId/:key',
    { preHandler: [app.authenticate, requireAnyAdmin(app)] },
    async (request, reply) => {
      const actor = await getActor(request);
      const { branchId } = request.params;
      const key = request.params.key as PolicyKey;
      if (!canManageBranch(actor, branchId)) return reply.code(403).send({ error: 'You can only change settings for your own branch.' });
      if (!POLICY_KEYS.includes(key)) return reply.code(404).send({ error: `Unknown setting "${request.params.key}".` });
      const name = await branchName(branchId);
      if (!name) return reply.code(404).send({ error: 'Branch not found.' });
      if (await isLocked(key)) return reply.code(409).send({ error: 'The master team has locked this setting, so branches cannot change it.' });
      const body = request.body ?? {};
      if (!('value' in body)) return reply.code(400).send({ error: 'Please send a value.' });
      const problem = validatePolicyValue(key, body.value);
      if (problem) return reply.code(400).send({ error: problem });
      const before = (await getBranchOverrides())[branchId]?.[key];
      if (ADDITIVE_KEYS.includes(key)) {
        // A branch only adds its own short note under the master message; an empty note removes it.
        const note = String(body.value ?? '').trim();
        if (note.length > BRANCH_NOTE_MAX) return reply.code(400).send({ error: `Please keep your branch's note short (${BRANCH_NOTE_MAX} characters at most).` });
        if (!note) {
          await clearBranchPolicy(branchId, key);
          if (before !== undefined) {
            await logAudit({
              actorId: actor.id, branchId, action: 'policy.branch_clear', entityType: 'policy', entityId: `${branchId}:${key}`,
              summary: `${name}: removed its extra note for ${key} (was ${short(before)})`, before: { value: before },
            });
          }
          return { branchId, policyKey: key, value: '', cleared: true, effective: await getEffectivePolicies(branchId) };
        }
        body.value = note;
      }
      await setPolicy(branchId, key, body.value, actor.id);
      await logAudit({
        actorId: actor.id, branchId, action: 'policy.branch_set', entityType: 'policy', entityId: `${branchId}:${key}`,
        summary: `${name}: setting ${key} changed from ${before === undefined ? 'the global value' : short(before)} to ${short(body.value)}`,
        before: before === undefined ? null : { value: before }, after: { value: body.value },
      });
      return { branchId, policyKey: key, value: body.value, effective: await getEffectivePolicies(branchId) };
    },
  );

  app.delete<{ Params: { branchId: string; key: string } }>(
    '/policies/branch/:branchId/:key',
    { preHandler: [app.authenticate, requireAnyAdmin(app)] },
    async (request, reply) => {
      const actor = await getActor(request);
      const { branchId } = request.params;
      const key = request.params.key as PolicyKey;
      if (!canManageBranch(actor, branchId)) return reply.code(403).send({ error: 'You can only change settings for your own branch.' });
      if (!POLICY_KEYS.includes(key)) return reply.code(404).send({ error: `Unknown setting "${request.params.key}".` });
      const name = await branchName(branchId);
      if (!name) return reply.code(404).send({ error: 'Branch not found.' });
      const before = (await getBranchOverrides())[branchId]?.[key];
      await clearBranchPolicy(branchId, key);
      if (before !== undefined) {
        await logAudit({
          actorId: actor.id, branchId, action: 'policy.branch_clear', entityType: 'policy', entityId: `${branchId}:${key}`,
          summary: `${name}: setting ${key} back to the global value (was ${short(before)})`, before: { value: before },
        });
      }
      return { branchId, policyKey: key, cleared: true, effective: await getEffectivePolicies(branchId) };
    },
  );

  // ---------- v3 (admin-comms, note 6.12): "sub-admins can change policies but I must know" ----------
  // Master: every branch change, newest first, with how many are new since the last look.
  // Branch admins: their own branch's changes (no other branch is ever shown).
  app.get<{ Querystring: { limit?: string } }>('/policies/branch-changes', { preHandler: [app.authenticate, requireAnyAdmin(app)] }, async request => {
    const actor = await getActor(request);
    const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
    const params: unknown[] = [];
    let scope = '';
    if (!actor.isMaster) { params.push(actor.branchId); scope = `AND a.branch_id = $1`; }
    const [list, marker] = await Promise.all([
      pool.query(
        `SELECT a.id, a.branch_id, a.entity_id, a.summary, a.created_at, u.name AS actor_name, b.name AS branch_name
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN branches b ON b.id = a.branch_id
          WHERE a.action IN ('policy.branch_set', 'policy.branch_clear') ${scope}
          ORDER BY a.created_at DESC LIMIT ${limit}`, params),
      pool.query(`SELECT marked_at FROM user_markers WHERE user_id = $1 AND marker_key = $2`, [actor.id, SEEN_MARKER]),
    ]);
    const lastSeen = marker.rows[0]?.marked_at ? new Date(marker.rows[0].marked_at) : null;
    const changes = list.rows.map((r: any) => {
      const at = new Date(r.created_at);
      return {
        id: r.id, branchId: r.branch_id ?? null, branchName: r.branch_name ?? null, actorName: r.actor_name ?? null,
        summary: String(r.summary ?? ''), policyKey: policyKeyFromEntity(String(r.entity_id ?? '')), createdAt: iso(r.created_at) ?? '',
        isNew: actor.isMaster && (!lastSeen || at > lastSeen),
      };
    });
    const body: BranchPolicyChanges = { changes, newCount: changes.filter(c => c.isNew).length, lastSeenAt: lastSeen ? lastSeen.toISOString() : null };
    return body;
  });

  app.post('/policies/branch-changes/seen', { preHandler: [app.authenticate, requireAnyAdmin(app)] }, async request => {
    const actor = await getActor(request);
    await pool.query(
      `INSERT INTO user_markers (user_id, marker_key, marked_at) VALUES ($1, $2, $3) ON DUPLICATE KEY UPDATE marked_at = VALUES(marked_at)`,
      [actor.id, SEEN_MARKER, new Date()],
    );
    return { ok: true };
  });
}
