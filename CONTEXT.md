# Tehseen al-Khat — project context for AI assistants

Read this whole file before changing anything. The person you are working with is a calligraphy
teacher, **not a programmer**. They will describe what they want in plain words ("make the dashboard
feel calmer", "use a deeper green", "bigger Arabic headings"). Your job is to turn that into careful,
working changes to the **look and feel** of the website, explain what you changed in simple language,
and never leave the site broken.

---

## 1. What this website is

**Tehseen al-Khat** is the calligraphy learning platform of Al-Jamea-tus-Saifiyah.

- **Live site:** https://tehseenalkhat.ajsn.co.ke
- **Students** follow certification courses per script (Naskh, Naskh normal pen, Sulus/Thuluth,
  Nastaaleeq), submit practice work for review, earn badges and certificates, join competitions and
  live events, and post to a community showcase.
- **Teachers** review submitted work (with an annotation tool), keep an asset library, judge
  competitions and host events. A **coordinator** is a teacher with branch-wide statistics.
- **Admins** manage users, courses/levels, TR numbers (student sign-up codes), certificates,
  competitions, events, resources/books, showcase moderation and site statistics.
- Branches: Nairobi, Karachi, Surat, Sidhpur, Marol / Mumbai.
- The tone is warm, editorial and dignified — manuscript paper, ink, gold — not a generic SaaS look.

## 2. How the project is laid out

```
Khat-Website/
├── khat-frontend/          ← THE WEBSITE YOU WILL STYLE (React + Vite + TypeScript + Tailwind)
│   ├── index.html
│   ├── vite.config.ts       (do not change build.assetsDir — see rules)
│   ├── tailwind.config.js
│   ├── public/              static files served as-is (e.g. /mock-badge.svg)
│   └── src/
│       ├── index.css        ★ main stylesheet (~2,500 lines): colours, themes, layout, every page
│       ├── responsive-fixes.css   small mobile fixes
│       ├── theme.ts         ★ the 4 colour themes users can pick (blue, green, gold, maroon)
│       ├── App.tsx          page switching (hash routes like #dashboard, #login-student)
│       ├── components/
│       │   └── ui.tsx       ★ shared building blocks: Header, Footer, Drawer (mobile menu), Logo,
│       │                      Button, StatusChip, StatCard, SectionHeading, ScriptCard, BadgeIcon,
│       │                      ShowcasePostCard, GalleryCard, ActivityHeatmap, UploadBox, Modal, PenLoader …
│       ├── pages/
│       │   ├── auth.tsx     landing page, role choice, login, sign-up, password pages, settings
│       │   ├── student.tsx  student dashboard, catalog, course view, achievements, profile, competitions, events …
│       │   ├── teacher.tsx  teacher + coordinator dashboards, review queue, review page, asset library …
│       │   ├── admin.tsx    the whole admin area
│       │   └── public.tsx   public gallery
│       ├── data/mock.ts     display labels/colours for the scripts (names, Arabic names, taglines)
│       ├── api.ts           talks to the server — DO NOT CHANGE
│       ├── compress.ts      shrinks images/videos before upload — DO NOT CHANGE
│       └── public/          images used by the pages (import them, see rules)
├── khat-backend/            server + database code — DO NOT TOUCH for design work
└── .github/workflows/       automatic deployment — DO NOT TOUCH
```

### Where the look and feel lives
- **Colours:** CSS variables at the top of `src/index.css` (`:root{ --ink, --muted, --cream, --card,
  --line, --gold, --gold-soft, --maroon, --green, --theme-deep }`), then one block per theme:
  `html[data-theme="blue"]`, `"green"`, `"maroon"` (gold is the default `:root`), plus shared tokens
  under `html[data-theme]` (`--surface-deep`, `--accent-soft`, `--danger`, `--heat-1..` …).
  To recolour the site, change these variables — don't hunt down hex codes in components.
- **Theme picker swatches:** `src/theme.ts` (`THEME_OPTIONS`, `DEFAULT_THEME = 'gold'`). If a theme's
  colours change in `index.css`, update its swatch colours here too.
- **Fonts:** imported from Google Fonts on line 1 of `src/index.css` (DM Sans for text, Libre
  Baskerville for headings). Arabic script names (نسخ، ثلث، نستعلیق) appear in headings and cards.
- **Page-specific styling:** `src/index.css` is organised in commented sections, e.g.
  `/* Shared authenticated dashboard shell */`, `/* Mobile drawer (left-side) */`,
  `/* Landing role selection … */`, `/* Course environment … */`, `/* Admin overview … */`.
  Search for the section comment before editing a page.
- **Layout/markup:** the `.tsx` files use both Tailwind classes and the custom classes from
  `index.css`. Icons come from `lucide-react`.

## 3. Running it on your computer

Requirements: **Node.js 20 or newer** (https://nodejs.org, "LTS").

```bash
cd khat-frontend
npm install        # first time only (takes a few minutes)
npm run dev        # starts the site at http://localhost:5173
```

Open http://localhost:5173 in a browser. Changes to files appear in the browser instantly.

`khat-frontend/.env.local` points the local site at the **live server**
(`VITE_API_BASE_URL=https://tehseenalkhat.ajsn.co.ke`). That means:
- You log in with **real accounts** and see **real data**. Ask the site owner for test accounts
  (one student, one teacher, one admin) and use those.
- Anything you click that saves, approves, deletes or uploads **changes the real website's data**.
  For design work, look and click around freely, but avoid delete/approve/reject buttons and
  avoid submitting forms unless that is what you are testing.
- Images and PDFs that were uploaded before October 2026 may not appear (they were on an old
  storage service). That is expected, not something to fix in the design.

## 4. Rules for the AI (important)

1. **Design changes only, unless asked otherwise.** Change styling, layout, wording on the page,
   spacing, colours, fonts, icons, images and animations. Do **not** change how data is loaded or
   saved: leave `api.ts`, `compress.ts`, the `apiFetch(...)` calls, the data fields used in pages, and
   everything in `khat-backend/` and `.github/` alone.
2. **Keep every feature working.** Don't remove buttons, forms, tabs or pages to make something look
   simpler unless the teacher explicitly asks — and then confirm first. Hiding something with CSS
   still counts as removing it.
3. **Keep the hash routes** (`#dashboard`, `#login-student`, `#admin-users`, …). Links and emails rely
   on them.
4. **Don't change `build: { assetsDir: 'static' }` in `vite.config.ts`.** The server uses `/assets`
   for its own data; renaming this breaks the live site.
5. **Images:** put new images in `src/public/` (or `public/`) and **import** them in code
   (`import photo from '../public/photo.jpg'`). Never write paths like `'src/public/photo.jpg'` in
   styles — they work locally and break on the live site.
6. **Use the theme variables** (`var(--gold)`, `var(--card)` …) for colours so all four themes keep
   working. After a colour change, check at least the gold theme and one other (the theme picker is
   in the header / settings).
7. **Arabic text** must stay readable and right-to-left; don't shrink it below the surrounding text.
8. **Mobile matters** — many students use phones. Check every change at phone width (about 390px)
   as well as desktop. The mobile menu is the `Drawer` in `ui.tsx`.
9. **Accessibility:** keep text contrast readable, keep `aria-label`s and alt text, keep buttons
   reachable by keyboard.
10. **No heavy new libraries.** Prefer CSS, Tailwind and the existing `lucide-react` icons. Ask before
    adding any npm package.
11. **Small steps.** Make one change at a time, show the result, and let the teacher react. After each
    working change, save a checkpoint with git (see §6) so it can be undone.
12. **Before saying a change is done, run:**
    ```bash
    cd khat-frontend
    npm run typecheck
    npm run build
    ```
    Both must finish without errors. If they fail, fix the problem before handing back.
13. **Explain simply.** Tell the teacher what changed and where to look, without jargon. Never paste
    long code at them unless they ask.

## 5. Accounts and roles to test with

Pages differ by role. To see a page, log in as that role from the landing page (Student, Faculty,
Coordinator, Admin). Use the test accounts the site owner gives you. Never type real passwords into
files in this project.

## 6. Saving checkpoints and undoing (git)

This folder is a git repository, so every step can be saved and undone.
- Save a checkpoint after each change that works:
  `git add -A && git commit -m "Short description of the design change"`
- See checkpoints: `git log --oneline`
- Throw away unsaved changes to a file: `git restore <file>`
- Go back to the last checkpoint completely: `git restore .`

## 7. Getting changes onto the live site

The live site updates **automatically** whenever changes are pushed to the `main` branch of the
GitHub repository `tehseenalkhat-ship-it/Tehseenalkhat`: GitHub builds the site and uploads it to
the hosting in about 2 minutes. Uploaded files and the database are never affected by a deploy.

- **If the teacher has been given GitHub access:** `git push origin main`, then watch
  https://github.com/tehseenalkhat-ship-it/Tehseenalkhat/actions until the run turns green, then
  ask the site owner to click **Restart** on the Node.js app in DirectAdmin only if anything in
  `khat-backend/` changed (design-only changes go live without a restart; hard-refresh the browser).
- **If not:** zip the `khat-frontend` folder **without** `node_modules` and `dist` and send it to the
  site owner, who will push it.

Never push something that fails `npm run build`.

## 8. Technical facts (for the AI)

- Frontend: React 18, TypeScript, Vite 5, Tailwind CSS 3, lucide-react, react-pdf, LiveKit
  components (live events). State is per-page React state; there is no global store.
- Routing is hash-based (`useHash` / `navigate` in `ui.tsx`, switch in `App.tsx`).
- The frontend calls the API with relative URLs in production (same server) and with
  `VITE_API_BASE_URL` locally.
- Backend: Fastify on Node 20, MariaDB 10.6, bundled to one file (`dist/server.cjs`) that also serves
  the built frontend. Uploaded files live on the server in `KhatApp/uploads` and are served through
  signed `/uploads/raw` links. Live events need a LiveKit server, which is not configured, so the
  events room won't connect — that's expected.
