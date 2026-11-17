import { pool } from '../../db.js';

export type AuditInput = {
  actorId: string | null;
  branchId?: string | null;
  action: string;          // e.g. 'course.update', 'step.create', 'policy.set', 'file.replace'
  entityType: string;      // 'course' | 'level' | 'step' | 'step_file' | 'policy' | 'merit' | ...
  entityId: string;
  summary: string;         // plain words for the history list
  before?: unknown;
  after?: unknown;
};

/** Never throws: history must not block the real change. */
export async function logAudit(input: AuditInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, branch_id, action, entity_type, entity_id, summary, before_json, after_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.actorId,
        input.branchId ?? null,
        input.action,
        input.entityType,
        input.entityId,
        input.summary,
        input.before === undefined ? null : JSON.stringify(input.before),
        input.after === undefined ? null : JSON.stringify(input.after),
      ],
    );
  } catch (error) {
    console.error('audit_log insert failed', error);
  }
}
