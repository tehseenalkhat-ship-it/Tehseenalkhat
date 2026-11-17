# Tehseen al-Khat — handover for the programmer (v3)

This release adds the owner's review round on top of v2. Everything is additive: existing courses, accounts and data keep working.

- New code lives in `khat-backend/src/v2/` and `khat-frontend/src/v2/`.
- The design notes are in `V2_SPEC.md` and `V3_SPEC.md`.
- The owner's own review notes are in `V3_OWNER_NOTES.txt`.

## 1. Update the database (once, about 2 minutes)
1. **Back up the database.**
2. Install the packages:
   ```
   cd khat-backend  && npm install
   cd ../khat-frontend && npm install
   ```
3. Apply the changes. Both commands are safe to run again: steps that are already done are skipped.
   ```
   cd khat-backend
   npm run migrate:v2      # skip if v2 is already live
   npm run migrate:v3      # the 8 v3 files in scripts/migrations (2026-11-14-v3-*.sql, then 2026-11-15-v3-fixer-b.sql)
   ```
   - Both commands use the `DB_*` settings in `khat-backend/.env`.
   - Tested on a fresh import of `tehseen_ul_khat.mysql.sql`, and again on a database that already had the v3 changes. They are written to suit TiDB/MySQL 8.

**What `migrate:v3` adds:**

| Area | New tables / columns |
|---|---|
| Steps | `level_steps.video_url` (YouTube link per step) |
| Course builder and badges | `badge_designs`, a badge design on levels and courses, `courses.certification_ready` |
| Teacher | `sheet_ids` (the ID printed on every downloaded sheet), `attempt_grants` ("give one more attempt") |
| Chat | `dept_messages` (Funun al-Quran Department chat) |
| Admin | announcements and surveys (+ answers), email templates, email queue + log, the branch student roster (JHS), policy change alerts |
| Content | gallery reference work, showcase posts, event recordings, book details |

**Data it also corrects:**
- Urs becomes Mashq.
- Spelling becomes Istinsakh / Nastaleeq / Thuluth.
- Badge names become "Course · Level N — title".
- Mashq and crash courses that had no final upload step get one.

## 2. Server settings (`khat-backend/.env`)
| Setting | What it is for |
|---|---|
| `FRONTEND_URL` | The site's public address, e.g. `https://khat.jameasaifiyah.edu`. Used in email links, including the survey link for students who haven't signed up. **Required.** |
| `RESEND_API_KEY`, `EMAIL_FROM` | Already present. All email now goes through a queue. |
| `EMAIL_PER_RUN` (default 12), `EMAIL_DAILY_CAP` (default 95) | Keep sending inside the free Resend plan (about 100 a day). Marks and replies go first. Raise them on a paid plan. |
| `EMAIL_QUEUE_SWEEP=off` | Optional: stops the queue from sending (useful on a test server). |
| `ASSISTANT_BASE_URL`, `ASSISTANT_MODEL`, `ASSISTANT_API_KEY` | Already present. Powers the teachers' AI helper in chat; it works in a simple mode without them. |
| `INGEST_WEBHOOK_SECRET`, `GOOGLE_API_KEY` / `GOOGLE_SERVICE_ACCOUNT_JSON` | As in v2 (Drive upload portal and folder import). |
| `LIVEKIT_*` | Already present (live events). |

## 3. After going live: three things for the admin team (no code)
1. **Certificates:** in the Course builder, switch on "Course complete — certificate can be given" on each finished course. Every course starts with it off, so nobody can be certified early.
2. **Staff roles:** in People & roles, set who is master admin, branch admin and teacher, with each person's branch.
3. **Student list:** in Announcements & surveys → Student roster, upload each branch's JHS student list as Excel or CSV. The template is downloadable there. A direct JHS link can later post to the same endpoint, `POST /v2/roster/import`.

## 4. Deploy
- `khat-backend`: `npm run build && npm start`.
- `khat-frontend`: `npm run build`, then deploy `dist/` as before. `dist/` now includes the app manifest, icons and `sw.js`, so phones and iPads can "Add to Home Screen".
- Background jobs start with the server:
  - work not answered in 72 h moves to the next teacher;
  - at 96 h the student gets a provisional automatic mark in the teacher's name, which the teacher confirms;
  - the email queue sends every 2 minutes;
  - also: teacher digest, merit reminders and branch change alerts.

## 5. Where things are (for changes later)
| Feature | Backend (`khat-backend/src/v2/…`) | Frontend (`khat-frontend/src/v2/…`) |
|---|---|---|
| Student dashboard, Guide me, badges | `routes/student.routes.ts`, `routes/badges.routes.ts` | `student/home/`, `student/StudentCoursePage.tsx` |
| Task page and Mashq page | `routes/student.routes.ts` | `student/task/` |
| WhatsApp-style chat, Department chat | `routes/threads.routes.ts`, `routes/deptChat.routes.ts`, `lib/chatLogic.ts` | `chat/`, `dept/`, `annotate/` |
| Teacher review, bulk stamped download, scan return, 72/96 h | `routes/review.routes.ts`, `lib/reviewLogic.ts`, `services/sla.ts`, `lib/sheetIds.ts`, `lib/pdfStamp.ts`, `routes/print.routes.ts` | `review/`, `teacher/`, `insights/` |
| Admin: policies, people, announcements, surveys, emails, roster, merit | `routes/policies.routes.ts`, `routes/people.routes.ts`, `routes/announcements.routes.ts`, `lib/emailTemplates.ts`, `routes/merit.routes.ts` | `admin/`, `people/`, `announce/` |
| Course builder, badge designs | `routes/courses.routes.ts`, `routes/ingest.routes.ts`, `routes/badges.routes.ts` | `admin/CourseBuilderPage.tsx`, `admin/CourseDetail.tsx`, `admin/badges/` |
| Gallery, showcase, events, books, older courses | `routes/content.routes.ts` | `content/` |
| In-site notifications (one allow-list) | `src/services/notify.ts` | `src/components/ui.tsx` |

## 6. Tests
- Backend: `cd khat-backend && npx tsc -p tsconfig.json --noEmit && npx tsx --test tests/v2/*.test.ts`. All pass.
- Frontend: `cd khat-frontend && npx tsc --noEmit -p tsconfig.app.json && npx vite build`.
- Every screen was tested in a browser against a real database at phone (390 px), iPad (820 px, touch) and desktop (1280 px) sizes, as student, teacher, branch admin and master admin. The test scripts are in `khat-frontend/tests-v3/`.

## 7. Please note
- Never commit or share `.env` files. Keys from an earlier zip should already have been rotated; if not, rotate them now.
- Running the tests rewrites the sample PDFs in `khat-backend/tests/v2/out/`. Don't commit those changes.
- Apple Pencil drawing is supported in code. Please try it once on a real iPad.
