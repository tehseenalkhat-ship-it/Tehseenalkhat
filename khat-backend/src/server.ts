import { STATUS_CODES } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { authPlugin } from './plugins/auth.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.routes.js';
import { courseRoutes, levelRoutes } from './routes/courses.routes.js';
import { uploadRoutes } from './routes/uploads.routes.js';
import { entryRoutes } from './routes/entries.routes.js';
import { showcaseRoutes } from './routes/showcase.routes.js';
import { competitionRoutes } from './routes/competitions.routes.js';
import { eventRoutes } from './routes/events.routes.js';
import { assetRoutes } from './routes/assets.routes.js';
import { studentProfileRoutes } from './routes/students.routes.js';
import { teacherProfileRoutes } from './routes/teachers.routes.js';
import { adminUserRoutes } from './routes/adminUsers.routes.js';
import { adminAnalyticsRoutes } from './routes/adminAnalytics.routes.js';
import { adminTrNumberRoutes } from './routes/adminTrNumbers.routes.js';
import { adminSettingsRoutes } from './routes/adminSettings.routes.js';
import { levelSubmissionRoutes } from './routes/levelSubmissions.routes.js';
import { certificateRoutes } from './routes/certificates.routes.js';
import { bookRoutes } from './routes/books.routes.js';
import { notificationRoutes } from './routes/notifications.routes.js';
import { referenceDataRoutes } from './routes/referenceData.routes.js';
import { runDiversionAndIdleFlagSweep } from './services/diversionSweep.js';
import { badgeRoutes } from './routes/badges.routes.js';
import { assistantRoutes } from './routes/assistant.routes.js';
import { journeyRoutes } from './routes/journeys.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { reportRoutes } from './routes/reports.routes.js';
import { logsRoutes } from './routes/logs.routes.js';
import { ensureProblemTables, logError } from './services/problemReports.js';

// trustProxy: the hosting panel runs the app behind a proxy; this makes request.ip the visitor's real IP.
const app = Fastify({ logger: true, trustProxy: true });

app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_request, body, done) => {
  done(null, body);
});

// Every 5xx goes to error_log: thrown errors here (with their stack), plain `reply.code(500)` answers below.
app.setErrorHandler((error, request, reply) => {
  const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
  if (status >= 500) {
    (request as { errorLogged?: boolean }).errorLogged = true;
    request.log.error(error);
    const user = (request as { user?: { id?: string; role?: string } }).user;
    void logError({ source: 'server', message: error.message, stack: error.stack, url: `${request.method} ${request.url}`, person: user?.id ? `${user.role}:${user.id}` : null });
  }
  return reply.status(status).send({ statusCode: status, code: error.code, error: STATUS_CODES[status] ?? 'Error', message: error.message });
});

app.addHook('onResponse', async (request, reply) => {
  if (reply.statusCode >= 500 && !(request as { errorLogged?: boolean }).errorLogged) {
    const user = (request as { user?: { id?: string; role?: string } }).user;
    void logError({ source: 'server', message: `${request.method} ${request.url} answered ${reply.statusCode}`, url: `${request.method} ${request.url}`, person: user?.id ? `${user.role}:${user.id}` : null });
  }
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('Unhandled promise rejection', err);
  void logError({ source: 'server', message: `Unhandled rejection: ${err.message}`, stack: err.stack });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception', err);
  // Record it, then exit so the hosting panel restarts a clean process.
  const timeout = setTimeout(() => process.exit(1), 2000);
  logError({ source: 'server', message: `Uncaught exception: ${err.message}`, stack: err.stack }).finally(() => {
    clearTimeout(timeout);
    process.exit(1);
  });
});

async function main() {
  await ensureProblemTables().catch((err) => app.log.error(err, 'Could not create problem_reports / error_log tables'));
  await app.register(cors, { origin: true }); // tighten this to your real frontend URL before going live
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(courseRoutes, { prefix: '/courses' });
  await app.register(levelRoutes, { prefix: '/levels' });
  await app.register(uploadRoutes, { prefix: '/uploads' });
  await app.register(entryRoutes, { prefix: '/entries' });
  await app.register(journeyRoutes, { prefix: '/journeys' });
  await app.register(chatRoutes, { prefix: '/chat' });
  await app.register(showcaseRoutes, { prefix: '/showcase' });
  await app.register(competitionRoutes, { prefix: '/competitions' });
  await app.register(eventRoutes, { prefix: '/events' });
  await app.register(assistantRoutes, { prefix: '/assistant' });
  await app.register(badgeRoutes, { prefix: '/badges' });
  await app.register(assetRoutes, { prefix: '/assets' });
  await app.register(studentProfileRoutes, { prefix: '/students' });
  await app.register(teacherProfileRoutes, { prefix: '/teachers' });
  await app.register(adminUserRoutes, { prefix: '/admin/users' });
  await app.register(adminAnalyticsRoutes, { prefix: '/admin' });
  await app.register(adminTrNumberRoutes, { prefix: '/admin/tr-numbers' });
  await app.register(adminSettingsRoutes, { prefix: '/admin/settings' });
  await app.register(levelSubmissionRoutes, { prefix: '/levels' }); // shares /levels with levelRoutes above — different paths, no collision
  await app.register(certificateRoutes, { prefix: '/certificates' });
  await app.register(bookRoutes, { prefix: '/books' });
  await app.register(notificationRoutes, { prefix: '/notifications' });
  await app.register(referenceDataRoutes); // no prefix — /branches, /khat-types
  await app.register(reportRoutes, { prefix: '/api' }); // /api/reports, /api/clientlog
  await app.register(logsRoutes, { prefix: '/logs' }); // private developer page

  // Serve the built frontend from ./public (copied there by the deploy build) so one Node app hosts
  // both the site and the API. Registered last so every API route above takes precedence.
  const publicDir = process.env.STATIC_DIR ?? path.join(process.cwd(), 'public');
  if (fs.existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
  }

  try {
    const address = await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`Server listening at ${address}`);

    // Auto-diversion + idle-flagging run on a simple in-process schedule for now.
    // Fine for a single-instance deploy; if this ever runs on multiple server
    // instances at once, move this to a real scheduled job (e.g. a cron-triggered
    // endpoint) so it doesn't run redundantly on every instance.
    const ONE_HOUR_MS = 60 * 60 * 1000;
    setInterval(() => {
      runDiversionAndIdleFlagSweep()
        .then(({ pendingAssigned, diverted, idleFlagged }) => {
          if (pendingAssigned || diverted || idleFlagged) {
            app.log.info(
              `Diversion sweep: ${pendingAssigned} pending assigned, ${diverted} diverted, ${idleFlagged} idle-flagged`
            );
          }
        })
        .catch((err) => app.log.error(err, 'Diversion sweep failed'));
    }, ONE_HOUR_MS);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
