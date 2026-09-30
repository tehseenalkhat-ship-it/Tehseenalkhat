# Organization-server migration readiness

This is a preparation and cutover checklist for moving the current hosted PostgreSQL + Cloudflare R2 setup to an organization-managed server running PostgreSQL + MinIO. No production/server credentials are required for the preparation work. Do not put passwords, access keys, Neon connection strings, or private tokens in source control or chat.

## Prepared in code

- The backend now keeps Cloudflare R2 as its default, but accepts an optional S3-compatible endpoint, region, and path-style setting.
- Both application file operations (presigned uploads, views, deletes, and existence checks) and LiveKit Egress event-recording uploads use the same storage configuration.
- Existing R2 `.env` files continue to use the previous R2 URL, `auto` region, and virtual-host addressing when the new settings are unset.

## Important MinIO requirement

The app uploads files directly from each user's browser to a presigned object-storage URL. Therefore, the MinIO S3 API endpoint configured as `R2_ENDPOINT_OVERRIDE` must be reachable by:

1. The backend server.
2. Every user's browser.
3. LiveKit Egress when it uploads recordings.

Use a stable DNS name and trusted HTTPS certificate for the production endpoint, such as `https://storage.<organization-domain>`. Do **not** configure `localhost` or a backend-only private hostname if browsers cannot resolve and reach it. Configure the bucket's CORS policy for the deployed frontend origin and the signed `GET`, `PUT`, and `HEAD` requests. Keep MinIO's administrative console private; do not expose it as the public S3 API.

## Phase A — Before server credentials exist

### We have prepared

- Made backend storage-provider selection configurable without changing the database schema or stored object keys.
- Kept current Cloudflare defaults, so this code can continue operating against the current R2 bucket.
- Updated the environment example with optional MinIO/S3-compatible settings.
- Added this migration runbook. Frontend and backend builds should be run before making any infrastructure changes.

### You can prepare without sharing secrets

1. Ask the organization IT/server administrator who will own PostgreSQL, MinIO, DNS/TLS, backups, firewall rules, and ongoing updates.
2. Confirm what OS and server capacity they will provide, whether it can run PostgreSQL and MinIO persistently, and who can provision restricted service accounts.
3. Ask IT for a DNS name and HTTPS plan for the MinIO S3 API that browsers and LiveKit Egress can reach. Determine the exact frontend origin(s) that must be permitted by bucket CORS.
4. Find the PostgreSQL major version used by the current database and request the same major version, or an explicitly tested compatible target, on the organization server.
5. Inventory operational dependencies that also need a production plan: frontend hosting, backend HTTPS/reverse proxy, email delivery, and LiveKit signaling/media/Egress. LiveKit is a separate service; changing the object endpoint only updates where its recordings are stored.
6. Keep the current database and R2 bucket active. Do not run a final cutover, delete a bucket, or change DNS yet.

## Phase B — When access is available

Share only non-secret facts here: server OS, database version, whether MinIO is installed, public S3 API DNS/HTTPS URL, frontend domain, and how the backend will be deployed. Enter secrets directly into the server's protected environment file or secret manager. Do not send them to me.

The implementation/deployment work will then be:

1. **Provision PostgreSQL:** create the application database and least-privilege application role; enable required extensions; restrict database access to the backend/network. Make a test backup/restore before production data is involved.
2. **Provision MinIO:** create a private bucket and least-privilege app credentials, configure persistent disks and backups, set trusted HTTPS, and apply CORS for the real frontend origin. Verify an upload and download from a browser on a different machine, not just from the server itself.
3. **Prepare the backend environment:** use `DATABASE_URL` for the organization database; set `R2_ENDPOINT_OVERRIDE` to the browser-reachable MinIO S3 API HTTPS URL; set `R2_FORCE_PATH_STYLE=true`; set `R2_REGION` to the MinIO deployment's configured signing region (commonly `us-east-1`); set the MinIO access key, secret, and bucket name in the secret store. `R2_ACCOUNT_ID` can be empty when the endpoint override is configured. Retain R2 credentials separately for the copy/rollback period.
4. **Prepare application services:** build and deploy the frontend/backend; configure the HTTPS reverse proxy and production CORS; provision production LiveKit/Redis/Egress separately and configure their public signaling/UDP/TURN requirements. Ensure Egress can access the configured MinIO endpoint.
5. **Run a rehearsal:** restore a recent database backup into a staging database, copy a representative sample of R2 objects into a staging MinIO bucket, point a staging backend at them, then test login, profile images, course resources, showcase uploads/views, certificates, deletion, and LiveKit recording/replay.
6. **Fix rehearsal issues before scheduling cutover.** We will not point users at the new server until these checks pass.

## Phase C — Safe data copy and cutover

1. Schedule a maintenance window and announce a brief write freeze. Keep the existing site, Neon database, and R2 bucket available.
2. Take a fresh custom-format PostgreSQL dump and verify it can be listed/restored. Transfer it to the organization server over an approved secure channel.
3. Restore into the target database without trying to recreate Neon-only owners/roles. Ensure schema/table privileges are appropriate for the application role. Verify row counts and critical relationships.
4. Sync the complete R2 bucket to MinIO, preserving every object key. Verify object counts and, where feasible, checksums/sizes. The same keys are required because database rows refer to keys, not provider-specific URLs.
5. Run one final database dump and one final object sync after writes are paused, so the target includes changes made since rehearsal/initial copy.
6. Start the backend against the target database and MinIO; test health, login, signup/TR validation, upload, view/download, delete, certificates, and event recording/replay. Check backend, proxy, PostgreSQL, MinIO, and LiveKit/Egress logs.
7. Only after acceptance, route the production frontend/API domain to the new services and reopen writes. Confirm browser uploads work from an external network.
8. Retain the old Neon project and R2 bucket unchanged for an agreed rollback window (for example, two weeks). Do not decommission until the organization signs off and backups are verified.

## Rollback principle

Before traffic is switched, rollback means continuing to use the original backend/database/R2. After the new server accepts writes, switching back is not a simple DNS flip: new database rows and new objects must be reconciled or the system must remain read-only during rollback. Agree on a rollback owner and procedure before cutover.

## Environment settings

See `.env.example` for the exact variable names. Production values must be stored on the server/secret manager only; never commit an actual `.env` file. The MinIO S3 endpoint is not the MinIO console URL.
