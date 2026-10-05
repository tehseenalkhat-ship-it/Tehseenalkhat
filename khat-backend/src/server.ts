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

const app = Fastify({ logger: true });

async function main() {
  await app.register(cors, { origin: true }); // tighten this to your real frontend URL before going live
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(courseRoutes, { prefix: '/courses' });
  await app.register(levelRoutes, { prefix: '/levels' });
  await app.register(uploadRoutes, { prefix: '/uploads' });
  await app.register(entryRoutes, { prefix: '/entries' });
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
