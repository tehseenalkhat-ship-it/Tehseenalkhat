# To do later

## Email (Resend)
- Make a Resend account and add the site's domain there.
- In DirectAdmin → Setup Node.js App, add `RESEND_API_KEY` and `EMAIL_FROM` (e.g. `no-reply@<your domain>`), then Restart.
- Until then, emails (marks, replies, forgot password, digests) are only written to the server log and are not kept for later.

## Install app (phone / iPad / desktop)
- Switched off for now; the code is kept.
- To turn it back on:
  - `khat-frontend/src/App.tsx`: remove `false &&` from the `V3InstallAppPrompt` line.
  - `khat-frontend/index.html`: restore the `manifest` line and the `sw.js` registration (see the TODO comments there).
- Then test "Add to Home Screen" on a real phone and iPad.

## Admin request (Report a problem, 23 Nov 2026)
- "Google sheet link, for master course sequence": already exists (Course builder → Import master list → "Google Sheet link" tab; checked working live 24 Nov 2026). Waiting to hear if the admin wants more, e.g. the site remembering the link so it can re-sync.

## Also pending
- Try the teacher drawing tools once with an Apple Pencil on a real iPad.
