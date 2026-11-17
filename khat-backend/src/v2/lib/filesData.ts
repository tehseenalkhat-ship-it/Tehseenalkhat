/**
 * backend-files database + storage helpers shared by downloads / print / competitions routes.
 * Pure helpers live in filesLogic.ts.
 */
import { pool } from '../../db.js';
import { getObjectBytes } from '../../storage.js';
import { getEffectivePolicies } from './policies.js';
import type { StampOptions, StampProfile } from './pdfStamp.js';
import { stampFieldsFrom, watermarkSettingFrom } from './filesLogic.js';

// ---------- Database + storage ----------
export type StudentProfileRow = StampProfile & { id: string; branchId: string };

export async function loadProfile(userId: string): Promise<StudentProfileRow | null> {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.tr_number, u.class_name, u.branch_id, b.name AS branch_name
       FROM users u LEFT JOIN branches b ON b.id = u.branch_id
      WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, name: r.name ?? '', email: r.email ?? null, trNumber: r.tr_number ?? null, className: r.class_name ?? null, branchName: r.branch_name ?? null, branchId: r.branch_id };
}

const watermarkCache = new Map<string, { bytes: Uint8Array; at: number }>();
const WATERMARK_TTL_MS = 10 * 60_000;

async function watermarkBytes(storageKey: string | null): Promise<Uint8Array | null> {
  if (!storageKey) return null;
  const hit = watermarkCache.get(storageKey);
  if (hit && Date.now() - hit.at < WATERMARK_TTL_MS) return hit.bytes;
  try {
    const { body } = await getObjectBytes(storageKey);
    const bytes = new Uint8Array(body);
    watermarkCache.set(storageKey, { bytes, at: Date.now() });
    return bytes;
  } catch (error) {
    console.error('[v2 files] watermark could not be loaded', error);
    return null;
  }
}

/** Everything the stamper needs for one student, from the branch's effective policies. */
export async function stampOptionsFor(profile: StudentProfileRow, documentTitle?: string | null): Promise<StampOptions> {
  const policies = await getEffectivePolicies(profile.branchId ?? null);
  const wm = watermarkSettingFrom(policies['downloads.watermark']);
  return {
    profile,
    fields: stampFieldsFrom(policies['downloads.stamp_fields']),
    watermark: { bytes: await watermarkBytes(wm.storageKey), opacity: wm.opacity, position: wm.position, scale: wm.scale },
    copyrightText: typeof policies['downloads.copyright_text'] === 'string' ? (policies['downloads.copyright_text'] as string) : '',
    date: new Date(),
    timeZone: 'Africa/Nairobi',
    documentTitle: documentTitle ?? null,
  };
}

export async function fetchBytes(storageKey: string): Promise<Uint8Array | null> {
  try {
    const { body } = await getObjectBytes(storageKey);
    return new Uint8Array(body);
  } catch (error) {
    console.error('[v2 files] could not load', storageKey, error);
    return null;
  }
}

/** One INSERT for many students (700 per branch) instead of a query per student. Never throws. */
export async function notifyStudentsOfBranches(branchIds: string[] | null, type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    if (branchIds && branchIds.length === 0) return;
    const params: unknown[] = [type, JSON.stringify(payload)];
    let where = `role = 'student' AND deleted_at IS NULL`;
    if (branchIds) {
      where += ` AND branch_id IN (${branchIds.map((id, i) => { params.push(id); return `$${i + 3}`; }).join(', ')})`;
    }
    await pool.query(`INSERT INTO notifications (user_id, type, payload) SELECT id, $1, $2 FROM users WHERE ${where}`, params);
  } catch (error) {
    console.error('[v2 files] notifyStudentsOfBranches failed', error);
  }
}

export async function safeNotify(userId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await pool.query(`INSERT INTO notifications (user_id, type, payload) VALUES ($1, $2, $3)`, [userId, type, JSON.stringify(payload)]);
  } catch (error) {
    console.error('[v2 files] notify failed', error);
  }
}
