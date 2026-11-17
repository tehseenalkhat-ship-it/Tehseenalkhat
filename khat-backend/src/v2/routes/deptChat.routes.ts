/**
 * "Chat with Funun al-Quran Department" (owner: chat).
 * One conversation per student; every staff member of the student's branch can answer
 * (shared inbox, like the review threads); master admins see every branch.
 *
 *   GET  /v2/dept-chat                          student: own conversation summary · staff: list of conversations
 *   GET  /v2/dept-chat/:studentId/messages      messages (marks them read for the caller)
 *   POST /v2/dept-chat/:studentId/messages      {kind: text|files|voice, body?, attachments?, meta?, event?: 'meet_request'}
 *   POST /v2/ai/chat-assist                     staff: {mode: polish|ask|reply, text, studentName?, context?} → {answer, usedAi}
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { pool } from '../../db.js';
import type { Attachment } from '../contracts.js';
import { canSeeBranch, getActor, requireStaff } from '../lib/access.js';
import type { Actor } from '../lib/access.js';
import { getEffectivePolicies } from '../lib/policies.js';
import { parseJson } from '../lib/reviewLogic.js';
import { clockNow, iso, loadStudent, sanitiseAttachments } from '../lib/threadData.js';
import { notifyDeptReply } from '../lib/threadNotify.js';
import {
  buildAssistPrompt, DEPARTMENT_CHAT_NAME, MEET_REQUEST_TEXT, messagePreview, normaliseAssist, offlineAssist,
  sanitiseVoiceMeta, shouldEmailStaff, sortDeptThreads, tidyAssist,
} from '../lib/chatLogic.js';
import { CHAT_SIGN_OFF, chatLink, sendChatEmail } from '../lib/chatEmail.js';

/** Same as ThreadMessage minus `stepId` (+ readByStaff). Mirrored in khat-frontend/src/v2/dept/types.ts. */
export type DeptMessage = {
  id: string;
  studentId: string;
  senderId: string;
  senderName: string;
  senderRole: 'student' | 'teacher' | 'admin' | 'system';
  kind: 'text' | 'files' | 'voice' | 'system';
  body: string | null;
  attachments: Attachment[];
  meta: Record<string, unknown>;
  createdAt: string;
  readByStudent: boolean;
  readByStaff: boolean;
};
export type DeptThreadSummary = {
  studentId: string; name: string; trNumber: string | null; className: string | null; branchId: string; branchName: string | null;
  lastAt: string | null; lastPreview: string | null; lastFromStudent: boolean; unread: number;
};

const UUIDish = /^[0-9a-f-]{8,36}$/i;
const bad = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });

function mapDept(r: any): DeptMessage {
  const role = ['student', 'teacher', 'admin', 'system'].includes(r.sender_role) ? r.sender_role : 'system';
  const meta = parseJson<Record<string, unknown>>(r.meta, {});
  return {
    id: r.id,
    studentId: r.student_id,
    senderId: r.sender_id ?? '',
    senderName: r.sender_name ?? (role === 'system' ? 'Tehseen al-Khat' : DEPARTMENT_CHAT_NAME),
    senderRole: role,
    kind: ['text', 'files', 'voice', 'system'].includes(r.kind) ? r.kind : 'text',
    body: r.body ?? null,
    attachments: sanitiseAttachments(r.attachments, 50),
    meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {},
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
    readByStudent: role === 'student' ? true : Boolean(r.student_read_at),
    readByStaff: role === 'student' ? Boolean(r.staff_read_at) : true,
  };
}

async function staffMaySee(actor: Actor, branchId: string): Promise<boolean> {
  return actor.isStaff && canSeeBranch(actor, branchId);
}

async function loadDeptMessage(id: string): Promise<DeptMessage | null> {
  const { rows } = await pool.query(
    `SELECT dm.*, u.name AS sender_name FROM dept_messages dm LEFT JOIN users u ON u.id = dm.sender_id WHERE dm.id = $1`, [id],
  );
  return rows[0] ? mapDept(rows[0]) : null;
}

async function askModel(system: string, user: string): Promise<string | null> {
  if (!config.assistant.baseUrl || !config.assistant.model) return null;
  try {
    const res = await fetch(`${config.assistant.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.assistant.apiKey ? { Authorization: `Bearer ${config.assistant.apiKey}` } : {}) },
      body: JSON.stringify({ model: config.assistant.model, temperature: 0.5, max_tokens: 320, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Assistant model returned ${res.status}`);
    const data = await res.json() as { choices?: { message?: { content?: unknown } }[] };
    const answer = data.choices?.[0]?.message?.content;
    return typeof answer === 'string' && answer.trim() ? answer.trim() : null;
  } catch (error) {
    console.warn('[v3 chat] AI helper unavailable; using offline helper.', error);
    return null;
  }
}

/** Branch staff who should hear about a new student message (teachers + branch admins; master team if none). */
async function branchStaffEmails(branchId: string): Promise<{ id: string; name: string; email: string }[]> {
  const { rows } = await pool.query(
    `SELECT id, name, email FROM users
      WHERE deleted_at IS NULL AND branch_id = $1 AND (role = 'teacher' OR (role = 'admin' AND admin_scope = 'branch'))`,
    [branchId],
  );
  if (rows.length) return rows;
  const { rows: master } = await pool.query(`SELECT id, name, email FROM users WHERE deleted_at IS NULL AND role = 'admin' AND admin_scope = 'master'`);
  return master;
}

export async function deptChatV2Routes(app: FastifyInstance): Promise<void> {
  // ---------- GET /v2/dept-chat ----------
  app.get<{ Querystring: { q?: string; all?: string; branchId?: string } }>(
    '/dept-chat',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const actor = await getActor(request);
      if (actor.role === 'student') {
        const [{ rows: unreadRows }, { rows: lastRows }, { rows: branchRows }] = await Promise.all([
          pool.query(`SELECT COUNT(*) AS n FROM dept_messages WHERE student_id = $1 AND sender_role <> 'student' AND student_read_at IS NULL`, [actor.id]),
          pool.query(`SELECT * FROM dept_messages WHERE student_id = $1 ORDER BY created_at DESC LIMIT 1`, [actor.id]),
          pool.query(`SELECT name FROM branches WHERE id = $1`, [actor.branchId]),
        ]);
        const last = lastRows[0] ? mapDept(lastRows[0]) : null;
        return {
          mode: 'student',
          studentId: actor.id,
          title: DEPARTMENT_CHAT_NAME,
          branchName: branchRows[0]?.name ?? null,
          unread: Number(unreadRows[0]?.n ?? 0),
          lastAt: last?.createdAt ?? null,
          lastPreview: last ? messagePreview(last) : null,
        };
      }
      if (!actor.isStaff) return bad(reply, 403, 'Not allowed.');

      // Branch scope: master → all (or ?branchId=), everyone else → own branch.
      const branchFilter = actor.isMaster ? (request.query.branchId && UUIDish.test(request.query.branchId) ? request.query.branchId : null) : actor.branchId;
      const params: unknown[] = [];
      let where = '1 = 1';
      if (branchFilter) { params.push(branchFilter); where = `dm.branch_id = $${params.length}`; }
      const { rows } = await pool.query(
        `SELECT dm.student_id, MAX(dm.created_at) AS last_at,
                SUM(CASE WHEN dm.sender_role = 'student' AND dm.staff_read_at IS NULL THEN 1 ELSE 0 END) AS unread
           FROM dept_messages dm WHERE ${where} GROUP BY dm.student_id ORDER BY last_at DESC LIMIT 500`,
        params,
      );
      const ids = rows.map((r: any) => r.student_id as string);
      const byId = new Map<string, DeptThreadSummary>();
      if (ids.length) {
        const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
        const [{ rows: users }, { rows: lasts }] = await Promise.all([
          pool.query(`SELECT u.id, u.name, u.tr_number, u.class_name, u.branch_id, b.name AS branch_name FROM users u LEFT JOIN branches b ON b.id = u.branch_id WHERE u.id IN (${ph})`, ids),
          pool.query(
            `SELECT dm.* FROM dept_messages dm
               JOIN (SELECT student_id, MAX(created_at) AS mx FROM dept_messages WHERE student_id IN (${ph}) GROUP BY student_id) t
                 ON t.student_id = dm.student_id AND t.mx = dm.created_at`,
            ids,
          ),
        ]);
        const lastBy = new Map(lasts.map((r: any) => [r.student_id, mapDept(r)]));
        const userBy = new Map(users.map((u: any) => [u.id, u]));
        for (const r of rows) {
          const u: any = userBy.get(r.student_id);
          if (!u) continue;
          const last = lastBy.get(r.student_id) ?? null;
          byId.set(r.student_id, {
            studentId: r.student_id, name: u.name ?? '', trNumber: u.tr_number ?? null, className: u.class_name ?? null,
            branchId: u.branch_id, branchName: u.branch_name ?? null,
            lastAt: iso(r.last_at), lastPreview: last ? messagePreview(last) : null, lastFromStudent: last?.senderRole === 'student',
            unread: Number(r.unread ?? 0),
          });
        }
      }

      // Students without a conversation yet (to start one): only when searching or asked for.
      const q = (request.query.q ?? '').trim().slice(0, 80);
      if (q || request.query.all === '1') {
        const p2: unknown[] = [];
        let w2 = `u.role = 'student' AND u.deleted_at IS NULL`;
        if (branchFilter) { p2.push(branchFilter); w2 += ` AND u.branch_id = $${p2.length}`; }
        if (q) { p2.push(`%${q}%`); w2 += ` AND (u.name LIKE $${p2.length} OR u.tr_number LIKE $${p2.length} OR u.email LIKE $${p2.length})`; }
        const { rows: extra } = await pool.query(
          `SELECT u.id, u.name, u.tr_number, u.class_name, u.branch_id, b.name AS branch_name
             FROM users u LEFT JOIN branches b ON b.id = u.branch_id WHERE ${w2} ORDER BY u.name ASC LIMIT 60`,
          p2,
        );
        for (const u of extra) {
          if (byId.has(u.id)) continue;
          byId.set(u.id, { studentId: u.id, name: u.name ?? '', trNumber: u.tr_number ?? null, className: u.class_name ?? null, branchId: u.branch_id, branchName: u.branch_name ?? null, lastAt: null, lastPreview: null, lastFromStudent: false, unread: 0 });
        }
      }
      let threads = sortDeptThreads([...byId.values()]);
      if (q) {
        const needle = q.toLowerCase();
        threads = threads.filter(t => t.name.toLowerCase().includes(needle) || (t.trNumber ?? '').toLowerCase().includes(needle));
      }
      return { mode: 'staff', title: DEPARTMENT_CHAT_NAME, threads, totalUnread: threads.reduce((s, t) => s + t.unread, 0) };
    },
  );

  // ---------- GET /v2/dept-chat/:studentId/messages ----------
  app.get<{ Params: { studentId: string } }>(
    '/dept-chat/:studentId/messages',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const actor = await getActor(request);
      const studentId = request.params.studentId === 'me' && actor.role === 'student' ? actor.id : request.params.studentId;
      if (!UUIDish.test(studentId)) return bad(reply, 404, 'This conversation could not be found.');
      if (actor.role === 'student' && studentId !== actor.id) return bad(reply, 403, 'You can only open your own conversation.');
      const student = await loadStudent(studentId);
      if (!student || student.role !== 'student') return bad(reply, 404, 'This student could not be found.');
      if (actor.role !== 'student' && !(await staffMaySee(actor, student.branchId))) return bad(reply, 403, 'This student belongs to another branch.');

      const { rows } = await pool.query(
        `SELECT dm.*, u.name AS sender_name FROM dept_messages dm LEFT JOIN users u ON u.id = dm.sender_id
          WHERE dm.student_id = $1 ORDER BY dm.created_at ASC, dm.id ASC LIMIT 2000`,
        [studentId],
      );
      const now = new Date();
      if (actor.role === 'student') {
        await pool.query(`UPDATE dept_messages SET student_read_at = $1 WHERE student_id = $2 AND student_read_at IS NULL AND sender_role <> 'student'`, [now, studentId]);
      } else {
        await pool.query(`UPDATE dept_messages SET staff_read_at = $1 WHERE student_id = $2 AND staff_read_at IS NULL AND sender_role = 'student'`, [now, studentId]);
      }
      return {
        title: DEPARTMENT_CHAT_NAME,
        student: { id: student.id, name: student.name, email: student.email, trNumber: student.trNumber, className: student.className, branchName: student.branchName },
        messages: rows.map(mapDept),
        canWrite: true,
      };
    },
  );

  // ---------- POST /v2/dept-chat/:studentId/messages ----------
  app.post<{ Params: { studentId: string }; Body: { kind?: string; body?: string | null; attachments?: unknown; meta?: unknown; event?: string } }>(
    '/dept-chat/:studentId/messages',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const actor = await getActor(request);
      const studentId = request.params.studentId === 'me' && actor.role === 'student' ? actor.id : request.params.studentId;
      if (!UUIDish.test(studentId)) return bad(reply, 404, 'This conversation could not be found.');
      if (actor.role === 'student' && studentId !== actor.id) return bad(reply, 403, 'You can only write in your own conversation.');
      if (actor.role !== 'student' && !actor.isStaff) return bad(reply, 403, 'Not allowed.');
      const student = await loadStudent(studentId);
      if (!student || student.role !== 'student') return bad(reply, 404, 'This student could not be found.');
      if (actor.isStaff && !(await staffMaySee(actor, student.branchId))) return bad(reply, 403, 'This student belongs to another branch.');

      const b = request.body ?? {};
      const isStaff = actor.isStaff;
      const meet = b.event === 'meet_request';
      if (meet && !isStaff) return bad(reply, 403, 'Only teachers can send a meeting request.');
      const kind = meet ? 'text' : b.kind;
      if (kind !== 'text' && kind !== 'files' && kind !== 'voice') return bad(reply, 400, 'Please send a text, photos or a voice note.');
      let text = typeof b.body === 'string' ? b.body.trim() : '';
      if (meet) text = text ? `${MEET_REQUEST_TEXT}\n${text}` : MEET_REQUEST_TEXT;
      if (text.length > 4000) return bad(reply, 400, 'This message is too long — please keep it under 4000 characters.');
      const attachments = sanitiseAttachments(b.attachments, 20);
      if (kind === 'text' && !text) return bad(reply, 400, 'Please write a message first.');
      if (kind === 'files' && !attachments.length) return bad(reply, 400, 'Please attach at least one photo or PDF.');
      if (kind === 'voice' && attachments.length !== 1) return bad(reply, 400, 'Please attach one voice recording.');
      const meta: Record<string, unknown> = kind === 'voice' ? sanitiseVoiceMeta(b.meta) : {};
      if (meet) meta.event = 'meet_request';

      // previous student message (for throttling staff emails)
      const { rows: prevRows } = isStaff ? { rows: [] as any[] } : await pool.query(
        `SELECT created_at FROM dept_messages WHERE student_id = $1 AND sender_role = 'student' ORDER BY created_at DESC LIMIT 1`,
        [studentId],
      );
      const { rows: prevStaff } = await pool.query(
        `SELECT created_at FROM dept_messages WHERE student_id = $1 AND sender_role IN ('teacher', 'admin') ORDER BY created_at DESC LIMIT 1`,
        [studentId],
      );

      const id = randomUUID();
      const at = clockNow();
      await pool.query(
        `INSERT INTO dept_messages (id, student_id, branch_id, sender_id, sender_role, kind, body, attachments, meta, created_at, student_read_at, staff_read_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, studentId, student.branchId, actor.id, isStaff ? (actor.role === 'admin' ? 'admin' : 'teacher') : 'student', kind, text || null,
          JSON.stringify(attachments), JSON.stringify(meta), at, isStaff ? null : at, isStaff ? at : null],
      );
      const message = await loadDeptMessage(id);

      const preview = meet ? MEET_REQUEST_TEXT : kind === 'voice' ? 'a voice note' : kind === 'files' ? (text || 'photos') : text;
      if (isStaff) {
        // in-app (allowed type dept_reply) + email to the student, at most one email per 10 minutes
        // one unread notification per student per day — later replies update it instead of piling up
        await notifyDeptReply(studentId, preview, actor.name ?? null);
        const lastStaffAt = prevStaff[0]?.created_at ? new Date(iso(prevStaff[0].created_at) ?? 0) : null;
        const policies = await getEffectivePolicies(student.branchId).catch(() => ({} as Record<string, unknown>));
        if (policies['email.student_on_reply'] !== false && shouldEmailStaff(lastStaffAt, at, 10)) {
          const first = student.name.split(/\s+/)[0] || 'there';
          await sendChatEmail(student.email, 'dept_reply', { studentName: student.name, senderName: actor.name, message: preview, link: chatLink('v2-dept-chat') }, {
            subject: meet ? 'Please come to the Funun al-Quran office' : `New message from the ${DEPARTMENT_CHAT_NAME}`,
            text: [`Salaam ${first},`, '', `${actor.name || 'Your teacher'} (${DEPARTMENT_CHAT_NAME}) wrote to you:`, '', `"${preview.slice(0, 600)}"`, '', 'Open the chat:', chatLink('v2-dept-chat'), '', CHAT_SIGN_OFF].join('\n'),
          });
        }
      } else {
        const lastAt = prevRows[0]?.created_at ? new Date(iso(prevRows[0].created_at) ?? 0) : null;
        if (shouldEmailStaff(lastAt, at, 30)) {
          const staff = await branchStaffEmails(student.branchId);
          for (const s of staff) {
            await sendChatEmail(s.email, 'teacher_reply', { staffName: s.name, studentName: student.name, message: preview, link: chatLink(`v2-dept-chat?studentId=${student.id}`) }, {
              subject: `${student.name} wrote to the ${DEPARTMENT_CHAT_NAME}`,
              text: [`Salaam ${String(s.name ?? '').split(/\s+/)[0]},`, '', `${student.name}${student.trNumber ? ` (TR ${student.trNumber})` : ''}${student.branchName ? `, ${student.branchName}` : ''} wrote:`, '', `"${preview.slice(0, 600)}"`, '', 'Any teacher of the branch can reply here:', chatLink(`v2-dept-chat?studentId=${student.id}`), '', CHAT_SIGN_OFF].join('\n'),
            });
          }
        }
      }
      return reply.code(201).send(message);
    },
  );

  // ---------- POST /v2/ai/chat-assist ----------
  app.post<{ Body: unknown }>(
    '/ai/chat-assist',
    { preHandler: [app.authenticate, requireStaff(app)] },
    async (request, reply) => {
      const req = normaliseAssist(request.body);
      if ('error' in req) return bad(reply, 400, req.error);
      const prompt = buildAssistPrompt(req);
      const answer = await askModel(prompt.system, prompt.user);
      const tidy = answer ? tidyAssist(answer) : '';
      if (tidy) return { answer: tidy, usedAi: true };
      return { answer: offlineAssist(req), usedAi: false };
    },
  );
}
