import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { pool } from '../../db.js';
import { canManageBranch, canSeeBranch, getActor, requireAnyAdmin, requireStaff, type Actor } from '../lib/access.js';
import { getEffectivePolicies } from '../lib/policies.js';
import { logAudit } from '../lib/audit.js';
import type { CompetitionKind, CompetitionSelection, DashboardHighlight } from '../contracts.js';
import {
  competitionOpenToBranch, dateOnly, effectiveCompetitionStatus, isSafeStorageKey, iso, normaliseBranchIds, normaliseExcerpts,
  normaliseSelections, safeJson, todayInNairobi, uniqueIds, type ShowcaseRequest, type V2Competition, type V2CompetitionEntry,
} from '../lib/filesLogic.js';
import { notifyStudentsOfBranches, safeNotify } from '../lib/filesData.js';
import { cleanAwardLabel } from '../lib/contentLogic.js';

/**
 * Competitions + "calls for calligraphers", results → dashboards + gallery, and student
 * "Request to showcase". Re-uses the legacy tables (competitions, competition_entries,
 * competition_winners, showcase_posts) so the old /competitions and /showcase routes keep working.
 */

const ENTRY_LIMIT_PER_STUDENT = 5;
const HIGHLIGHT_DAYS = 90;

type CompRow = {
  id: string; title: string; description: string | null; kind: string | null; branch_ids: unknown; excerpts: unknown;
  cover_storage_key: string | null; start_date: string | Date | null; end_date: string | Date | null; status: string | null;
  judge_teacher_id: string | null; results_published_at: Date | null; created_by: string | null; entry_count?: number | string;
};

const COMP_COLUMNS = `c.id, c.title, c.description, c.kind, c.branch_ids, c.excerpts, c.cover_storage_key, c.start_date, c.end_date,
  c.status, c.judge_teacher_id, c.results_published_at, c.created_by`;

const kindOf = (k: unknown): CompetitionKind => (k === 'call' ? 'call' : 'competition');

function canManageCompetition(actor: Actor, branchIds: string[] | null): boolean {
  if (actor.isMaster) return true;
  return actor.isBranchAdmin && !!branchIds && branchIds.length === 1 && branchIds[0] === actor.branchId;
}

function staffCanSeeCompetition(actor: Actor, branchIds: string[] | null): boolean {
  return actor.isMaster || competitionOpenToBranch(branchIds, actor.branchId);
}

function mapCompetition(r: CompRow, actor: Actor, myEntries: V2Competition['myEntries'], today: string): V2Competition {
  const branchIds = normaliseBranchIds(r.branch_ids);
  return {
    id: r.id,
    kind: kindOf(r.kind),
    title: r.title,
    description: r.description ?? null,
    branchIds,
    excerpts: normaliseExcerpts(r.excerpts),
    coverStorageKey: r.cover_storage_key ?? null,
    startDate: dateOnly(r.start_date),
    endDate: dateOnly(r.end_date),
    status: effectiveCompetitionStatus(r, today),
    resultsPublishedAt: iso(r.results_published_at),
    entryCount: Number(r.entry_count ?? 0),
    myEntries,
    canManage: canManageCompetition(actor, branchIds),
  };
}

async function loadCompetition(id: string): Promise<CompRow | null> {
  const { rows } = await pool.query(
    `SELECT ${COMP_COLUMNS}, (SELECT COUNT(*) FROM competition_entries ce WHERE ce.competition_id = c.id) AS entry_count
       FROM competitions c WHERE c.id = $1`,
    [id],
  );
  return (rows[0] as CompRow) ?? null;
}

function validDate(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}
function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function selectionsFor(competitionId: string, actor: Actor): Promise<CompetitionSelection[]> {
  const { rows } = await pool.query(
    `SELECT ce.id, ce.student_id, ce.image_storage_key, ce.selection_label, ce.selection_rank, u.name AS student_name,
            u.branch_id, b.name AS branch_name,
            EXISTS (SELECT 1 FROM showcase_posts p WHERE p.competition_id = ce.competition_id AND p.user_id = ce.student_id
                      AND p.image_storage_key = ce.image_storage_key AND p.status = 'approved') AS published
       FROM competition_entries ce
       JOIN users u ON u.id = ce.student_id
       LEFT JOIN branches b ON b.id = u.branch_id
      WHERE ce.competition_id = $1 AND ce.selection_label IS NOT NULL
      ORDER BY COALESCE(ce.selection_rank, 9999), u.name`,
    [competitionId],
  );
  return rows
    .filter(r => !actor.isStaff || canSeeBranch(actor, r.branch_id) || actor.isMaster)
    .map(r => ({
      entryId: r.id, studentId: r.student_id, studentName: r.student_name ?? '', branchName: r.branch_name ?? null,
      label: r.selection_label, rank: r.selection_rank === null || r.selection_rank === undefined ? null : Number(r.selection_rank),
      imageStorageKey: r.image_storage_key, publishedToGallery: Boolean(Number(r.published) || r.published === true),
    }));
}

function mapShowcase(r: any): ShowcaseRequest {
  return {
    id: r.id, studentId: r.user_id, studentName: r.author_name ?? '', trNumber: r.tr_number ?? null,
    branchId: r.effective_branch_id ?? null, branchName: r.branch_name ?? null, storageKey: r.image_storage_key,
    caption: r.caption ?? null, submissionId: r.submission_id ?? null, source: r.source ?? null, status: r.status,
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
    // v3 audit 24: the moderator sees the question the student answered and the time it took
    question: r.reflection_question ?? null,
    timeMinutes: r.time_minutes == null ? null : Number(r.time_minutes),
  } as ShowcaseRequest & { question: string | null; timeMinutes: number | null };
}

const SHOWCASE_SELECT = `SELECT p.id, p.user_id, p.image_storage_key, p.caption, p.status, p.source, p.submission_id, p.created_at, p.reflection_question, p.time_minutes,
    COALESCE(p.branch_id, u.branch_id) AS effective_branch_id, u.name AS author_name, u.tr_number, b.name AS branch_name
  FROM showcase_posts p
  JOIN users u ON u.id = p.user_id
  LEFT JOIN branches b ON b.id = COALESCE(p.branch_id, u.branch_id)`;

export async function competitionsV2Routes(app: FastifyInstance): Promise<void> {
  // ---------- list ----------
  app.get<{ Querystring: { kind?: string; scope?: string } }>('/competitions', { preHandler: [app.authenticate] }, async request => {
    const actor = await getActor(request);
    const params: unknown[] = [];
    let where = '1=1';
    if (request.query.kind === 'call' || request.query.kind === 'competition') {
      params.push(request.query.kind);
      where = `COALESCE(c.kind, 'competition') = $1`;
    }
    const { rows } = await pool.query(
      `SELECT ${COMP_COLUMNS}, (SELECT COUNT(*) FROM competition_entries ce WHERE ce.competition_id = c.id) AS entry_count
         FROM competitions c WHERE ${where} ORDER BY c.start_date DESC, c.created_at DESC LIMIT 300`,
      params,
    );
    const scopeAll = request.query.scope === 'all' && actor.isStaff;
    const visible = (rows as CompRow[]).filter(r => {
      const ids = normaliseBranchIds(r.branch_ids);
      return scopeAll ? actor.isMaster || actor.isStaff : competitionOpenToBranch(ids, actor.branchId) || (actor.isMaster && request.query.scope !== 'mine');
    });
    const mine = new Map<string, V2Competition['myEntries']>();
    if (actor.role === 'student' && visible.length) {
      const { rows: entries } = await pool.query(
        `SELECT id, competition_id, image_storage_key, submitted_at, selection_label, selection_rank
           FROM competition_entries WHERE student_id = $1 ORDER BY submitted_at`,
        [actor.id],
      );
      for (const e of entries) {
        const list = mine.get(e.competition_id) ?? [];
        list.push({ id: e.id, imageStorageKey: e.image_storage_key, submittedAt: iso(e.submitted_at) ?? '', selectionLabel: e.selection_label ?? null, selectionRank: e.selection_rank ?? null });
        mine.set(e.competition_id, list);
      }
    }
    const today = todayInNairobi();
    return visible.map(r => mapCompetition(r, actor, mine.get(r.id) ?? [], today));
  });

  // ---------- create ----------
  app.post<{ Body: Record<string, unknown> }>('/competitions', { preHandler: [app.authenticate, requireAnyAdmin()] }, async (request, reply) => {
    const actor = await getActor(request);
    const b = request.body ?? {};
    const title = typeof b.title === 'string' ? b.title.trim().slice(0, 200) : '';
    if (!title) return reply.code(400).send({ error: 'Please give it a title.' });
    const kind = kindOf(b.kind);
    const branchIds = actor.isMaster ? normaliseBranchIds(uniqueIds(b.branchIds)) : [actor.branchId];
    const today = todayInNairobi();
    const startDate = validDate(b.startDate) ?? today;
    const endDate = validDate(b.endDate) ?? addDays(startDate, 30);
    if (endDate < startDate) return reply.code(400).send({ error: 'The closing date must be after the opening date.' });
    const coverKey = isSafeStorageKey(b.coverStorageKey) ? b.coverStorageKey : null;
    const id = randomUUID();
    await pool.query(
      `INSERT INTO competitions (id, title, description, khat_type_id, start_date, end_date, created_by, status, kind, branch_ids, excerpts, cover_storage_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, title, typeof b.description === 'string' ? b.description.trim().slice(0, 8000) || null : null,
        typeof b.khatTypeId === 'string' && b.khatTypeId ? b.khatTypeId : null, startDate, endDate, actor.id,
        startDate > today ? 'upcoming' : 'open', kind, branchIds ? JSON.stringify(branchIds) : null,
        JSON.stringify(normaliseExcerpts(b.excerpts)), coverKey],
    );
    await notifyStudentsOfBranches(branchIds, 'competition_created', {
      competitionId: id, title, kind, startDate, endDate,
      message: kind === 'call' ? `New call for calligraphers: ${title}` : `New competition: ${title}`,
    });
    await logAudit({ actorId: actor.id, branchId: branchIds?.length === 1 ? branchIds[0] : null, action: 'competition.create', entityType: 'competition', entityId: id, summary: `${kind === 'call' ? 'Call' : 'Competition'} created: ${title}` });
    const row = await loadCompetition(id);
    return reply.code(201).send(mapCompetition(row!, actor, [], today));
  });

  // ---------- edit ----------
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/competitions/:id', { preHandler: [app.authenticate, requireAnyAdmin()] }, async (request, reply) => {
    const actor = await getActor(request);
    const row = await loadCompetition(request.params.id);
    if (!row) return reply.code(404).send({ error: 'Not found.' });
    if (!canManageCompetition(actor, normaliseBranchIds(row.branch_ids))) return reply.code(403).send({ error: 'Only the master team can change a competition shared by several branches.' });
    const b = request.body ?? {};
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, value: unknown) => { params.push(value); sets.push(`${col} = $${params.length}`); };
    if (typeof b.title === 'string' && b.title.trim()) set('title', b.title.trim().slice(0, 200));
    if (b.description !== undefined) set('description', typeof b.description === 'string' ? b.description.trim().slice(0, 8000) || null : null);
    if (b.kind !== undefined) set('kind', kindOf(b.kind));
    if (b.excerpts !== undefined) set('excerpts', JSON.stringify(normaliseExcerpts(b.excerpts)));
    if (b.coverStorageKey !== undefined) set('cover_storage_key', isSafeStorageKey(b.coverStorageKey) ? b.coverStorageKey : null);
    if (b.branchIds !== undefined && actor.isMaster) { const ids = normaliseBranchIds(uniqueIds(b.branchIds)); set('branch_ids', ids ? JSON.stringify(ids) : null); }
    const start = b.startDate !== undefined ? validDate(b.startDate) : dateOnly(row.start_date);
    const end = b.endDate !== undefined ? validDate(b.endDate) : dateOnly(row.end_date);
    if ((b.startDate !== undefined && !start) || (b.endDate !== undefined && !end)) return reply.code(400).send({ error: 'Dates must look like 2026-11-30.' });
    if (start && end && end < start) return reply.code(400).send({ error: 'The closing date must be after the opening date.' });
    if (b.startDate !== undefined) set('start_date', start);
    if (b.endDate !== undefined) set('end_date', end);
    if (b.status === 'cancelled' || b.status === 'closed' || b.status === 'open') {
      set('status', b.status === 'open' ? (start && start > todayInNairobi() ? 'upcoming' : 'open') : b.status);
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change.' });
    params.push(row.id);
    await pool.query(`UPDATE competitions SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    await logAudit({ actorId: actor.id, action: 'competition.update', entityType: 'competition', entityId: row.id, summary: `Competition updated: ${row.title}`, after: b });
    return mapCompetition((await loadCompetition(row.id))!, actor, [], todayInNairobi());
  });

  // ---------- student entry ----------
  app.post<{ Params: { id: string }; Body: { imageStorageKey?: unknown } }>('/competitions/:id/entries', { preHandler: [app.authenticate] }, async (request, reply) => {
    const actor = await getActor(request);
    if (actor.role !== 'student') return reply.code(403).send({ error: 'Only students can send entries.' });
    const key = request.body?.imageStorageKey;
    if (!isSafeStorageKey(key)) return reply.code(400).send({ error: 'Please upload a photo of your work first.' });
    const row = await loadCompetition(request.params.id);
    if (!row || !competitionOpenToBranch(normaliseBranchIds(row.branch_ids), actor.branchId)) return reply.code(404).send({ error: 'Not found.' });
    const status = effectiveCompetitionStatus(row, todayInNairobi());
    if (status !== 'open' && status !== 'upcoming') return reply.code(409).send({ error: 'This is closed and no longer accepting entries.' });
    const { rows: count } = await pool.query(`SELECT COUNT(*) AS n FROM competition_entries WHERE competition_id = $1 AND student_id = $2`, [row.id, actor.id]);
    if (Number(count[0]?.n ?? 0) >= ENTRY_LIMIT_PER_STUDENT) return reply.code(409).send({ error: `You can send up to ${ENTRY_LIMIT_PER_STUDENT} pieces here.` });
    const id = randomUUID();
    await pool.query(`INSERT INTO competition_entries (id, competition_id, student_id, image_storage_key) VALUES ($1, $2, $3, $4)`, [id, row.id, actor.id, key]);
    if (row.created_by) await safeNotify(row.created_by, 'competition_entry_received', { competitionId: row.id, entryId: id, message: `New entry for ${row.title}` });
    return reply.code(201).send({ id, imageStorageKey: key, submittedAt: new Date().toISOString(), selectionLabel: null, selectionRank: null });
  });

  // ---------- staff: entries ----------
  app.get<{ Params: { id: string } }>('/competitions/:id/entries', { preHandler: [app.authenticate, requireStaff()] }, async (request, reply) => {
    const actor = await getActor(request);
    const row = await loadCompetition(request.params.id);
    if (!row || !staffCanSeeCompetition(actor, normaliseBranchIds(row.branch_ids))) return reply.code(404).send({ error: 'Not found.' });
    const { rows } = await pool.query(
      `SELECT ce.id, ce.student_id, ce.image_storage_key, ce.submitted_at, ce.selection_label, ce.selection_rank,
              u.name AS student_name, u.tr_number, u.branch_id, b.name AS branch_name,
              EXISTS (SELECT 1 FROM showcase_posts p WHERE p.competition_id = ce.competition_id AND p.user_id = ce.student_id
                        AND p.image_storage_key = ce.image_storage_key AND p.status = 'approved') AS published
         FROM competition_entries ce
         JOIN users u ON u.id = ce.student_id
         LEFT JOIN branches b ON b.id = u.branch_id
        WHERE ce.competition_id = $1
        ORDER BY ce.submitted_at`,
      [row.id],
    );
    const out: V2CompetitionEntry[] = rows.filter(r => canSeeBranch(actor, r.branch_id)).map(r => ({
      id: r.id, studentId: r.student_id, studentName: r.student_name ?? '', trNumber: r.tr_number ?? null, branchId: r.branch_id ?? null,
      branchName: r.branch_name ?? null, imageStorageKey: r.image_storage_key, submittedAt: iso(r.submitted_at) ?? '',
      selectionLabel: r.selection_label ?? null, selectionRank: r.selection_rank === null || r.selection_rank === undefined ? null : Number(r.selection_rank),
      publishedToGallery: Boolean(Number(r.published) || r.published === true),
    }));
    return out;
  });

  // ---------- staff: results ----------
  app.post<{ Params: { id: string }; Body: { selections?: unknown; close?: unknown } }>('/competitions/:id/results', { preHandler: [app.authenticate, requireStaff()] }, async (request, reply) => {
    const actor = await getActor(request);
    const comp = await loadCompetition(request.params.id);
    if (!comp || !staffCanSeeCompetition(actor, normaliseBranchIds(comp.branch_ids))) return reply.code(404).send({ error: 'Not found.' });
    const parsed = normaliseSelections(request.body?.selections);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    // v3 note 1.10: "Selected for decoration" now reads simply "Selected".
    for (const s of parsed.value) s.label = cleanAwardLabel(s.label);
    const kind = kindOf(comp.kind);
    const ids = parsed.value.map(s => s.entryId);
    const { rows: entries } = await pool.query(
      `SELECT ce.id, ce.student_id, ce.image_storage_key, ce.selection_label, ce.selection_rank, u.branch_id
         FROM competition_entries ce JOIN users u ON u.id = ce.student_id
        WHERE ce.competition_id = $1 AND ce.id IN (${ids.map((_, i) => `$${i + 2}`).join(', ')})`,
      [comp.id, ...ids],
    );
    const byId = new Map(entries.map(e => [e.id as string, e]));
    const missing = ids.filter(id => !byId.has(id));
    if (missing.length) return reply.code(400).send({ error: `${missing.length} of the selected entries do not belong here.` });
    const foreign = entries.filter(e => !canSeeBranch(actor, e.branch_id));
    if (foreign.length) return reply.code(403).send({ error: 'You can only select entries from your own branch.' });

    const now = new Date();
    for (const s of parsed.value) {
      const e = byId.get(s.entryId)!;
      await pool.query(`UPDATE competition_entries SET selection_label = $1, selection_rank = $2 WHERE id = $3`, [s.label, s.label ? s.rank : null, e.id]);
      if (!s.label) continue;
      const changed = e.selection_label !== s.label || (e.selection_rank ?? null) !== s.rank;
      if (changed) {
        await safeNotify(e.student_id, 'competition_selected', {
          competitionId: comp.id, entryId: e.id, label: s.label, rank: s.rank, kind,
          message: kind === 'call' ? `You have been selected for "${comp.title}": ${s.label}. Congratulations!` : `Congratulations! ${s.label} in "${comp.title}".`,
        });
        try {
          await pool.query(
            `INSERT IGNORE INTO student_badges (student_id, badge_code, kind, label, awarded_by) VALUES ($1, $2, 'competition', $3, $4)`,
            [e.student_id, `COMP_${comp.id}`, `${s.label} — ${comp.title}`.slice(0, 255), actor.id],
          );
        } catch (error) { request.log.error(error); }
      }
      if (s.rank) {
        const { rows: w } = await pool.query(`SELECT id FROM competition_winners WHERE competition_entry_id = $1`, [e.id]);
        if (w[0]) await pool.query(`UPDATE competition_winners SET rank = $1 WHERE id = $2`, [s.rank, w[0].id]);
        else await pool.query(`INSERT INTO competition_winners (id, competition_id, competition_entry_id, student_id, rank) VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), comp.id, e.id, e.student_id, s.rank]);
      }
      if (s.publishToGallery) {
        const { rows: existing } = await pool.query(
          `SELECT id FROM showcase_posts WHERE competition_id = $1 AND user_id = $2 AND image_storage_key = $3 LIMIT 1`,
          [comp.id, e.student_id, e.image_storage_key],
        );
        if (existing[0]) {
          await pool.query(`UPDATE showcase_posts SET status = 'approved', award_label = $1, moderated_by = $2 WHERE id = $3`, [s.label, actor.id, existing[0].id]);
        } else {
          await pool.query(
            `INSERT INTO showcase_posts (id, user_id, user_role, image_storage_key, caption, status, moderated_by, source, competition_id, award_label, branch_id)
             VALUES ($1, $2, 'student', $3, $4, 'approved', $5, 'competition', $6, $7, $8)`,
            [randomUUID(), e.student_id, e.image_storage_key, comp.title, actor.id, comp.id, s.label, e.branch_id],
          );
        }
      }
    }
    const close = typeof request.body?.close === 'boolean' ? request.body.close : kind === 'competition';
    await pool.query(
      `UPDATE competitions SET results_published_at = COALESCE(results_published_at, $1)${close ? `, status = 'completed'` : ''} WHERE id = $2`,
      [now, comp.id],
    );
    await logAudit({ actorId: actor.id, branchId: actor.branchId, action: 'competition.results', entityType: 'competition', entityId: comp.id, summary: `Results for ${comp.title}: ${parsed.value.filter(s => s.label).length} selected`, after: parsed.value });
    return selectionsFor(comp.id, actor);
  });

  // ---------- dashboards: "this student has been selected" ----------
  app.get<{ Querystring: { branchId?: string } }>('/highlights', { preHandler: [app.authenticate] }, async request => {
    const actor = await getActor(request);
    let branchId: string | null = actor.branchId;
    if (actor.isMaster) branchId = request.query.branchId || null;
    else if (actor.isStaff && request.query.branchId && canSeeBranch(actor, request.query.branchId)) branchId = request.query.branchId;
    const params: unknown[] = [new Date(Date.now() - HIGHLIGHT_DAYS * 86_400_000)];
    let branchFilter = '';
    if (branchId) { params.push(branchId); branchFilter = `AND u.branch_id = $2`; }
    const { rows } = await pool.query(
      `SELECT ce.id, ce.selection_label, ce.image_storage_key, c.kind, c.title, c.results_published_at, u.name AS student_name, b.name AS branch_name
         FROM competition_entries ce
         JOIN competitions c ON c.id = ce.competition_id
         JOIN users u ON u.id = ce.student_id
         LEFT JOIN branches b ON b.id = u.branch_id
        WHERE ce.selection_label IS NOT NULL AND c.results_published_at IS NOT NULL AND c.results_published_at >= $1 ${branchFilter}
          AND COALESCE(c.status, '') <> 'cancelled'
        ORDER BY c.results_published_at DESC, COALESCE(ce.selection_rank, 9999) ASC
        LIMIT 30`,
      params,
    );
    const out: DashboardHighlight[] = rows.map(r => ({
      id: r.id, kind: kindOf(r.kind), competitionTitle: r.title, studentName: r.student_name ?? '', branchName: r.branch_name ?? null,
      label: cleanAwardLabel(r.selection_label) ?? r.selection_label, imageStorageKey: r.image_storage_key, createdAt: iso(r.results_published_at) ?? '',
    }));
    return out;
  });

  // ---------- showcase requests (students) ----------
  app.post<{ Body: { storageKey?: unknown; caption?: unknown; submissionId?: unknown } }>('/showcase/requests', { preHandler: [app.authenticate] }, async (request, reply) => {
    const actor = await getActor(request);
    if (actor.role !== 'student') return reply.code(403).send({ error: 'Only students can request to showcase their work.' });
    const key = request.body?.storageKey;
    if (!isSafeStorageKey(key)) return reply.code(400).send({ error: 'Please choose the picture of your work.' });
    const submissionId = typeof request.body?.submissionId === 'string' && request.body.submissionId ? request.body.submissionId : null;
    const caption = typeof request.body?.caption === 'string' ? request.body.caption.trim().slice(0, 500) || null : null;

    if (submissionId) {
      const { rows } = await pool.query(`SELECT student_id, status, files FROM step_submissions WHERE id = $1`, [submissionId]);
      const sub = rows[0];
      if (!sub || sub.student_id !== actor.id) return reply.code(404).send({ error: 'This work could not be found.' });
      if (sub.status !== 'passed' && sub.status !== 'reviewed') return reply.code(409).send({ error: 'You can showcase work once your teacher has passed it.' });
      const files = safeJson<{ storageKey?: string }[]>(sub.files, []);
      let owns = Array.isArray(files) && files.some(f => f?.storageKey === key);
      if (!owns) {
        const { rows: ann } = await pool.query(`SELECT 1 AS ok FROM annotations WHERE submission_id = $1 AND flattened_storage_key = $2 LIMIT 1`, [submissionId, key]);
        owns = Boolean(ann[0]);
      }
      if (!owns) return reply.code(400).send({ error: 'That picture is not part of this work.' });
    } else if (!key.startsWith('showcase/')) {
      return reply.code(400).send({ error: 'Please choose one of your passed pieces, or upload a new photo for the gallery.' });
    }

    const { rows: dup } = await pool.query(
      `SELECT id FROM showcase_posts WHERE user_id = $1 AND image_storage_key = $2 AND status IN ('pending', 'approved') LIMIT 1`,
      [actor.id, key],
    );
    if (dup[0]) return reply.code(409).send({ error: 'You have already sent this piece to the gallery.' });

    const policies = await getEffectivePolicies(actor.branchId);
    const status = policies['showcase.requires_approval'] === false ? 'approved' : 'pending';
    const id = randomUUID();
    await pool.query(
      `INSERT INTO showcase_posts (id, user_id, user_role, image_storage_key, caption, status, source, submission_id, branch_id)
       VALUES ($1, $2, 'student', $3, $4, $5, 'request', $6, $7)`,
      [id, actor.id, key, caption, status, submissionId, actor.branchId],
    );
    if (status === 'pending') {
      const { rows: mods } = await pool.query(
        `SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL AND admin_scope = 'branch' AND branch_id = $1`,
        [actor.branchId],
      );
      const targets = mods.length ? mods : (await pool.query(`SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL AND admin_scope = 'master'`)).rows;
      for (const m of targets) await safeNotify(m.id, 'showcase_pending', { postId: id, authorId: actor.id, message: `${actor.name || 'A student'} asked to show their work in the gallery.` });
    }
    const { rows } = await pool.query(`${SHOWCASE_SELECT} WHERE p.id = $1`, [id]);
    return reply.code(201).send(mapShowcase(rows[0]));
  });

  // ---------- showcase moderation (branch admin: own branch, master: any) ----------
  app.get<{ Querystring: { status?: string; branchId?: string } }>('/showcase/requests', { preHandler: [app.authenticate, requireAnyAdmin()] }, async request => {
    const actor = await getActor(request);
    const status = ['pending', 'approved', 'rejected', 'all'].includes(request.query.status ?? '') ? request.query.status! : 'pending';
    const params: unknown[] = [];
    const where = [`p.user_role = 'student'`];
    if (status !== 'all') { params.push(status); where.push(`p.status = $${params.length}`); }
    const branch = actor.isMaster ? request.query.branchId || null : actor.branchId;
    if (branch) { params.push(branch); where.push(`COALESCE(p.branch_id, u.branch_id) = $${params.length}`); }
    const { rows } = await pool.query(
      `${SHOWCASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`,
      params,
    );
    return rows.map(mapShowcase);
  });

  app.post<{ Params: { id: string }; Body: { approve?: unknown } }>('/showcase/requests/:id/decision', { preHandler: [app.authenticate, requireAnyAdmin()] }, async (request, reply) => {
    const actor = await getActor(request);
    if (typeof request.body?.approve !== 'boolean') return reply.code(400).send({ error: 'Please choose approve or reject.' });
    const { rows } = await pool.query(`${SHOWCASE_SELECT} WHERE p.id = $1`, [request.params.id]);
    const post = rows[0];
    if (!post) return reply.code(404).send({ error: 'Not found.' });
    if (!canManageBranch(actor, post.effective_branch_id)) return reply.code(403).send({ error: 'Only the admin of this branch (or the master team) can decide.' });
    const approve = request.body.approve;
    await pool.query(`UPDATE showcase_posts SET status = $1, moderated_by = $2 WHERE id = $3`, [approve ? 'approved' : 'rejected', actor.id, post.id]);
    await safeNotify(post.user_id, 'showcase_moderated', {
      postId: post.id, decision: approve ? 'approve' : 'reject',
      message: approve ? 'Your work is now in the showcase of your branch. Well done!' : 'Your showcase request was not accepted this time. Keep practicing and try again with another piece.',
    });
    await logAudit({ actorId: actor.id, branchId: post.effective_branch_id, action: approve ? 'showcase.approve' : 'showcase.reject', entityType: 'showcase_post', entityId: post.id, summary: `Gallery request ${approve ? 'approved' : 'rejected'} for ${post.author_name ?? 'student'}` });
    const { rows: after } = await pool.query(`${SHOWCASE_SELECT} WHERE p.id = $1`, [post.id]);
    return mapShowcase(after[0]);
  });
}
