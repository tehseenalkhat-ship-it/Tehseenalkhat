import type { FastifyInstance } from 'fastify';
import { buildStorageKey, getUploadUrl, getDownloadUrl, getObjectBytes } from '../storage.js';
import type { AuthUser, Role } from '../plugins/auth.js';

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
