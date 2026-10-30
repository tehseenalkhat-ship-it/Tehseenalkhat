import { pool } from '../db.js';

// New tables for "Report a problem" and the error log. Created on startup if missing; existing
// tables and data are never touched. No foreign keys, so they can't clash with older tables.
// The same statements live in scripts/migrations/2026-10-30-problem-reports-and-error-log.sql.
export const PROBLEM_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS problem_reports (
    id CHAR(36) NOT NULL,
    person_role VARCHAR(20) NOT NULL,
    person_id CHAR(36) NULL,
    name VARCHAR(200) NULL,
    page TEXT NULL,
    text TEXT NOT NULL,
    screenshot VARCHAR(255) NULL,
    browser_info TEXT NULL,
    recent_errors MEDIUMTEXT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    fixed_at DATETIME(6) NULL,
    fix_note TEXT NULL,
    answer VARCHAR(10) NULL,
    answered_at DATETIME(6) NULL,
    reply TEXT NULL,
    reply_shot VARCHAR(255) NULL,
    reporter_token CHAR(64) NULL,
    PRIMARY KEY (id),
    INDEX problem_reports_person (person_id),
    INDEX problem_reports_token (reporter_token),
    INDEX problem_reports_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS error_log (
    id BIGINT NOT NULL AUTO_INCREMENT,
    source VARCHAR(10) NOT NULL,
    message TEXT NOT NULL,
    stack MEDIUMTEXT NULL,
    url TEXT NULL,
    person VARCHAR(255) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    INDEX error_log_created (created_at),
    INDEX error_log_source (source, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

export async function ensureProblemTables(): Promise<void> {
  for (const sql of PROBLEM_TABLES_SQL) await pool.query(sql);
}

const clip = (value: unknown, max: number) => (value == null ? null : String(value).slice(0, max));

/** Writes one row to error_log. Never throws: if the database itself is down, it falls back to the console. */
export async function logError(entry: {
  source: 'server' | 'browser';
  message: string;
  stack?: string | null;
  url?: string | null;
  person?: string | null;
}): Promise<void> {
  try {
    await pool.query(`INSERT INTO error_log (source, message, stack, url, person) VALUES ($1, $2, $3, $4, $5)`, [
      entry.source,
      clip(entry.message || '(no message)', 4000),
      clip(entry.stack, 20000),
      clip(entry.url, 2000),
      clip(entry.person, 255),
    ]);
  } catch (err) {
    console.error('Could not write to error_log', err, entry);
  }
}

/** Fixed-window counter per key (an IP address). Single-process app, so memory is enough. */
export function createRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return function allow(key: string): boolean {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

/** Decodes a `data:image/...;base64,` screenshot and checks it really is a JPEG, PNG or WebP. */
export function decodeScreenshot(dataUrl: unknown): { body: Buffer; ext: 'jpg' | 'png' | 'webp' } | { error: string } | null {
  if (dataUrl == null || dataUrl === '') return null;
  const match = typeof dataUrl === 'string' ? /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
  if (!match) return { error: 'The screenshot must be a JPG, PNG or WebP image.' };
  const body = Buffer.from(match[2], 'base64');
  if (body.length === 0) return { error: 'The screenshot is empty.' };
  if (body.length > 3 * 1024 * 1024) return { error: 'The screenshot is too large (max 3 MB).' };
  const isJpeg = body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  const isPng = body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP';
  if (isJpeg) return { body, ext: 'jpg' };
  if (isPng) return { body, ext: 'png' };
  if (isWebp) return { body, ext: 'webp' };
  return { error: 'The screenshot does not look like a real image.' };
}

export type ReportStatus = 'New' | 'Fixed' | 'Confirmed working' | 'Still a problem';

export function reportStatus(row: { fixed_at: unknown; answer: string | null }): ReportStatus {
  if (row.answer === 'works') return 'Confirmed working';
  if (row.answer === 'still') return 'Still a problem';
  return row.fixed_at ? 'Fixed' : 'New';
}
