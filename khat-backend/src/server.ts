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
import { ensureUserDetailColumns } from './services/userDetails.js';
import { runStartupMigrations } from './services/migrations.js';
import { createJobRunner, type BackgroundJob } from './services/backgroundJobs.js';
import { runEmailQueueSweep } from './v2/lib/emailTemplates.js';
import { policiesV2Routes } from './v2/routes/policies.routes.js';
import { catalogV2Routes } from './v2/routes/catalog.routes.js';
import { coursesV2Routes } from './v2/routes/courses.routes.js';
import { ingestV2Routes } from './v2/routes/ingest.routes.js';
import { studentV2Routes } from './v2/routes/student.routes.js';
import { threadsV2Routes } from './v2/routes/threads.routes.js';
import { reviewV2Routes } from './v2/routes/review.routes.js';
import { meritV2Routes } from './v2/routes/merit.routes.js';
import { aiV2Routes } from './v2/routes/ai.routes.js';
import { downloadsV2Routes } from './v2/routes/downloads.routes.js';
import { printV2Routes } from './v2/routes/print.routes.js';
import { competitionsV2Routes } from './v2/routes/competitions.routes.js';
import { insightsV2Routes } from './v2/routes/insights.routes.js';
import { groupsV2Routes } from './v2/routes/groups.routes.js';
import { adminHomeV2Routes } from './v2/routes/adminHome.routes.js';
import { analysisV2Routes } from './v2/routes/analysis.routes.js';
import { deptChatV2Routes } from './v2/routes/deptChat.routes.js';
import { announcementsV2Routes } from './v2/routes/announcements.routes.js';
import { peopleV2Routes } from './v2/routes/people.routes.js';
import { badgesV2Routes } from './v2/routes/badges.routes.js';
import { contentV2Routes } from './v2/routes/content.routes.js';
import { runSlaSweep, runMeritReminderSweep, runStaffDigestSweep, runNudgeSweep } from './v2/services/sweeps.js';

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
  // v2/v3 database updates (once; recorded in khat_migrations). Errors are logged, the site still starts.
  await runStartupMigrations(msg => app.log.info(msg)).catch((err) => app.log.error(err, 'Database update failed'));
  await ensureProblemTables().catch((err) => app.log.error(err, 'Could not create problem_reports / error_log tables'));
  await ensureUserDetailColumns().catch((err) => app.log.error(err, 'Could not add users.phone / users.its_number'));
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
  await app.register(policiesV2Routes, { prefix: '/v2' });
  await app.register(catalogV2Routes, { prefix: '/v2' });
  await app.register(coursesV2Routes, { prefix: '/v2' });
  await app.register(ingestV2Routes, { prefix: '/v2' });
  await app.register(studentV2Routes, { prefix: '/v2' });
  await app.register(threadsV2Routes, { prefix: '/v2' });
  await app.register(reviewV2Routes, { prefix: '/v2' });
  await app.register(meritV2Routes, { prefix: '/v2' });
  await app.register(aiV2Routes, { prefix: '/v2' });
  await app.register(downloadsV2Routes, { prefix: '/v2' });
  await app.register(printV2Routes, { prefix: '/v2' });
  await app.register(competitionsV2Routes, { prefix: '/v2' });
  await app.register(insightsV2Routes, { prefix: '/v2' });
  await app.register(groupsV2Routes, { prefix: '/v2' });
  await app.register(adminHomeV2Routes, { prefix: '/v2' });
  await app.register(analysisV2Routes, { prefix: '/v2' });
  await app.register(deptChatV2Routes, { prefix: '/v2' });
  await app.register(announcementsV2Routes, { prefix: '/v2' });
  await app.register(peopleV2Routes, { prefix: '/v2' });
  await app.register(badgesV2Routes, { prefix: '/v2' });
  await app.register(contentV2Routes, { prefix: '/v2' });

  // Serve the built frontend from ./public (copied there by the deploy build) so one Node app hosts
  // both the site and the API. Registered last so every API route above takes precedence.
  const publicDir = process.env.STATIC_DIR ?? path.join(process.cwd(), 'public');
  if (fs.existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
  }

  // Background jobs: checked at startup, on every request and every minute (see backgroundJobs.ts),
  // so they keep running even if the hosting puts the app to sleep between visits.
  const MINUTE = 60 * 1000;
  const jobs: BackgroundJob[] = [
    { name: 'diversion sweep', everyMs: 60 * MINUTE, run: runDiversionAndIdleFlagSweep },
    { name: 'v2 SLA sweep', everyMs: 15 * MINUTE, run: runSlaSweep },
    { name: 'v2 merit reminders sweep', everyMs: 60 * MINUTE, run: runMeritReminderSweep },
    { name: 'v2 staff digest sweep', everyMs: 60 * MINUTE, run: runStaffDigestSweep },
    { name: 'v2 nudges sweep', everyMs: 60 * MINUTE, run: runNudgeSweep },
    ...(process.env.EMAIL_QUEUE_SWEEP !== 'off' ? [{ name: 'v3 email queue sweep', everyMs: 2 * MINUTE, run: () => runEmailQueueSweep() }] : []),
  ];
  const didSomething = (r: unknown) => !!r && typeof r === 'object' && Object.values(r).some(v => typeof v === 'number' && v > 0);
  const tick = createJobRunner(
    jobs,
    (name, result) => { if (didSomething(result)) app.log.info(result as object, name); },
    (name, err) => app.log.error(err, `${name} failed`),
  );
  app.addHook('onRequest', async () => { tick(); });

  try {
    const address = await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`Server listening at ${address}`);

    setInterval(tick, MINUTE).unref();
    tick();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
