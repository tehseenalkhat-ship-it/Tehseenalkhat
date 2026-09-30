# Neon PostgreSQL to MySQL cutover

The backend now connects to MySQL through `mysql2`. The MySQL schema/data dump is `khat-frontend/khat_neon_full.mysql.sql`; the target database was reported as already created from that dump. Do not import the dump again over production data without first taking a verified backup and confirming the import mode.

The dump converter produces a MySQL 8.0.16+ schema. The backend keeps its existing query call sites behind a MySQL adapter that translates positional parameters and emulates PostgreSQL `RETURNING`; analytics and bulk-import queries that use PostgreSQL-only constructs have been ported to native MySQL SQL.

## Configure the backend

Set these variables in the backend host's protected environment or untracked `.env` file:

- `DB_HOST`
- `DB_PORT` (normally `3306`)
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`

Keep all actual database credentials out of `.env.example`, Git, logs, and chat. The `localhost` hostname only works when the backend runs on the same host/network namespace as MySQL. From a developer's Mac, `localhost` refers to that Mac; use the provider's reachable database hostname or an approved SSH tunnel for local development.

The existing R2, LiveKit, JWT, and frontend environment values are configured separately and are not changed by the database cutover.

## cPanel Node.js deployment

Because MySQL reports `localhost`, run the Node backend on the same hosting server/account as the database. In cPanel's **Setup Node.js App**:

1. Set the application root to the backend directory outside the public document root, select a supported Node.js version, install dependencies with `npm ci`, build with `npm run build`, and use `dist/server.js` as the startup file.
2. Set `DB_HOST=localhost`, `DB_PORT=3306`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` in the app's protected environment-variable settings. Add the existing JWT, R2, and other production settings there as well. Do not put the database password in GitHub Actions FTP variables or a tracked file.
3. Assign the Node app a public URL/subdomain and restart it. Check `/health`; success must report `db: true`.
4. Build the frontend with `VITE_API_BASE_URL` set to that public backend URL, then deploy the generated frontend assets. `VITE_API_BASE_URL=http://localhost:4000` is only for local development.

The current FTP workflow only transfers repository files; it does not install Node dependencies, build the frontend/backend, configure cPanel environment variables, or restart the Node app. Do not deploy the MySQL-only backend until the protected `DB_*` values are set, or the old Neon-configured backend will stop starting.

## Safe cutover checklist

1. Take and verify a fresh Neon backup. Keep the Neon database available and read-only through the rollback window.
2. Confirm the MySQL target has all 27 tables from the converted dump, expected indexes/foreign keys, and matching row counts for critical tables. Check UUIDs, JSON fields, time values, and foreign-key relationships.
3. Configure the backend's protected `DB_*` values on the machine/container where the backend will run. Do not copy production credentials into tracked files.
4. Build and start the backend against MySQL. Confirm the health route and inspect server logs for connection or SQL errors.
5. Exercise login, signup/TR validation, course enrollment/progress, submissions, review/teacher assignment, admin settings, showcase, certificates, uploads/downloads, notifications, competitions, and LiveKit events.
6. Pause writes during final synchronization if any writes happened in Neon after the MySQL dump was created. Do not run both databases as writable sources.
7. Switch the frontend/API traffic only after tests pass. Keep Neon and its backup until the MySQL deployment is accepted and the rollback period ends.

## Schema migration scripts

The scripts under `scripts/migrations/` use MySQL syntax. The full database dump may already contain those changes; check the target schema before running any `ALTER TABLE` script. The two certification seed scripts are safe to rerun and do not replace existing certification courses.
