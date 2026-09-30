import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

export type Role = 'student' | 'teacher' | 'admin';

export type AuthUser = {
  id: string;
  role: Role;
  branchId: string;
  isCoordinator: boolean;
};

// Module augmentation so `request.user` and `app.jwt.sign(...)` are correctly typed everywhere.
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: Role[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: AuthUser;
  }
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  await app.register(jwt, { secret: config.jwtSecret });

  // Use as a preHandler on any route that requires a logged-in user:
  //   app.get('/whoami', { preHandler: [app.authenticate] }, ...)
  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // Use alongside authenticate to also restrict by role:
  //   { preHandler: [app.authenticate, app.requireRole('admin')] }
  app.decorate('requireRole', (...roles: Role[]) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as AuthUser;
      if (!user || !roles.includes(user.role)) {
        reply.code(403).send({ error: 'Forbidden — insufficient role' });
      }
    };
  });
});
