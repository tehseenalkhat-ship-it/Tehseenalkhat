import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import {
  buildStorageKey,
  getUploadUrl,
  getDownloadUrl,
  getObjectBytes,
  filePath,
  verifySignature,
  contentTypeFor,
} from '../storage.js';
import type { AuthUser, Role } from '../plugins/auth.js';

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 200) * 1024 * 1024;

type PresignBody = { prefix: string; filename: string; contentType: string };

// Which roles may request an upload URL for which prefix. Add a new prefix
// here whenever a new upload surface is built — nothing else needs to change.
const PREFIX_ROLES: Record<string, Role[]> = {
  levels: ['admin'],
  sheets: ['admin'],
  certificates: ['admin'],
  'badge-assets': ['admin'],
  books: ['admin'],
  showcase: ['student', 'teacher'],
  entries: ['student'],
  'level-submissions': ['student'],
  'competition-entries': ['student'],
  assets: ['teacher', 'admin'],
  corrections: ['teacher'],
  'profile-photos': ['student', 'teacher', 'admin'],
};

export async function uploadRoutes(app: FastifyInstance) {
  app.post<{ Body: PresignBody }>('/presign', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { prefix, filename, contentType } = request.body;
    if (!prefix || !filename || !contentType) {
      return reply.code(400).send({ error: 'prefix, filename, and contentType are required' });
    }

    const allowedRoles = PREFIX_ROLES[prefix];
    const user = request.user as AuthUser;
    if (!allowedRoles) {
      return reply.code(400).send({ error: `Unknown prefix. Allowed: ${Object.keys(PREFIX_ROLES).join(', ')}` });
    }
    if (!allowedRoles.includes(user.role)) {
      return reply.code(403).send({ error: `Your role cannot upload to '${prefix}'` });
    }

    const storageKey = buildStorageKey(prefix, filename);
    const uploadUrl = await getUploadUrl(storageKey, contentType);
    return { storageKey, uploadUrl };
  });

  // Any logged-in user can resolve a view URL for a storage key they've been
  // handed by another endpoint (e.g. a level's media list, a showcase post) —
  // access control happens at the point where the key is returned to them.
  app.get<{ Querystring: { key: string; download?: string; filename?: string } }>('/view', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { key, download, filename } = request.query;
    if (!key) return reply.code(400).send({ error: 'key query param is required' });
    const url = await getDownloadUrl(key, download === 'true' ? filename : undefined);
    return { url };
  });

  // Receives the file bytes for a signed upload URL from /presign. Lives in its own scope so the
  // raw body stream reaches the handler for every content type (JSON parsing etc. stays elsewhere).
  await app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    raw.put<{ Querystring: { key: string; exp: string; sig: string } }>('/put', async (request, reply) => {
      const { key, exp, sig } = request.query;
      if (!verifySignature('put', key, exp, sig)) return reply.code(403).send({ error: 'Upload link is invalid or expired' });

      const target = filePath(key);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.part`;
      let size = 0;
      const limit = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          cb(size > MAX_UPLOAD_BYTES ? new Error('too large') : null, chunk);
        },
      });
      try {
        await pipeline(request.body as NodeJS.ReadableStream, limit, fs.createWriteStream(tmp));
        await fs.promises.rename(tmp, target);
      } catch (err) {
        await fs.promises.rm(tmp, { force: true });
        if (size > MAX_UPLOAD_BYTES) return reply.code(413).send({ error: 'File is too large' });
        throw err;
      }
      return reply.code(200).send({ ok: true });
    });
  });

  // Serves a stored file for a signed view/download URL (supports Range for video/PDF streaming).
  app.get<{ Querystring: { key: string; exp: string; sig: string; filename?: string } }>('/raw', async (request, reply) => {
    const { key, exp, sig, filename } = request.query;
    if (!verifySignature('raw', key, exp, sig, filename ?? '')) return reply.code(403).send({ error: 'Link is invalid or expired' });

    let stat: fs.Stats;
    const target = filePath(key);
    try {
      stat = await fs.promises.stat(target);
    } catch {
      return reply.code(404).send({ error: 'File not found' });
    }

    reply.header('Content-Type', contentTypeFor(key));
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'private, max-age=3600');
    if (filename) {
      reply.header(
        'Content-Disposition',
        `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      );
    }

    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, stat.size - 1);
      if (start > end) return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${stat.size}`).header('Content-Length', end - start + 1);
      return reply.send(fs.createReadStream(target, { start, end }));
    }
    reply.header('Content-Length', stat.size);
    return reply.send(fs.createReadStream(target));
  });

  // Return authenticated image bytes through the API origin for operations
  // such as drawing on a private image and exporting it with canvas.
  app.get<{ Querystring: { key: string } }>('/file', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { key } = request.query;
    if (!key) return reply.code(400).send({ error: 'key query param is required' });
    try {
      const file = await getObjectBytes(key);
      reply.header('Content-Type', file.contentType);
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Content-Disposition', 'inline');
      return reply.send(file.body);
    } catch (err) {
      request.log.error(err);
      return reply.code(404).send({ error: 'File could not be loaded' });
    }
  });
}
