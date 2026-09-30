import type { FastifyInstance } from 'fastify';
import {
  AccessToken,
  EncodedFileOutput,
  EncodedFileType,
  LiveKitAPI,
  S3Upload,
  TrackSource,
  type EncodedOutputs,
} from 'livekit-server-sdk';
import { pool } from '../db.js';
import { config } from '../config.js';
import type { AuthUser } from '../plugins/auth.js';
import { notifyBranchStudents } from '../services/notify.js';
import { deleteObject, objectExists } from '../storage.js';

type CreateEventBody = { 
  title: string; 
  description?: string; 
  scheduledAt: string;
};

type UpdateEventBody = {
  title?: string;
  description?: string;
  scheduledAt?: string;
};

function hasLiveKitCredentials(): boolean {
  return Boolean(config.livekit.apiUrl && config.livekit.wsUrl && config.livekit.apiKey && config.livekit.apiSecret);
}

function liveKitApi(): LiveKitAPI {
  if (!hasLiveKitCredentials()) throw new Error('LiveKit is not configured.');
  return new LiveKitAPI({
    host: config.livekit.apiUrl,
    apiKey: config.livekit.apiKey,
    secret: config.livekit.apiSecret,
  });
}

function liveKitRoomName(eventId: string): string {
  return `event-${eventId}`;
}

function recordingStorageKey(eventId: string): string {
  return `live-events/${eventId}/recording.mp4`;
}

function pendingRecordingMarker(eventId: string): string {
  return `pending:${recordingStorageKey(eventId)}`;
}

async function createLiveKitToken(userId: string, roomName: string, canPublish: boolean): Promise<string> {
  const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: userId,
    name: canPublish ? 'Teacher' : 'Student',
    ttl: '4h',
  });
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish,
    canSubscribe: true,
    canPublishData: false,
  });
  return token.toJwt();
}

async function presentEvents(rows: Record<string, any>[]): Promise<Record<string, any>[]> {
  return Promise.all(rows.map(async event => {
    const { youtube_broadcast_id: _youtubeBroadcastId, youtube_ingestion_url: _youtubeIngestionUrl,
      youtube_stream_name: _youtubeStreamName, stream_url: _legacyStreamUrl,
      livekit_egress_id: _egressId, ...safeEvent } = event;
    const rawStorageValue = typeof event.recording_storage_key === 'string' ? event.recording_storage_key as string : null;
    let storageKey = rawStorageValue && !rawStorageValue.startsWith('pending:') && !/^https?:\/\//i.test(rawStorageValue)
      ? rawStorageValue
      : null;
    if (rawStorageValue?.startsWith('pending:')) {
      const expectedKey = rawStorageValue.slice('pending:'.length);
      try {
        if (await objectExists(expectedKey)) {
          const { rows: updated } = await pool.query(
            `UPDATE live_events SET recording_storage_key = $1 WHERE id = $2 AND recording_storage_key = $3 RETURNING recording_storage_key`,
            [expectedKey, event.id, rawStorageValue]
          );
          storageKey = updated[0]?.recording_storage_key ?? expectedKey;
        }
      } catch (error) {
        console.warn('[LiveKit] Could not check event recording upload:', error);
      }
    }
    return {
      ...safeEvent,
      recording_storage_key: storageKey,
      recording_status: storageKey
        ? 'ready'
        : rawStorageValue?.startsWith('pending:')
          ? 'processing'
          : null,
    };
  }));
}

export async function eventRoutes(app: FastifyInstance) {
  // ---- Teacher: create/schedule an event ----
  app.post<{ Body: CreateEventBody }>(
    '/',
    { preHandler: [app.authenticate, app.requireRole('teacher', 'admin')] },
    async (request, reply) => {
      const { title, description, scheduledAt } = request.body;
      if (!title?.trim() || !scheduledAt || Number.isNaN(Date.parse(scheduledAt))) {
        return reply.code(400).send({ error: 'A title and valid scheduledAt date are required.' });
      }

      if (!hasLiveKitCredentials()) {
        return reply.code(503).send({ error: 'The self-hosted LiveKit service is not configured on the backend.' });
      }

      const user = request.user as AuthUser;

      const { rows } = await pool.query(
        `INSERT INTO live_events (
           host_teacher_id, 
           branch_id, 
           title, 
           description, 
           scheduled_at
         )
         VALUES ($1, $2, $3, $4, $5) 
         RETURNING *`,
        [
          user.id,
          user.branchId,
          title.trim(),
          description?.trim() || null,
          new Date(scheduledAt).toISOString(),
        ]
      );

      await notifyBranchStudents(user.branchId, 'event_scheduled', { eventId: rows[0].id, title: title.trim(), scheduledAt: rows[0].scheduled_at });

      return reply.code(201).send((await presentEvents(rows))[0]);
    }
  );

  // ---- Anyone logged in: browse events ----
  app.get<{ Querystring: { status?: string } }>('/', { preHandler: [app.authenticate] }, async (request) => {
    const { status } = request.query;
    const params: unknown[] = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE le.status = $1`;
    }
    const { rows } = await pool.query(
      `SELECT le.*, u.name AS host_name, b.name AS branch_name
       FROM live_events le
       JOIN users u ON u.id = le.host_teacher_id
       JOIN branches b ON b.id = le.branch_id
       ${where}
       ORDER BY le.scheduled_at DESC`,
      params
    );
    return presentEvents(rows);
  });

  app.get<{ Params: { id: string } }>('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT le.*, u.name AS host_name, b.name AS branch_name
       FROM live_events le
       JOIN users u ON u.id = le.host_teacher_id
       JOIN branches b ON b.id = le.branch_id
       WHERE le.id = $1`,
      [request.params.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Event not found' });
    return (await presentEvents(rows))[0];
  });

  // ---- Host: update event details ----
  app.patch<{ Params: { id: string }; Body: UpdateEventBody }>(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole('teacher', 'admin')] },
    async (request, reply) => {
      const teacherId = (request.user as AuthUser).id;
      const { title, description, scheduledAt } = request.body || {};

      const { rows } = await pool.query(
        `UPDATE live_events 
         SET title = COALESCE($1, title),
             description = COALESCE($2, description),
             scheduled_at = COALESCE($3, scheduled_at)
         WHERE id = $4 AND ($6::boolean OR host_teacher_id = $5) RETURNING *`,
        [title ?? null, description ?? null, scheduledAt ?? null, request.params.id, teacherId, (request.user as AuthUser).role === 'admin']
      );

      if (!rows[0]) return reply.code(404).send({ error: 'Event not found, or you are not its host' });
      await notifyBranchStudents(rows[0].branch_id, 'event_updated', { eventId: rows[0].id, title: rows[0].title });
      return rows[0];
    }
  );

  // ---- Host: obtain a browser-studio token ----
  app.post<{ Params: { id: string } }>(
    '/:id/host-token',
    { preHandler: [app.authenticate, app.requireRole('teacher', 'admin')] },
    async (request, reply) => {
      if (!hasLiveKitCredentials()) {
        return reply.code(503).send({ error: 'LiveKit is not configured on the backend.' });
      }
      const user = request.user as AuthUser;
      const isAdmin = user.role === 'admin';
      const { rows } = await pool.query(
        `SELECT id, host_teacher_id, status FROM live_events
         WHERE id = $1 AND ($3::boolean OR host_teacher_id = $2)`,
        [request.params.id, user.id, isAdmin]
      );
      const event = rows[0];
      if (!event) return reply.code(404).send({ error: 'Event not found, or you are not its host.' });
      if (event.status !== 'scheduled' && event.status !== 'live') {
        return reply.code(409).send({ error: 'The studio is only available for scheduled or live events.' });
      }
      const roomName = liveKitRoomName(event.id);
      return {
        token: await createLiveKitToken(user.id, roomName, true),
        serverUrl: config.livekit.wsUrl,
        roomName,
      };
    }
  );

  // ---- Host: go live ----
  app.patch<{ Params: { id: string } }>(
    '/:id/go-live',
    { preHandler: [app.authenticate, app.requireRole('teacher', 'admin')] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      const teacherId = user.id;
      const isAdmin = user.role === 'admin';
      const { rows: existingRows } = await pool.query(
        `SELECT * FROM live_events WHERE id = $1 AND ($3::boolean OR host_teacher_id = $2)`,
        [request.params.id, teacherId, isAdmin]
      );

      const event = existingRows[0];
      if (!event) return reply.code(404).send({ error: 'Event not found, or you are not its host' });
      if (event.status !== 'scheduled') return reply.code(409).send({ error: 'This event is not scheduled and cannot be started.' });
      if (!hasLiveKitCredentials()) return reply.code(503).send({ error: 'LiveKit is not configured on the backend.' });

      const roomName = liveKitRoomName(event.id);
      const api = liveKitApi();
      try {
        const participants = await api.room.listParticipants(roomName);
        const host = participants.find(participant => participant.identity === teacherId);
        if (!host) {
          return reply.code(409).send({ error: 'Join the in-site studio and allow camera/microphone access before starting the broadcast.' });
        }
        const cameraReady = host.tracks.some(track => track.source === TrackSource.CAMERA && !track.muted);
        const microphoneReady = host.tracks.some(track => track.source === TrackSource.MICROPHONE && !track.muted);
        if (!cameraReady || !microphoneReady) {
          return reply.code(409).send({ error: 'Turn on both your camera and microphone in the studio before starting the broadcast.' });
        }
      } catch (error) {
        app.log.error(error, 'Could not verify the LiveKit studio room');
        return reply.code(502).send({ error: 'Could not verify the live studio. Rejoin it and try again.' });
      }

      const storageKey = recordingStorageKey(event.id);
      const recordingOutput = new EncodedFileOutput({
        filepath: storageKey,
        fileType: EncodedFileType.MP4,
        disableManifest: true,
        output: {
          case: 's3',
          value: new S3Upload({
            accessKey: config.r2.accessKeyId,
            secret: config.r2.secretAccessKey,
            region: config.r2.region,
            endpoint: config.r2.endpointOverride ?? `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
            bucket: config.r2.bucket,
            forcePathStyle: config.r2.forcePathStyle,
          }),
        },
      });
      const outputs: EncodedOutputs = { file: recordingOutput };
      let egress;
      try {
        egress = await api.egress.startRoomCompositeEgress(
          roomName,
          outputs,
          { layout: 'speaker' }
        );
      } catch (error) {
        app.log.error(error, 'Failed to start LiveKit event recording');
        return reply.code(502).send({ error: 'Could not start the event recording. Check that the LiveKit Egress service and R2 upload settings are available, then retry.' });
      }

      const { rows } = await pool.query(
        `UPDATE live_events SET status = 'live', livekit_egress_id = $1
         WHERE id = $2 AND status = 'scheduled' AND ($4::boolean OR host_teacher_id = $3) RETURNING *`,
        [egress.egressId, request.params.id, teacherId, isAdmin]
      );
      if (!rows[0]) {
        await api.egress.stopEgress(egress.egressId).catch(error => app.log.warn(error, 'Could not stop duplicate egress'));
        return reply.code(409).send({ error: 'This event is no longer scheduled.' });
      }

      await notifyBranchStudents(rows[0].branch_id, 'event_live', { eventId: rows[0].id, title: rows[0].title });
      return (await presentEvents(rows))[0];
    }
  );

  // ---- Host: end the event ----
  app.patch<{ Params: { id: string } }>(
    '/:id/end',
    { preHandler: [app.authenticate, app.requireRole('teacher', 'admin')] },
    async (request, reply) => {
      const teacherId = (request.user as AuthUser).id;
      // 1. Fetch current event details
      const isAdmin = (request.user as AuthUser).role === 'admin';
      const { rows: existingRows } = await pool.query(
        `SELECT * FROM live_events WHERE id = $1 AND ($3::boolean OR host_teacher_id = $2)`,
        [request.params.id, teacherId, isAdmin]
      );

      const event = existingRows[0];
      if (!event) return reply.code(404).send({ error: 'Event not found, or you are not its host' });
      if (event.status !== 'live') return reply.code(409).send({ error: 'Only a live event can be ended.' });
      if (!hasLiveKitCredentials()) return reply.code(503).send({ error: 'LiveKit is not configured on the backend.' });
      if (!event.livekit_egress_id) return reply.code(409).send({ error: 'This live event has no recording job to finalize. Contact an administrator before ending it.' });

      const api = liveKitApi();
      if (event.livekit_egress_id) {
        try {
          await api.egress.stopEgress(event.livekit_egress_id);
        } catch (error) {
          const activeEgress = await api.egress.listEgress({ egressId: event.livekit_egress_id }).catch(() => null);
          if (activeEgress === null || activeEgress.length > 0) {
            app.log.error(error, 'Failed to stop LiveKit event recording');
            return reply.code(502).send({ error: 'Could not stop the event recording. The event remains live; retry.' });
          }
          // Completed egress jobs are omitted from listEgress, so confirm the
          // expected output exists below even if StopEgress was a repeat call.
          app.log.info({ egressId: event.livekit_egress_id }, 'LiveKit recording was already stopped');
        }
      }

      const expectedKey = recordingStorageKey(event.id);
      const recordingMarker = event.livekit_egress_id ? pendingRecordingMarker(event.id) : null;

      await api.room.deleteRoom(liveKitRoomName(event.id)).catch(error => app.log.warn(error, 'Could not close the ended LiveKit room'));

      const { rows } = await pool.query(
        `UPDATE live_events SET status = 'ended', recording_storage_key = COALESCE($1, recording_storage_key)
         WHERE id = $2 AND status = 'live' AND ($4::boolean OR host_teacher_id = $3) RETURNING *`,
        [recordingMarker, request.params.id, teacherId, isAdmin]
      );
      if (!rows[0]) return reply.code(409).send({ error: 'This event is no longer live.' });

      await notifyBranchStudents(rows[0].branch_id, 'event_ended', { eventId: rows[0].id, title: rows[0].title });
      return (await presentEvents(rows))[0];
    }
  );

  // ---- Student: mark joined live ----
  app.post<{ Params: { id: string } }>(
    '/:id/join',
    { preHandler: [app.authenticate, app.requireRole('student')] },
    async (request, reply) => {
      const studentId = (request.user as AuthUser).id;
      if (!hasLiveKitCredentials()) return reply.code(503).send({ error: 'LiveKit is not configured on the backend.' });
        const { rows: eventRows } = await pool.query(
          `SELECT status FROM live_events WHERE id = $1`,
          [request.params.id]
        );
        if (!eventRows[0]) return reply.code(404).send({ error: 'Event not found' });
        if (eventRows[0].status !== 'live') return reply.code(409).send({ error: 'This event is not live yet.' });
      const { rows } = await pool.query(
        `INSERT INTO event_attendance (event_id, student_id, joined_at)
         VALUES ($1, $2, now())
         ON CONFLICT (event_id, student_id) DO UPDATE SET joined_at = now()
         RETURNING *`,
        [request.params.id, studentId]
      );
      const roomName = liveKitRoomName(request.params.id);
      return reply.code(201).send({
        ...rows[0],
        token: await createLiveKitToken(studentId, roomName, false),
        serverUrl: config.livekit.wsUrl,
        roomName,
      });
    }
  );

  // ---- Student: mark watched recording ----
  app.post<{ Params: { id: string } }>(
    '/:id/watched-recording',
    { preHandler: [app.authenticate, app.requireRole('student')] },
    async (request, reply) => {
      const studentId = (request.user as AuthUser).id;
      const { rows } = await pool.query(
        `INSERT INTO event_attendance (event_id, student_id, watched_recording)
         VALUES ($1, $2, true)
         ON CONFLICT (event_id, student_id) DO UPDATE SET watched_recording = true
         RETURNING *`,
        [request.params.id, studentId]
      );
      return reply.code(201).send(rows[0]);
    }
  );

  // ---- Host, branch coordinator, or admin: attendance stats ----
  app.get<{ Params: { id: string } }>(
    '/:id/attendance',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      const { rows: eventRows } = await pool.query(`SELECT host_teacher_id, branch_id FROM live_events WHERE id = $1`, [
        request.params.id,
      ]);
      const event = eventRows[0];
      if (!event) return reply.code(404).send({ error: 'Event not found' });

      const isHost = event.host_teacher_id === user.id;
      const isCoordinatorOfBranch = user.isCoordinator && user.branchId === event.branch_id;
      if (!isHost && !isCoordinatorOfBranch && user.role !== 'admin') {
        return reply.code(403).send({ error: "Not authorized to view this event's attendance" });
      }

      const { rows } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE joined_at IS NOT NULL) AS live_attendance_count,
           COUNT(*) FILTER (WHERE watched_recording = true) AS recording_watch_count
         FROM event_attendance WHERE event_id = $1`,
        [request.params.id]
      );
      return rows[0];
    }
  );

  // ---- Admin: remove recording ----
  app.patch<{ Params: { id: string } }>(
    '/:id/remove-recording',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { rows: existing } = await pool.query(`SELECT recording_storage_key FROM live_events WHERE id = $1`, [request.params.id]);
      if (!existing[0]) return reply.code(404).send({ error: 'Event not found' });
      const { rows } = await pool.query(
        `UPDATE live_events SET recording_storage_key = NULL WHERE id = $1 RETURNING *`,
        [request.params.id]
      );
      const key = existing[0].recording_storage_key as string | null;
      if (key && !key.startsWith('pending:') && !/^https?:\/\//i.test(key)) {
        await deleteObject(key).catch(error => app.log.warn(error, 'Could not delete event recording from R2'));
      }
      return rows[0];
    }
  );

  // ---- Admin: remove event ----
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { rows: eventRows } = await pool.query(
        `SELECT id, branch_id, title, recording_storage_key, livekit_egress_id FROM live_events WHERE id = $1`,
        [request.params.id]
      );
      const event = eventRows[0];
      if (!event) return reply.code(404).send({ error: 'Event not found' });
      if (event.livekit_egress_id && hasLiveKitCredentials()) {
        const api = liveKitApi();
        await api.egress.stopEgress(event.livekit_egress_id).catch(error => app.log.warn(error, 'Could not stop deleted event recording'));
        await api.room.deleteRoom(liveKitRoomName(event.id)).catch(error => app.log.warn(error, 'Could not close deleted event room'));
      }
      const { rows } = await pool.query(`DELETE FROM live_events WHERE id = $1 RETURNING id, branch_id, title`, [request.params.id]);
      if (!rows[0]) return reply.code(404).send({ error: 'Event not found' });
      const key = event.recording_storage_key as string | null;
      if (key && !key.startsWith('pending:') && !/^https?:\/\//i.test(key)) {
        await deleteObject(key).catch(error => app.log.warn(error, 'Could not delete event recording from R2'));
      }
      await notifyBranchStudents(rows[0].branch_id, 'event_cancelled', { eventId: rows[0].id, title: rows[0].title });
      return reply.code(204).send();
    }
  );
}