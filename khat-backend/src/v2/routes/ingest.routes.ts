import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from '../../db.js';
import type { IngestCommitItem, IngestCommitResult } from '../contracts.js';
import { getActor, requireMaster } from '../lib/access.js';
import { DriveError, getDriveAuth, getDriveFileMeta, DRIVE_NOT_CONFIGURED, driveConfigured } from '../lib/drive.js';
import { commitIngestFile, importDriveFolder, ingestDriveFile, planFilenames } from '../lib/ingestService.js';
import { normaliseCourseCode } from '../lib/naming.js';

const MAX_FILES_PER_CALL = 500;
const SOURCES = ['upload', 'zip', 'drive', 'webhook'];

// A whole Drive folder takes minutes, longer than a browser waits, so it runs in the background and the page asks for progress.
// ponytail: kept in memory, lost on restart; running it again is safe (imported files are skipped).
type DriveJob = { results: IngestCommitResult[]; done: boolean; error?: string };
const driveJobs = new Map<string, DriveJob>();
let runningDriveJob: string | null = null;

function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Registered under prefix '/v2'
export async function ingestV2Routes(app: FastifyInstance): Promise<void> {
  const master = { preHandler: [app.authenticate, requireMaster(app)] };

  app.post<{ Body: { filenames?: unknown } }>('/ingest/plan', master, async (request, reply) => {
    const names = request.body?.filenames;
    if (!Array.isArray(names) || !names.length) return reply.code(400).send({ error: 'Choose at least one file.' });
    if (names.length > MAX_FILES_PER_CALL) return reply.code(400).send({ error: `Please send at most ${MAX_FILES_PER_CALL} files at a time.` });
    return planFilenames(names.map(n => String(n ?? '')));
  });

  app.post<{ Body: { items?: IngestCommitItem[] } }>('/ingest/commit', { ...master, bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const actor = await getActor(request);
    const items = request.body?.items;
    if (!Array.isArray(items) || !items.length) return reply.code(400).send({ error: 'Nothing to save — upload the files first.' });
    if (items.length > MAX_FILES_PER_CALL) return reply.code(400).send({ error: `Please send at most ${MAX_FILES_PER_CALL} files at a time.` });
    const results: IngestCommitResult[] = [];
    // One by one, in order: a later file of the batch sees the level/step an earlier one created.
    for (const item of items) {
      const filename = typeof item?.filename === 'string' ? item.filename : '';
      if (!filename) { results.push({ filename: '(no name)', ok: false, action: 'error', message: 'A file without a name was skipped.' }); continue; }
      if (typeof item.storageKey !== 'string' || !item.storageKey.startsWith('course-files/')) {
        results.push({ filename, ok: false, action: 'error', message: 'This file was not uploaded to the course files area. Please upload it again.' });
        continue;
      }
      results.push(await commitIngestFile({
        filename,
        storageKey: item.storageKey,
        contentType: typeof item.contentType === 'string' ? item.contentType.slice(0, 100) : null,
        byteSize: Number.isFinite(Number(item.byteSize)) ? Number(item.byteSize) : null,
        source: (SOURCES.includes(item.source) ? item.source : 'upload') as IngestCommitItem['source'],
        actorId: actor.id,
      }));
    }
    return results;
  });

  app.post<{ Body: { folderUrl?: string; courseCode?: string } }>('/ingest/drive', master, async (request, reply) => {
    const actor = await getActor(request);
    let folderUrl = typeof request.body?.folderUrl === 'string' ? request.body.folderUrl.trim() : '';
    const courseCode = request.body?.courseCode ? normaliseCourseCode(request.body.courseCode) : null;
    if (request.body?.courseCode && !courseCode) return reply.code(400).send({ error: 'Course code must look like FNK-C101.' });
    if (!folderUrl && courseCode) {
      const { rows } = await pool.query(`SELECT drive_folder_url FROM courses WHERE code = $1`, [courseCode]);
      folderUrl = rows[0]?.drive_folder_url ?? '';
    }
    if (!folderUrl) return reply.code(400).send({ error: 'Paste the Google Drive folder link (or set the course\'s Drive folder first).' });
    if (!driveConfigured()) return reply.code(400).send({ error: DRIVE_NOT_CONFIGURED });
    if (runningDriveJob) return { jobId: runningDriveJob };
    const jobId = randomUUID();
    const job: DriveJob = { results: [], done: false };
    driveJobs.set(jobId, job);
    runningDriveJob = jobId;
    importDriveFolder(folderUrl, courseCode, actor.id, job.results)
      .catch((error) => {
        if (!(error instanceof DriveError)) request.log.error(error);
        job.error = error instanceof DriveError ? error.message : 'The Drive import stopped because of a server problem. Run it again — files already imported are skipped.';
      })
      .finally(() => { job.done = true; runningDriveJob = null; setTimeout(() => driveJobs.delete(jobId), 60 * 60 * 1000); });
    return { jobId };
  });

  app.get<{ Params: { jobId: string } }>('/ingest/drive/:jobId', master, async (request, reply) => {
    const job = driveJobs.get(request.params.jobId);
    if (!job) return reply.code(404).send({ error: 'This Drive import is no longer known (the server may have restarted). Run it again — files already imported are skipped.' });
    return job;
  });

  /**
   * Called by the Google Drive upload portal (Apps Script) for every new upload. No login:
   * protected by the X-Ingest-Secret header. Body: {driveFileId, fileName, mimeType?, contentBase64?}.
   * 200 = filed (or already there), 422 = could not be filed (message says why), 401/503 = setup problem.
   */
  app.post<{ Body: { driveFileId?: string; fileName?: string; mimeType?: string; contentBase64?: string } }>(
    '/ingest/webhook',
    { bodyLimit: 60 * 1024 * 1024 },
    async (request, reply) => {
      const expected = process.env.INGEST_WEBHOOK_SECRET?.trim();
      if (!expected) return reply.code(503).send({ ok: false, error: 'The upload webhook is not set up on the server (INGEST_WEBHOOK_SECRET is missing).' });
      const header = request.headers['x-ingest-secret'];
      if (!secretMatches(Array.isArray(header) ? header[0] : header, expected)) return reply.code(401).send({ ok: false, error: 'Wrong or missing X-Ingest-Secret.' });
      const body = request.body ?? {};
      const driveFileId = typeof body.driveFileId === 'string' ? body.driveFileId.trim() : '';
      if (!/^[a-zA-Z0-9_-]{10,}$/.test(driveFileId)) return reply.code(400).send({ ok: false, error: 'driveFileId is missing or not a Drive file id.' });
      let bytes: Buffer | undefined;
      if (typeof body.contentBase64 === 'string' && body.contentBase64.length) {
        bytes = Buffer.from(body.contentBase64, 'base64');
        if (!bytes.length) return reply.code(400).send({ ok: false, error: 'contentBase64 is not valid base64.' });
      } else if (!driveConfigured()) {
        return reply.code(503).send({ ok: false, error: 'Send the file bytes as contentBase64, or ask the technical team to add Google Drive credentials to the server.' });
      }
      let fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
      let mimeType = typeof body.mimeType === 'string' ? body.mimeType : null;
      try {
        const auth = bytes ? null : await getDriveAuth();
        if (!fileName && auth) {
          const meta = await getDriveFileMeta(driveFileId, auth);
          fileName = meta.name; mimeType = mimeType ?? meta.mimeType;
        }
        if (!fileName) return reply.code(400).send({ ok: false, error: 'fileName is missing.' });
        const result = await ingestDriveFile({ id: driveFileId, name: fileName, mimeType }, auth, 'webhook', null, bytes);
        request.log.info({ fileName, action: result.action, ok: result.ok }, 'v2 ingest webhook');
        return reply.code(result.ok ? 200 : 422).send(result);
      } catch (error) {
        if (error instanceof DriveError) return reply.code(error.status === 400 ? 422 : error.status).send({ filename: fileName, ok: false, action: 'error', message: error.message });
        request.log.error(error);
        return reply.code(500).send({ filename: fileName, ok: false, action: 'error', message: 'Server problem — please try again.' });
      }
    },
  );
}
