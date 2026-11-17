# Tehseen al-Khat v2 — handover for the programmer

Everything new is additive: existing courses, pages and data keep working. New code lives in `khat-backend/src/v2/` and `khat-frontend/src/v2/`; the full design is in `V2_SPEC.md`.

## 1. Install and update the database (once)
1. Back up the database.
2. `cd khat-backend && npm install` (new: pdf-lib, qrcode) and `cd ../khat-frontend && npm install` (new: jsqr).
3. `cd khat-backend && npm run migrate:v2` — applies `scripts/migrations/2026-11-10-course-builder-v2.sql`. Safe to run again. Tested on MariaDB 10.11 with the live schema dump; written to also suit TiDB/MySQL 8.

## 2. New server settings (`khat-backend/.env`)
| Setting | What for |
|---|---|
| `INGEST_WEBHOOK_SECRET` | Any long random text. The Google Drive upload portal sends it with each upload — see `khat-backend/V2_DRIVE_WEBHOOK.md` (ready Apps Script snippet). |
| `GOOGLE_API_KEY` *or* `GOOGLE_SERVICE_ACCOUNT_JSON` | Optional: "Import from Drive folder" in the course builder. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Already present — student replies, teacher digest, merit reminders, gentle nudges. Free tier ≈100 emails/day; the system batches and caps. |
| `ASSISTANT_BASE_URL`, `ASSISTANT_MODEL`, `ASSISTANT_API_KEY` | Already present — used by "Refine with AI" for teacher comments (works without, with a simple polish). |

## 3. Set up people (once)
- Master admins (Nairobi team): role `admin`, `admin_scope='master'` (default for existing admins).
- Branch admins: role `admin` with `UPDATE users SET admin_scope='branch' WHERE email='…';` and their `branch_id`.
- Teachers: their limit starts at 15 open entries (old default 5 was raised). Each branch can press "Set up this branch automatically" in Branch policies → Review network.
- Optional: fill `users.class_name` (shown on stamped downloads) — e.g. Darajah.

## 4. Deploy
`khat-backend`: `npm run build && npm start`. `khat-frontend`: `npm run build` and deploy `dist/` as before. Background jobs (72 h hand-over, 7-day automatic mark, daily teacher digest, merit reminders, dormant nudges) start with the server.

## 5. What was tested
- Backend: type-check clean; 181 unit tests pass (`npx tsx --test tests/v2/*.test.ts`).
- Frontend: type-check and production build clean; every new screen screenshot-tested on phone (390 px), iPad and desktop across the site's themes.
- End to end on a real database with sample data: master-list import → files dropped by name create levels and steps (v2 replaces v1, duplicates ignored, bad names rejected) → publish/hold → branch policy (locked items refused) → student enrols, sets mistar size, marks steps done, downloads stamped PDF and "print several" bundle → submits Level 1 assessment with all worksheets → shared branch inbox, lookup by print code, AI refine, annotation with pin, mark 8 (pass) / 4 (revision with warm comment) / 9 (distinction) → print pack with QR → next level unlocks, level badge, merit ledger → insights, team report, community group, call for calligraphers with result in the gallery and dashboard highlight.
- One bug found and fixed during this run: a certification could complete while a later level had no assessment yet.

## 6. Things to know
- Upload folders allowed per role were added in `src/routes/uploads.routes.ts` (course-files, threads, voice, annotations, scan-returns, corrections, groups, settings, competitions).
- Student and faculty pages and menus are unchanged (approved). Teachers/coordinators get one extra menu item, "Review inbox" (new-course submissions). New courses appear inside the existing Courses page once published. The admin menu holds the new tools; the old course builder stays as "Old courses".
- Do not commit `.env` files. The zip you received earlier contained live keys — please rotate them.
