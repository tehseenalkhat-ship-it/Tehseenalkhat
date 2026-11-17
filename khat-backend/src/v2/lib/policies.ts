import { pool } from '../../db.js';
import type { EffectivePolicies, PolicyKey, PolicyRow, RubricCriterion, WatermarkSetting, MarkBand } from '../contracts.js';

/**
 * Policy layering: built-in DEFAULTS ← global row (master team) ← branch override.
 * A global row with locked = 1 cannot be overridden by any branch.
 * DEFAULT_LOCKED marks the fundamentals that start locked (master can unlock).
 */
export const DEFAULTS: EffectivePolicies = {
  'review.reviewers_required': 1,
  'review.turnaround_days': 3,
  'assessment.bands': { revisionMax: 5, passMax: 8 },
  'assessment.rubric': [
    { key: 'nuqta', label: 'Nuqta proportion', max: 2 },
    { key: 'form', label: 'Letter form', max: 2 },
    { key: 'spacing', label: 'Spacing', max: 2 },
    { key: 'baseline', label: 'Baseline', max: 2 },
    { key: 'pen', label: 'Pen control', max: 2 },
  ] satisfies RubricCriterion[],
  'assessment.max_attempts': 3,
  'print.instructions': 'Print on art paper only — do not practice on a normal A4 sheet. For art paper and any questions, please contact Funun al-Quran.',
  'print.allow_multi': true,
  'downloads.stamp_fields': ['name', 'email', 'tr', 'class', 'branch', 'date'],
  'downloads.watermark': { storageKey: null, opacity: 0.08, position: 'center', scale: 0.45 } satisfies WatermarkSetting,
  'downloads.copyright_text': '© Funun al-Quran. All rights reserved. For your personal practice only — do not copy, share, sell or reproduce this sheet.',
  'merit.levels_per_point': 3,
  'merit.certification_points': 10,
  'merit.monthly_cap': 10,
  'merit.officer_user_id': null,
  'merit.reminder_day': 25,
  'showcase.requires_approval': true,
  'uploads.max_files': 20,
  'student.choose_one_size': true,
  'review.divert_after_hours': 72,
  'review.auto_mark_enabled': true,
  'review.auto_mark_after_days': 4, // 96 hours
  'review.quick_marks': [4, 5, 6, 7, 8, 9, 10],
  'review.comment_templates': {
    revision: [
      'A good effort — you are on the right path. Look again at the proportions of the letters marked here, practice them once more and send it back. You will see the difference.',
      'Thank you for your careful work. A little more practice on the points marked will make this much stronger. Try once more — we are looking forward to it.',
    ],
    pass: [
      'Well done — your letters are taking good shape. Keep the same care in the next level, and keep watching the baseline and spacing.',
      'Good, steady work. Your practice is showing. Carry this into the next level with the same patience.',
    ],
    distinction: [
      'Excellent work, mashaAllah. Your control and proportions are very fine. Keep this standard in every level.',
      'Beautiful, careful writing. This is the standard we hope for — keep going.',
    ],
  } satisfies Record<MarkBand, string[]>,
  'email.student_on_reply': true,
  'email.staff_mode': 'daily_digest',
  'nudge.inactive_days': 21,
  'nudge.dormant_days': 180,
  'nudge.message_template': 'Salaam {name}, we miss your writing! It has been {days} days since your last practice in {course}. Even ten minutes today will keep your pen moving — we are here to help.',
};

export const DEFAULT_LOCKED: PolicyKey[] = [
  'downloads.stamp_fields',
  'downloads.watermark',
  'downloads.copyright_text',
];

export const POLICY_KEYS = Object.keys(DEFAULTS) as PolicyKey[];

/**
 * v3 audit: settings where a branch may only ADD to the master value, never replace it.
 * The download message ("print on art paper … contact Funun al-Quran") is always printed;
 * a branch's own value is an extra note shown on the next line.
 */
export const ADDITIVE_KEYS: PolicyKey[] = ['print.instructions'];
export const BRANCH_NOTE_MAX = 300;

/** Master text + the branch's extra note (if any) on its own line. */
export function combineAdditive(base: unknown, extra: unknown): string {
  const main = typeof base === 'string' ? base.trim() : '';
  const note = typeof extra === 'string' ? extra.trim() : '';
  if (!note || note === main) return main;
  return main ? `${main}\n${note}` : note;
}

function parse(value: unknown): unknown {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

type Row = { branch_id: string; policy_key: string; value: unknown; locked: boolean; updated_at: Date | null; updated_by: string | null };

async function loadRows(branchIds: string[]): Promise<Row[]> {
  const ids = ['', ...branchIds];
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `SELECT branch_id, policy_key, value, locked, updated_at, updated_by FROM policy_settings WHERE branch_id IN (${placeholders})`,
    ids,
  );
  return rows as Row[];
}

export async function getGlobalRows(): Promise<PolicyRow[]> {
  const rows = (await loadRows([])).filter(r => r.branch_id === '');
  return POLICY_KEYS.map(key => {
    const row = rows.find(r => r.policy_key === key);
    return {
      policyKey: key,
      value: row ? parse(row.value) : DEFAULTS[key],
      locked: row ? Boolean(row.locked) : DEFAULT_LOCKED.includes(key),
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row?.updated_by ?? null,
    };
  });
}

/** Effective policies for one branch (or global when branchId is null). */
export async function getEffectivePolicies(branchId: string | null): Promise<EffectivePolicies> {
  const rows = await loadRows(branchId ? [branchId] : []);
  const result = { ...DEFAULTS } as EffectivePolicies;
  for (const key of POLICY_KEYS) {
    const global = rows.find(r => r.branch_id === '' && r.policy_key === key);
    if (global) result[key] = parse(global.value);
    const locked = global ? Boolean(global.locked) : DEFAULT_LOCKED.includes(key);
    if (branchId && !locked) {
      const branch = rows.find(r => r.branch_id === branchId && r.policy_key === key);
      if (branch) result[key] = ADDITIVE_KEYS.includes(key) ? combineAdditive(result[key], parse(branch.value)) : parse(branch.value);
    }
  }
  return result;
}

export async function getPolicy<T = unknown>(branchId: string | null, key: PolicyKey): Promise<T> {
  return (await getEffectivePolicies(branchId))[key] as T;
}

export async function getBranchOverrides(): Promise<Record<string, Partial<Record<PolicyKey, unknown>>>> {
  const { rows } = await pool.query(`SELECT branch_id, policy_key, value FROM policy_settings WHERE branch_id <> ''`);
  const out: Record<string, Partial<Record<PolicyKey, unknown>>> = {};
  for (const row of rows as Row[]) {
    (out[row.branch_id] ??= {})[row.policy_key as PolicyKey] = parse(row.value);
  }
  return out;
}

export async function isLocked(key: PolicyKey): Promise<boolean> {
  const { rows } = await pool.query(`SELECT locked FROM policy_settings WHERE branch_id = '' AND policy_key = $1`, [key]);
  return rows[0] ? Boolean(rows[0].locked) : DEFAULT_LOCKED.includes(key);
}

export async function setPolicy(branchId: string, key: PolicyKey, value: unknown, actorId: string, locked?: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO policy_settings (branch_id, policy_key, value, locked, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP(6))
     ON DUPLICATE KEY UPDATE value = VALUES(value), locked = VALUES(locked), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
    [branchId, key, JSON.stringify(value), branchId === '' ? (locked ?? DEFAULT_LOCKED.includes(key)) : false, actorId],
  );
}

export async function clearBranchPolicy(branchId: string, key: PolicyKey): Promise<void> {
  await pool.query(`DELETE FROM policy_settings WHERE branch_id = $1 AND policy_key = $2`, [branchId, key]);
}

/** 1..10 mark → band, using the branch's bands. */
export function bandFor(mark: number, bands: { revisionMax: number; passMax: number }): MarkBand {
  if (mark <= bands.revisionMax) return 'revision';
  if (mark <= bands.passMax) return 'pass';
  return 'distinction';
}
