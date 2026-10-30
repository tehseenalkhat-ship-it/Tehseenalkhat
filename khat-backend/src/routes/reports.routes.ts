import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { buildStorageKey, putObjectBytes } from '../storage.js';
import type { AuthUser } from '../plugins/auth.js';
import { createRateLimiter, decodeScreenshot, logError } from '../services/problemReports.js';

type ReportBody = {
  text?: string;
  page?: string;
  browserInfo?: unknown;
  recentErrors?: unknown;
  screenshot?: string;
};
type AnswerBody = { answer?: string; reply?: string; screenshot?: string; tokens?: string[] };
type ClientLogBody = { message?: string; stack?: string; url?: string };

const reportLimiter = createRateLimiter(20, 60 * 60 * 1000); // 20 reports per IP per hour
const answerLimiter = createRateLimiter(30, 60 * 60 * 1000);
const clientLogLimiter = createRateLimiter(60, 60 * 60 * 1000);
const recentClientErrors = new Map<string, number>(); // `${ip}|${message}` -> last seen, to drop repeats
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

const SCREENSHOT_BODY_LIMIT = 5 * 1024 * 1024; // base64 of a 3 MB image plus the text fields

/** The signed-in user if the request carries a valid token, otherwise null (reporting works signed out). */
async function optionalUser(request: FastifyRequest): Promise<AuthUser | null> {
  if (!request.headers.authorization) return null;
  try {
    await request.jwtVerify();
    return request.user as AuthUser;
  } catch {
    return null;
  }
}

function cleanTokens(tokens: unknown): string[] {
  return Array.isArray(tokens) ? tokens.filter((t): t is string => typeof t === 'string' && /^[0-9a-f]{64}$/.test(t)).slice(0, 20) : [];
}

function toJsonText(value: unknown, max: number): string | null {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.slice(0, max);
}

async function saveScreenshot(dataUrl: unknown): Promise<{ key: string | null } | { error: string }> {
  const decoded = decodeScreenshot(dataUrl);
  if (!decoded) return { key: null };
  if ('error' in decoded) return decoded;
  const key = buildStorageKey('reports', `screenshot.${decoded.ext}`);
  await putObjectBytes(key, decoded.body, `image/${decoded.ext === 'jpg' ? 'jpeg' : decoded.ext}`);
  return { key };
}

export async function reportRoutes(app: FastifyInstance) {
  // ---- Send a report (signed in or not) ----
  app.post<{ Body: ReportBody }>('/reports', { bodyLimit: SCREENSHOT_BODY_LIMIT }, async (request, reply) => {
    if (!reportLimiter(request.ip)) {
      return reply.code(429).send({ error: 'Too many reports from this connection. Please try again in an hour.' });
    }
    const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
    if (!text) return reply.code(400).send({ error: 'Please describe what went wrong.' });
    if (text.length > 5000) return reply.code(400).send({ error: 'Please keep the description under 5,000 characters.' });

    const shot = await saveScreenshot(request.body.screenshot);
    if ('error' in shot) return reply.code(400).send({ error: shot.error });

    const user = await optionalUser(request);
    let personRole = 'anonymous';
    let name: string | null = null;
    if (user) {
      const { rows } = await pool.query(`SELECT name FROM users WHERE id = $1`, [user.id]);
      name = rows[0]?.name ?? null;
      personRole = user.role === 'teacher' && user.isCoordinator ? 'coordinator' : user.role;
    }

    const id = randomUUID();
    const reporterToken = randomBytes(32).toString('hex'); // lets a signed-out reporter see "we fixed it" later
    await pool.query(
      `INSERT INTO problem_reports (id, person_role, person_id, name, page, text, screenshot, browser_info, recent_errors, reporter_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        personRole,
        user?.id ?? null,
        name,
        typeof request.body.page === 'string' ? request.body.page.slice(0, 2000) : null,
        text,
        shot.key,
        toJsonText(request.body.browserInfo, 4000),
        toJsonText(request.body.recentErrors, 20000),
        reporterToken,
      ]
    );
    return reply.code(201).send({ id, reporterToken });
  });

  // ---- Reports marked fixed that this person hasn't answered yet ----
  app.post<{ Body: { tokens?: string[] } }>('/reports/pending', async (request) => {
    const user = await optionalUser(request);
    const tokens = cleanTokens(request.body?.tokens);
    if (!user && tokens.length === 0) return { reports: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (user) {
      params.push(user.id);
      conditions.push(`person_id = $${params.length}`);
    }
    if (tokens.length) {
      const placeholders = tokens.map((t) => {
        params.push(t);
        return `$${params.length}`;
      });
      conditions.push(`reporter_token IN (${placeholders.join(', ')})`);
    }
    const { rows } = await pool.query(
      `SELECT id, text, page, fix_note, fixed_at, created_at FROM problem_reports
       WHERE fixed_at IS NOT NULL AND answer IS NULL AND (${conditions.join(' OR ')})
       ORDER BY fixed_at DESC LIMIT 10`,
      params
    );
    return { reports: rows };
  });

  // ---- The reporter answers: it works now / still a problem ----
  app.post<{ Params: { id: string }; Body: AnswerBody }>(
    '/reports/:id/answer',
    { bodyLimit: SCREENSHOT_BODY_LIMIT },
    async (request, reply) => {
      if (!answerLimiter(request.ip)) return reply.code(429).send({ error: 'Too many answers. Please try again later.' });
      const answer = request.body?.answer;
      if (answer !== 'works' && answer !== 'still') return reply.code(400).send({ error: "answer must be 'works' or 'still'" });

      const { rows } = await pool.query(
        `SELECT id, person_id, reporter_token, fixed_at, answer FROM problem_reports WHERE id = $1`,
        [request.params.id]
      );
      const report = rows[0];
      if (!report) return reply.code(404).send({ error: 'Report not found' });

      const user = await optionalUser(request);
      const tokens = cleanTokens(request.body.tokens);
      const isReporter = (user && report.person_id === user.id) || (report.reporter_token && tokens.includes(report.reporter_token));
      if (!isReporter) return reply.code(403).send({ error: 'Only the person who reported this can answer.' });
      if (!report.fixed_at || report.answer) return reply.code(409).send({ error: 'This report is not waiting for an answer.' });

      if (answer === 'works') {
        await pool.query(`UPDATE problem_reports SET answer = 'works', answered_at = CURRENT_TIMESTAMP(6) WHERE id = $1`, [report.id]);
        return { ok: true };
      }

      const replyText = typeof request.body.reply === 'string' ? request.body.reply.trim() : '';
      if (!replyText) return reply.code(400).send({ error: 'Please tell us what still goes wrong.' });
      if (replyText.length > 5000) return reply.code(400).send({ error: 'Please keep the reply under 5,000 characters.' });
      const shot = await saveScreenshot(request.body.screenshot);
      if ('error' in shot) return reply.code(400).send({ error: shot.error });

      await pool.query(
        `UPDATE problem_reports SET answer = 'still', answered_at = CURRENT_TIMESTAMP(6), reply = $1, reply_shot = $2 WHERE id = $3`,
        [replyText, shot.key, report.id]
      );
      return { ok: true };
    }
  );

  // ---- Browser errors (window.onerror / unhandledrejection) ----
  app.post<{ Body: ClientLogBody }>('/clientlog', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const message = typeof request.body?.message === 'string' ? request.body.message.trim().slice(0, 2000) : '';
    if (!message) return reply.code(400).send({ error: 'message is required' });

    const dedupeKey = `${request.ip}|${message}`;
    const now = Date.now();
    const lastSeen = recentClientErrors.get(dedupeKey);
    if (lastSeen && now - lastSeen < DUPLICATE_WINDOW_MS) return reply.code(202).send({ ok: true, duplicate: true });
    if (!clientLogLimiter(request.ip)) return reply.code(429).send({ error: 'Too many error reports' });
    recentClientErrors.set(dedupeKey, now);
    if (recentClientErrors.size > 5000) {
      for (const [key, seen] of recentClientErrors) if (now - seen >= DUPLICATE_WINDOW_MS) recentClientErrors.delete(key);
    }

    const user = await optionalUser(request);
    await logError({
      source: 'browser',
      message,
      stack: typeof request.body.stack === 'string' ? request.body.stack : null,
      url: typeof request.body.url === 'string' ? request.body.url : null,
      person: user ? `${user.role}:${user.id}` : 'anonymous',
    });
    return reply.code(202).send({ ok: true });
  });
}
