import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { pool } from '../../db.js';
import type { StudentBadge } from '../contracts.js';
import { canSeeBranch, getActor, requireMaster, requireStaff } from '../lib/access.js';
import { logAudit } from '../lib/audit.js';
import { buildBadgePdf } from '../lib/badgePdf.js';
import { BADGE_KINDS, badgePdfName, badgeWording, resolveBadgeDesign, type BadgeDesign, type BadgeKind } from '../lib/builderLogic.js';
import { iso } from '../lib/courseQueries.js';
import { contentDisposition } from '../lib/filesLogic.js';
import { fetchBytes } from '../lib/filesData.js';
import { getDownloadUrl } from '../../storage.js';

/**
 * v3 builder — badge designs and printable badges (owner notes 1.18, 6.6).
 *   GET    /v2/badge-designs                 staff   → { designs, codes }   (designs with a short-lived imageUrl)
 *   PUT    /v2/badge-designs                 master  {id?, name, kind, badgeCode?, isDefault?, storageKey?, contentType?, note?} → BadgeDesign (create or update)
 *   DELETE /v2/badge-designs/:id             master  (levels/courses that chose it fall back to the default)
 *   GET    /v2/badge-designs/:id/sample      staff   → sample PDF with "Student name"
 *   GET    /v2/badges/mine                   student → (StudentBadge & {artworkUrl, downloadUrl, title, subtitle})[]
 *   GET    /v2/badges/:id/download           owner student or staff of the student's branch → printable PDF
 */

export type BadgeDesignView = BadgeDesign & { imageUrl: string | null; usedBy: number };
export type KnownBadgeCode = { badgeCode: string; kind: BadgeKind; label: string; courseId: string | null };
export type MyBadge = StudentBadge & { artworkUrl: string | null; downloadUrl: string; title: string; subtitle: string };

function mapDesign(r: any): BadgeDesign {
  return {
    id: r.id,
    name: r.name ?? '',
    kind: (BADGE_KINDS as string[]).includes(r.kind) ? r.kind : 'level',
    badgeCode: r.badge_code ?? null,
    isDefault: Boolean(Number(r.is_default ?? 0)),
    storageKey: r.storage_key ?? null,
    contentType: r.content_type ?? null,
    note: r.note ?? null,
    updatedAt: iso(r.updated_at),
  };
}

async function loadDesigns(): Promise<BadgeDesign[]> {
  const { rows } = await pool.query(`SELECT * FROM badge_designs ORDER BY kind, is_default DESC, name`);
  return rows.map(mapDesign);
}

async function signedUrl(storageKey: string | null): Promise<string | null> {
  if (!storageKey) return null;
  try { return await getDownloadUrl(storageKey); } catch { return null; }
}

type BadgeRow = {
  id: string; student_id: string; badge_code: string; kind: string; course_id: string | null; level_id: string | null; label: string; awarded_at: unknown;
  course_title: string | null; course_type: string | null; course_design: string | null; level_order: number | null; level_design: string | null;
  has_levels: number | null; student_name: string | null; tr_number: string | null; branch_id: string | null; branch_name: string | null;
};

const BADGE_SELECT = `
  SELECT b.id, b.student_id, b.badge_code, b.kind, b.course_id, b.level_id, b.label, b.awarded_at,
         c.title AS course_title, c.course_type, c.badge_design_id AS course_design,
         l.order_index AS level_order, l.badge_design_id AS level_design,
         ct.has_levels, u.name AS student_name, u.tr_number, u.branch_id, br.name AS branch_name
    FROM student_badges b
    LEFT JOIN courses c ON c.id = b.course_id
    LEFT JOIN levels l ON l.id = b.level_id
    LEFT JOIN course_types ct ON ct.type_key = c.course_type
    LEFT JOIN users u ON u.id = b.student_id
    LEFT JOIN branches br ON br.id = u.branch_id`;

function wordingOf(r: BadgeRow) {
  return badgeWording({
    kind: r.kind, courseTitle: r.course_title, courseType: r.course_type,
    levelOrder: r.level_order === null || r.level_order === undefined ? null : Number(r.level_order),
    label: r.label ?? '', hasLevels: r.has_levels === null || r.has_levels === undefined ? true : Boolean(Number(r.has_levels)),
  });
}

function designFor(r: BadgeRow, designs: BadgeDesign[]): BadgeDesign | null {
  return resolveBadgeDesign({ badgeCode: r.badge_code, kind: r.kind }, designs, r.kind === 'level' ? r.level_design : r.kind === 'course' ? r.course_design : null);
}

function sendPdf(reply: FastifyReply, bytes: Uint8Array, filename: string, inline: boolean) {
  return reply.type('application/pdf').header('Content-Disposition', contentDisposition(filename, inline)).header('Cache-Control', 'private, no-store').send(Buffer.from(bytes));
}

// Registered under prefix '/v2'.
export async function badgesV2Routes(app: FastifyInstance): Promise<void> {
  const staff = { preHandler: [app.authenticate, requireStaff(app)] };
  const master = { preHandler: [app.authenticate, requireMaster(app)] };
  const auth = { preHandler: [app.authenticate] };

  // ---------------------------------------------------------------- designs
  app.get('/badge-designs', staff, async () => {
    const designs = await loadDesigns();
    const [{ rows: usage }, { rows: codeRows }] = await Promise.all([
      pool.query(`SELECT badge_design_id AS id, COUNT(*) AS n FROM levels WHERE badge_design_id IS NOT NULL GROUP BY badge_design_id
                  UNION ALL SELECT badge_design_id AS id, COUNT(*) AS n FROM courses WHERE badge_design_id IS NOT NULL GROUP BY badge_design_id`),
      pool.query(`SELECT badge_code, kind, MIN(label) AS label, MIN(course_id) AS course_id FROM student_badges GROUP BY badge_code, kind ORDER BY badge_code LIMIT 500`),
    ]);
    const used = new Map<string, number>();
    for (const u of usage) used.set(u.id, (used.get(u.id) ?? 0) + Number(u.n));
    const views: BadgeDesignView[] = await Promise.all(designs.map(async d => ({ ...d, imageUrl: await signedUrl(d.storageKey), usedBy: used.get(d.id) ?? 0 })));
    const codes: KnownBadgeCode[] = codeRows.map(r => ({ badgeCode: r.badge_code, kind: (BADGE_KINDS as string[]).includes(r.kind) ? r.kind : 'level', label: r.label ?? r.badge_code, courseId: r.course_id ?? null }));
    return { designs: views, codes };
  });

  app.put<{ Body: Record<string, unknown> }>('/badge-designs', master, async (request, reply) => {
    const actor = await getActor(request);
    const b = request.body ?? {};
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 255) : '';
    if (!name) return reply.code(400).send({ error: 'Give the design a name, e.g. "Level badge — gold".' });
    const kind = b.kind as BadgeKind;
    if (!BADGE_KINDS.includes(kind)) return reply.code(400).send({ error: 'Choose what the design is for: Level, Course or Competition.' });
    const badgeCode = typeof b.badgeCode === 'string' && b.badgeCode.trim() ? b.badgeCode.trim().toUpperCase().slice(0, 64) : null;
    const storageKey = typeof b.storageKey === 'string' && b.storageKey.trim() ? b.storageKey.trim() : null;
    if (storageKey && !/^(badge-assets|settings)\/[A-Za-z0-9._-]+$/.test(storageKey)) return reply.code(400).send({ error: 'Upload the artwork first.' });
    if (storageKey && !/\.(png|jpe?g)$/i.test(storageKey)) return reply.code(400).send({ error: 'Use a PNG or JPG image for the badge artwork.' });
    const contentType = typeof b.contentType === 'string' ? b.contentType.slice(0, 100) : null;
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : null;
    const isDefault = b.isDefault === true && !badgeCode;
    const id = typeof b.id === 'string' && b.id ? b.id : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let designId = id;
      let before: BadgeDesign | null = null;
      if (id) {
        const { rows } = await client.query(`SELECT * FROM badge_designs WHERE id = $1 FOR UPDATE`, [id]);
        if (!rows[0]) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'This badge design no longer exists.' }); }
        before = mapDesign(rows[0]);
        await client.query(
          `UPDATE badge_designs SET name = $1, kind = $2, badge_code = $3, is_default = $4, storage_key = COALESCE($5, storage_key),
                  content_type = COALESCE($6, content_type), note = $7, updated_by = $8, updated_at = CURRENT_TIMESTAMP(6) WHERE id = $9`,
          [name, kind, badgeCode, isDefault, storageKey, storageKey ? contentType : null, note, actor.id, id]);
      } else {
        designId = randomUUID();
        await client.query(
          `INSERT INTO badge_designs (id, name, kind, badge_code, is_default, storage_key, content_type, note, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [designId, name, kind, badgeCode, isDefault, storageKey, contentType, note, actor.id]);
      }
      // only one default per kind
      if (isDefault) await client.query(`UPDATE badge_designs SET is_default = 0 WHERE kind = $1 AND id <> $2`, [kind, designId]);
      await client.query('COMMIT');
      const { rows } = await pool.query(`SELECT * FROM badge_designs WHERE id = $1`, [designId]);
      const after = mapDesign(rows[0]);
      await logAudit({
        actorId: actor.id, action: before ? 'badge_design.update' : 'badge_design.create', entityType: 'badge_design', entityId: after.id,
        summary: `Badge design "${after.name}" ${before ? 'updated' : 'added'} (${after.kind}${after.isDefault ? ', default' : ''}${after.badgeCode ? `, only for ${after.badgeCode}` : ''})`,
        before, after,
      });
      return { ...after, imageUrl: await signedUrl(after.storageKey), usedBy: 0 } satisfies BadgeDesignView;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      request.log.error(error);
      return reply.code(500).send({ error: 'The badge design could not be saved. Please try again.' });
    } finally {
      client.release();
    }
  });

  app.delete<{ Params: { id: string } }>('/badge-designs/:id', master, async (request, reply) => {
    const actor = await getActor(request);
    const { rows } = await pool.query(`SELECT * FROM badge_designs WHERE id = $1`, [request.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'This badge design no longer exists.' });
    await pool.query(`UPDATE levels SET badge_design_id = NULL WHERE badge_design_id = $1`, [request.params.id]);
    await pool.query(`UPDATE courses SET badge_design_id = NULL WHERE badge_design_id = $1`, [request.params.id]);
    await pool.query(`DELETE FROM badge_designs WHERE id = $1`, [request.params.id]);
    const d = mapDesign(rows[0]);
    await logAudit({ actorId: actor.id, action: 'badge_design.delete', entityType: 'badge_design', entityId: d.id, summary: `Badge design "${d.name}" removed`, before: d });
    return { deleted: true };
  });

  app.get<{ Params: { id: string } }>('/badge-designs/:id/sample', staff, async (request, reply) => {
    const { rows } = await pool.query(`SELECT * FROM badge_designs WHERE id = $1`, [request.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'This badge design no longer exists.' });
    const d = mapDesign(rows[0]);
    const artwork = d.storageKey ? await fetchBytes(d.storageKey) : null;
    const title = d.kind === 'level' ? 'Level 1 completed' : d.kind === 'course' ? 'Course completed' : 'Winner';
    const bytes = await buildBadgePdf({
      studentName: 'Student Name', trNumber: '12345', branchName: 'Nairobi', title, subtitle: 'Course name · Certification course',
      awardedAt: new Date(), badgeId: 'SAMPLE00', artwork, sample: true,
    });
    return sendPdf(reply, bytes, `badge-sample-${d.name}.pdf`, true);
  });

  // ---------------------------------------------------------------- the student's badges
  app.get('/badges/mine', auth, async request => {
    const actor = await getActor(request);
    const [designs, { rows }] = await Promise.all([
      loadDesigns(),
      pool.query(`${BADGE_SELECT} WHERE b.student_id = $1 ORDER BY b.awarded_at DESC`, [actor.id]),
    ]);
    const out: MyBadge[] = await Promise.all((rows as BadgeRow[]).map(async r => {
      const w = wordingOf(r);
      const design = designFor(r, designs);
      return {
        id: r.id, badgeCode: r.badge_code, kind: r.kind === 'course' || r.kind === 'competition' ? r.kind : 'level',
        courseId: r.course_id ?? null, levelId: r.level_id ?? null, label: r.label ?? r.badge_code, awardedAt: iso(r.awarded_at) ?? new Date(0).toISOString(),
        artworkUrl: await signedUrl(design?.storageKey ?? null),
        downloadUrl: `/v2/badges/${r.id}/download`,
        title: w.title, subtitle: w.subtitle,
      };
    }));
    return out;
  });

  app.get<{ Params: { id: string }; Querystring: { inline?: string } }>('/badges/:id/download', auth, async (request, reply) => {
    const actor = await getActor(request);
    const { rows } = await pool.query(`${BADGE_SELECT} WHERE b.id = $1`, [request.params.id]);
    const r = rows[0] as BadgeRow | undefined;
    if (!r) return reply.code(404).send({ error: 'This badge could not be found.' });
    const mine = r.student_id === actor.id;
    if (!mine && !(actor.isStaff && r.branch_id && canSeeBranch(actor, r.branch_id))) return reply.code(403).send({ error: 'You can only download your own badges.' });
    const designs = await loadDesigns();
    const design = designFor(r, designs);
    const artwork = design?.storageKey ? await fetchBytes(design.storageKey) : null;
    const w = wordingOf(r);
    const awardedAt = new Date(iso(r.awarded_at) ?? Date.now());
    const bytes = await buildBadgePdf({
      studentName: r.student_name ?? 'Student', trNumber: r.tr_number, branchName: r.branch_name,
      title: w.title, subtitle: w.subtitle, awardedAt, badgeId: r.id, artwork,
    });
    return sendPdf(reply, bytes, badgePdfName(r.student_name ?? 'student', w.title), request.query.inline === '1');
  });
}
