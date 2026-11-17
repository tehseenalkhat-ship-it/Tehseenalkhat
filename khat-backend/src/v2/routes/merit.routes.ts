import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { pool } from '../../db.js';
import type { MeritEntry, MeritToGive, StudentBadge } from '../contracts.js';
import type { Actor } from '../lib/access.js';
import { canManageBranch, canSeeBranch, getActor, requireStaff } from '../lib/access.js';
import { getEffectivePolicies } from '../lib/policies.js';
import { addMeritTx, isValidMonth, nairobiMonth } from '../lib/reviewLogic.js';
import { insertAudit, iso, loadStudent, withTransaction } from '../lib/threadData.js';
import { safeNotify } from '../lib/threadNotify.js';
import { meritExportTable, type MeritExportEntry } from '../lib/commsLogic.js';
import { writeXlsx } from '../lib/xlsx.js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const slugPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'all';

/** Plain A4-landscape table; characters the standard PDF font cannot draw are replaced. */
async function meritPdf(title: string, entries: MeritExportEntry[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const safe = (t: string) => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
  const table = meritExportTable(entries);
  const widths = [150, 62, 48, 80, 200, 40, 52, 50, 100];
  const header = table.header.slice(0, 9);
  const W = 842; const H = 595; const M = 30;
  const fit = (t: string, w: number, f = font, size = 8.5) => { let s = safe(t); while (s.length > 1 && f.widthOfTextAtSize(s, size) > w - 6) s = s.slice(0, -2) + '…'.replace('…', '.'); return s; };
  let page = doc.addPage([W, H]);
  let y = H - M;
  const drawHead = (first: boolean) => {
    if (first) {
      page.drawText(safe(title), { x: M, y: y - 14, size: 15, font: bold, color: rgb(0.05, 0.2, 0.3) });
      page.drawText(safe(`Funun al-Quran - Tehseen al-Khat - ${table.totals.students} students, ${table.totals.points} points - printed ${new Date().toISOString().slice(0, 10)}`), { x: M, y: y - 30, size: 9, font, color: rgb(0.35, 0.4, 0.45) });
      y -= 48;
    }
    page.drawRectangle({ x: M, y: y - 16, width: W - 2 * M, height: 18, color: rgb(0.9, 0.94, 0.96) });
    let x = M;
    header.forEach((h, i) => { page.drawText(fit(h, widths[i], bold, 8.5), { x: x + 3, y: y - 11, size: 8.5, font: bold }); x += widths[i]; });
    y -= 20;
  };
  drawHead(true);
  if (!table.rows.length) page.drawText('Nothing to show for this month.', { x: M, y: y - 14, size: 10, font });
  table.rows.forEach((row, n) => {
    if (y < M + 20) { page = doc.addPage([W, H]); y = H - M; drawHead(false); }
    if (n % 2) page.drawRectangle({ x: M, y: y - 13, width: W - 2 * M, height: 15, color: rgb(0.97, 0.98, 0.99) });
    let x = M;
    row.slice(0, 9).forEach((v, i) => { page.drawText(fit(String(v ?? ''), widths[i]), { x: x + 3, y: y - 9, size: 8.5, font }); x += widths[i]; });
    y -= 15;
  });
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length}`, { x: W - M - 60, y: 14, size: 8, font, color: rgb(0.45, 0.5, 0.55) }));
  return doc.save();
}

function bad(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

const MERIT_SELECT = `SELECT u.class_name, m.id, m.student_id, m.branch_id, m.source, m.source_ref, m.source_label, m.points, m.earned_month,
    m.status, m.given_by, m.given_at, m.note, m.created_at,
    u.name AS student_name, u.tr_number, b.name AS branch_name, g.name AS given_by_name
  FROM merit_ledger m
  JOIN users u ON u.id = m.student_id
  LEFT JOIN branches b ON b.id = m.branch_id
  LEFT JOIN users g ON g.id = m.given_by`;

function mapMerit(r: any): MeritEntry {
  const source = r.source === 'certification' || r.source === 'manual' ? r.source : 'levels';
  const status = r.status === 'given' || r.status === 'void' ? r.status : 'pending';
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_name ?? '',
    trNumber: r.tr_number ?? null,
    branchName: r.branch_name ?? null,
    source,
    sourceLabel: r.source_label ?? '',
    points: Number(r.points ?? 0),
    earnedMonth: String(r.earned_month ?? ''),
    status,
    givenByName: r.given_by_name ?? null,
    givenAt: iso(r.given_at),
  };
}

function mapBadge(r: any): StudentBadge {
  const kind = r.kind === 'course' || r.kind === 'competition' ? r.kind : 'level';
  return {
    id: r.id, badgeCode: r.badge_code, kind, courseId: r.course_id ?? null, levelId: r.level_id ?? null,
    label: r.label ?? r.badge_code, awardedAt: iso(r.awarded_at) ?? new Date(0).toISOString(),
  };
}

async function officerOf(branchId: string): Promise<string | null> {
  const policies = await getEffectivePolicies(branchId);
  const value = policies['merit.officer_user_id'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Branch admin of that branch, or the officer named in the branch's policy. */
function canGiveFor(actor: Actor, branchId: string, officerUserId: string | null): boolean {
  return (actor.isBranchAdmin && canManageBranch(actor, branchId)) || (Boolean(officerUserId) && officerUserId === actor.id);
}

/** Master: any branch (or all when none given). Others: only their own branch. */
function resolveBranch(actor: Actor, requested: string | undefined): { branchId: string | null } | { error: string } {
  if (actor.isMaster) return { branchId: requested || null };
  if (requested && requested !== actor.branchId) return { error: 'You can only see your own branch.' };
  return { branchId: actor.branchId };
}

export async function meritV2Routes(app: FastifyInstance): Promise<void> {
  const staff = { preHandler: [app.authenticate, requireStaff(app)] };

  // ---------- GET /v2/merit/me ----------
  app.get('/merit/me', { preHandler: [app.authenticate] }, async request => {
    const actor = await getActor(request);
    const { rows } = await pool.query(
      `${MERIT_SELECT} WHERE m.student_id = $1 AND m.status <> 'void' ORDER BY m.earned_month DESC, m.created_at DESC`,
      [actor.id],
    );
    return rows.map(mapMerit) as MeritEntry[];
  });

  // ---------- GET /v2/merit/to-give?month=&branchId= ----------
  app.get<{ Querystring: { month?: string; branchId?: string } }>('/merit/to-give', staff, async (request, reply) => {
    const actor = await getActor(request);
    const month = request.query.month || nairobiMonth();
    if (!isValidMonth(month)) return bad(reply, 400, 'Please choose a month like 2026-11.');
    const scope = resolveBranch(actor, request.query.branchId);
    if ('error' in scope) return bad(reply, 403, scope.error);

    const params: unknown[] = [month];
    let where = `m.status = 'pending' AND m.earned_month <= $1`;
    if (scope.branchId) {
      params.push(scope.branchId);
      where += ` AND m.branch_id = $2`;
    }
    const { rows } = await pool.query(`${MERIT_SELECT} WHERE ${where} ORDER BY u.name ASC, m.earned_month ASC, m.created_at ASC LIMIT 5000`, params);

    const officerUserId = scope.branchId ? await officerOf(scope.branchId) : null;
    // v3 (note 6.3): merit points are given by BRANCH admins (or the branch's named officer).
    // The master team sees every branch but does not give points.
    const canMarkGiven = Boolean(scope.branchId) && canGiveFor(actor, scope.branchId!, officerUserId);
    const byStudent = new Map<string, MeritToGive['students'][number]>();
    for (const r of rows) {
      const entry = mapMerit(r);
      let group = byStudent.get(entry.studentId);
      if (!group) {
        group = { studentId: entry.studentId, studentName: entry.studentName, trNumber: entry.trNumber, branchName: entry.branchName, total: 0, entries: [] };
        byStudent.set(entry.studentId, group);
      }
      group.entries.push(entry);
      group.total += entry.points;
    }
    const result: MeritToGive = { month, officerUserId, canMarkGiven, students: [...byStudent.values()] };
    return result;
  });

  // ---------- POST /v2/merit/mark-given {entryIds} ----------
  app.post<{ Body: { entryIds?: unknown } }>('/merit/mark-given', staff, async (request, reply) => {
    const actor = await getActor(request);
    const ids = Array.isArray(request.body?.entryIds)
      ? [...new Set((request.body!.entryIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length <= 36))]
      : [];
    if (!ids.length) return bad(reply, 400, 'Please choose the points you have given.');
    if (ids.length > 1000) return bad(reply, 400, 'Please mark at most 1000 entries at a time.');

    const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await pool.query(`SELECT id, student_id, branch_id, points, earned_month, status FROM merit_ledger WHERE id IN (${ph})`, ids);
    const currentMonth = nairobiMonth();
    const officers = new Map<string, string | null>();
    for (const branchId of new Set(rows.map((r: any) => r.branch_id as string))) officers.set(branchId, await officerOf(branchId));

    const allowed = rows.filter((r: any) => canGiveFor(actor, r.branch_id, officers.get(r.branch_id) ?? null));
    if (!allowed.length) return bad(reply, 403, 'Merit points are given by the branch admin of each branch.');
    const givable = allowed.filter((r: any) => r.status === 'pending' && String(r.earned_month) <= currentMonth);
    const skipped = ids.length - givable.length;
    if (!givable.length) return { updated: 0, skipped };

    const now = new Date();
    const givenIds = givable.map((r: any) => r.id as string);
    const updated = await withTransaction(async client => {
      const p2 = givenIds.map((_, i) => `$${i + 3}`).join(', ');
      const res = await client.query(
        `UPDATE merit_ledger SET status = 'given', given_by = $1, given_at = $2 WHERE status = 'pending' AND id IN (${p2})`,
        [actor.id, now, ...givenIds],
      );
      await insertAudit(client, {
        actorId: actor.id, branchId: actor.branchId, action: 'merit.given', entityType: 'merit',
        entityId: currentMonth, summary: `${actor.name || 'Officer'} marked ${givenIds.length} merit entr${givenIds.length === 1 ? 'y' : 'ies'} as given`,
        after: { entryIds: givenIds },
      });
      return res.rowCount;
    });

    const perStudent = new Map<string, number>();
    for (const r of givable) perStudent.set(r.student_id, (perStudent.get(r.student_id) ?? 0) + Number(r.points ?? 0));
    for (const [studentId, points] of perStudent) {
      await safeNotify(studentId, 'merit_points_given', {
        message: `${points} merit point${points === 1 ? '' : 's'} for your calligraphy work ${points === 1 ? 'has' : 'have'} been added on the Jamea portal. Well done!`,
        points,
      });
    }
    return { updated, skipped };
  });

  // ---------- GET /v2/merit/history?branchId=&month= ----------
  app.get<{ Querystring: { month?: string; branchId?: string } }>('/merit/history', staff, async (request, reply) => {
    const actor = await getActor(request);
    const scope = resolveBranch(actor, request.query.branchId);
    if ('error' in scope) return bad(reply, 403, scope.error);
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (scope.branchId) { params.push(scope.branchId); conditions.push(`m.branch_id = $${params.length}`); }
    if (request.query.month) {
      if (!isValidMonth(request.query.month)) return bad(reply, 400, 'Please choose a month like 2026-11.');
      params.push(request.query.month);
      conditions.push(`m.earned_month = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`${MERIT_SELECT} ${where} ORDER BY m.earned_month DESC, u.name ASC, m.created_at ASC LIMIT 5000`, params);
    return rows.map(mapMerit) as MeritEntry[];
  });

  // ---------- POST /v2/merit/manual {studentId, points, note} ----------
  app.post<{ Body: { studentId?: string; points?: unknown; note?: string } }>('/merit/manual', staff, async (request, reply) => {
    const actor = await getActor(request);
    if (!actor.isBranchAdmin) return bad(reply, 403, 'Merit points are given by the branch admin of each branch.');
    const studentId = request.body?.studentId;
    const points = Number(request.body?.points);
    const note = typeof request.body?.note === 'string' ? request.body.note.trim().slice(0, 500) : '';
    if (!studentId) return bad(reply, 400, 'Please choose a student.');
    if (!Number.isInteger(points) || points < 1 || points > 100) return bad(reply, 400, 'Points must be a whole number from 1 to 100.');
    const student = await loadStudent(studentId);
    if (!student || student.role !== 'student') return bad(reply, 404, 'This student could not be found.');
    if (!canManageBranch(actor, student.branchId)) return bad(reply, 403, 'You can only add points for students of your branch.');

    const policies = await getEffectivePolicies(student.branchId);
    const cap = Number(policies['merit.monthly_cap']);
    const sourceRef = `manual:${randomUUID()}`;
    await withTransaction(async client => {
      await addMeritTx(client, {
        studentId, branchId: student.branchId, source: 'manual', sourceRef,
        label: note ? `Added by hand — ${note}` : 'Added by hand',
        points, startMonth: nairobiMonth(), cap: Number.isFinite(cap) ? cap : 10, note: note || null,
      });
      await insertAudit(client, {
        actorId: actor.id, branchId: student.branchId, action: 'merit.manual', entityType: 'merit', entityId: studentId,
        summary: `${points} merit point${points === 1 ? '' : 's'} added by hand for ${student.name}${note ? ` — ${note}` : ''}`,
        after: { points, note, sourceRef },
      });
    });
    const { rows } = await pool.query(
      `${MERIT_SELECT} WHERE m.student_id = $1 AND m.source = 'manual' AND (m.source_ref = $2 OR m.source_ref LIKE $3) ORDER BY m.earned_month ASC`,
      [studentId, sourceRef, `${sourceRef}#%`],
    );
    return reply.code(201).send(rows.map(mapMerit) as MeritEntry[]);
  });

  // ---------- v3 (note 6.17) GET /v2/merit/export?format=xlsx|pdf&what=to-give|history&month=&branchId= ----------
  app.get<{ Querystring: { format?: string; what?: string; month?: string; branchId?: string } }>('/merit/export', staff, async (request, reply) => {
    const actor = await getActor(request);
    const scope = resolveBranch(actor, request.query.branchId);
    if ('error' in scope) return bad(reply, 403, scope.error);
    const month = request.query.month || nairobiMonth();
    if (!isValidMonth(month)) return bad(reply, 400, 'Please choose a month like 2026-11.');
    const what = request.query.what === 'history' ? 'history' : 'to-give';
    const params: unknown[] = [month];
    let where = what === 'history' ? `m.earned_month = $1 AND m.status <> 'void'` : `m.status = 'pending' AND m.earned_month <= $1`;
    if (scope.branchId) { params.push(scope.branchId); where += ` AND m.branch_id = $2`; }
    const { rows } = await pool.query(`${MERIT_SELECT} WHERE ${where} ORDER BY b.name, u.name, m.earned_month LIMIT 20000`, params);
    const entries = rows.map((r: any) => ({ ...mapMerit(r), className: r.class_name ?? null }));
    const { rows: br } = scope.branchId ? await pool.query(`SELECT name FROM branches WHERE id = $1`, [scope.branchId]) : { rows: [] as any[] };
    const branchLabel = br[0]?.name ?? 'All branches';
    const title = `${what === 'history' ? 'Merit points' : 'Merit points to give'} — ${branchLabel} — ${month}`;
    const file = `merit-${what}-${slugPart(branchLabel)}-${month}`;
    if (request.query.format === 'pdf') {
      const pdf = await meritPdf(title, entries);
      return reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${file}.pdf"`).send(Buffer.from(pdf));
    }
    const table = meritExportTable(entries);
    const xlsx = writeXlsx([{ name: 'Merit points', rows: [table.header, ...table.rows, [], ['Total', '', '', '', `${table.totals.students} student${table.totals.students === 1 ? "" : "s"}`, table.totals.points]], widths: [28, 12, 10, 16, 36, 8, 10, 10, 22, 12] }]);
    return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="${file}.xlsx"`).send(xlsx);
  });

  // ---------- Badges ----------
  app.get('/badges/me', { preHandler: [app.authenticate] }, async request => {
    const actor = await getActor(request);
    const { rows } = await pool.query(
      `SELECT id, badge_code, kind, course_id, level_id, label, awarded_at FROM student_badges WHERE student_id = $1 ORDER BY awarded_at DESC`,
      [actor.id],
    );
    return rows.map(mapBadge) as StudentBadge[];
  });

  app.get<{ Params: { id: string } }>('/badges/student/:id', staff, async (request, reply) => {
    const actor = await getActor(request);
    const student = await loadStudent(request.params.id);
    if (!student) return bad(reply, 404, 'This student could not be found.');
    if (!canSeeBranch(actor, student.branchId)) return bad(reply, 403, 'This student belongs to another branch.');
    const { rows } = await pool.query(
      `SELECT id, badge_code, kind, course_id, level_id, label, awarded_at FROM student_badges WHERE student_id = $1 ORDER BY awarded_at DESC`,
      [student.id],
    );
    return rows.map(mapBadge) as StudentBadge[];
  });
}
