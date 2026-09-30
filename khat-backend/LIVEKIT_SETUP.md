# LiveKit local development and deployment

## What runs locally

- `livekit-server` handles the teacher's browser camera/microphone and student WebRTC connections.
- `livekit/egress` composites the room into an MP4 recording when the teacher ends the event.
- Redis is shared by LiveKit and Egress for signaling/job coordination.
- The backend issues role-scoped room tokens and saves private recordings to the existing R2 bucket. Events do not use YouTube.

## Local setup: do these once

1. Install Docker Desktop for Mac and open it. Wait until it reports that Docker is running. Docker was not installed in the development environment used to prepare this integration, so containers have not yet been smoke-tested there.
2. Add these development-only settings to the existing backend `.env` file: `LIVEKIT_API_URL=http://localhost:7880`, `LIVEKIT_WS_URL=ws://localhost:7880`, `LIVEKIT_API_KEY=devkey`, and `LIVEKIT_API_SECRET=secret`. Do not use the sample key/secret on a public server. Existing R2 credentials are used to upload event MP4 files; YouTube credentials are not required for events.
3. Apply the SQL in `scripts/migrations/2026-09-29-add-livekit-egress-id.sql` to the same PostgreSQL database configured by the backend. For Neon, open the matching project’s SQL Editor, paste the contents of that migration, and run it once. It only adds the nullable `livekit_egress_id` column. If your database is not Neon, run the migration through its normal SQL client.
4. In a terminal, get your Mac's current local IPv4 address using `ipconfig getifaddr en0` (Wi-Fi; use the correct interface if wired). Edit `livekit.local.yaml`: set `node_ip` to that address and ensure the `node_ip` line is uncommented. If the IP changes, update it and restart LiveKit. This lets the browser reach the UDP media ports forwarded by Docker Desktop.
5. In a terminal, change directory to `/Users/burhanuddinmustafa/Downloads/khat-backend`, then start the local services with `docker compose -f docker-compose.livekit.yml up -d`. Check that all three services are running with `docker compose -f docker-compose.livekit.yml ps`. Start/restart containers after changing either YAML file with `docker compose -f docker-compose.livekit.yml up -d` again.
6. Restart the backend so it reads the new `.env` values. From the backend directory, run `npm run dev` and leave that terminal open. If the backend is already running, stop it with Ctrl+C first.
7. The frontend can use the existing Vite server on `http://localhost:5173`. If it is stopped, open a second terminal in `/Users/burhanuddinmustafa/Downloads/khat-frontend` and run `npm run dev`.

## Test one event end to end

1. Use a teacher account in the site. Schedule a **new** event a few minutes in the future. Use a new event for this test; events created before LiveKit setup do not have a LiveKit room configuration.
2. Open the new event's studio from the teacher event list. Allow camera and microphone permissions in the browser. Confirm the local camera and microphone previews work and select **Start live event**.
3. Open a private/incognito browser window or a second browser, sign in as a student, and open Live Events. Wait for the event to show live, select **Join now**, and confirm the student can hear and see the teacher inside the page.
4. End the event from the teacher studio. Confirm the student is disconnected, the event appears in Past recordings, and the MP4 becomes playable after LiveKit Egress uploads it to R2. The page polls for upload completion, which may take a short time after ending.
5. Event creation, hosting, student joining, recording, and replay all happen in the site. No Google or YouTube account is involved.

If video/audio does not connect, confirm the Mac's `node_ip` is correct, Docker publishes UDP ports `50000–50100`, macOS/network firewall allows them, and all LiveKit/Egress containers are healthy. Inspect logs with `docker compose -f docker-compose.livekit.yml logs -f livekit egress`. If the recording does not appear, check Egress logs and verify that R2 credentials permit S3-compatible uploads and the bucket endpoint matches the account. This Docker Compose setup is for local development only.

## Production deployment

Deploy the LiveKit server and at least one Egress worker separately from the web backend. Use generated secrets, Redis accessible only to those services, a public DNS name with a trusted TLS certificate, and `wss://` for the browser endpoint. Configure the server's advertised public IP/network, expose the LiveKit signaling/TCP and UDP media ports required by the chosen config, and enable TURN/TLS if participants may be behind restrictive firewalls. Keep Redis, LiveKit API credentials, and R2 credentials private. Never reuse the local YAML files or `devkey`/`secret` values in production.

LiveKit recommends at least 4 CPUs and 4 GB RAM per Egress worker for composite output. Check the current LiveKit self-hosting and Egress deployment documentation against the target server/network before exposing the service publicly.
