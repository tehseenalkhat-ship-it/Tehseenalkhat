import fs from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { config } from '../config.js';
import { sendEmail } from '../email.js';
import { contentTypeFor, filePath } from '../storage.js';
import { createRateLimiter, logError, reportStatus } from '../services/problemReports.js';

// Private developer page at /logs: problem reports and the error log. Plain server-rendered HTML,
// guarded by LOGS_PASSWORD from .env and independent of the site's own sign-in.
// If LOGS_PASSWORD is not set, every /logs URL answers 404.

const COOKIE = 'khat_logs';
const SESSION_HOURS = 12;
const loginLimiter = createRateLimiter(10, 15 * 60 * 1000); // 10 failed attempts per IP per 15 minutes

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmt = (value: unknown) => {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? esc(value) : esc(d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
};

function sessionKey(): Buffer {
  // Changing LOGS_PASSWORD (or JWT_SECRET) signs everyone out of /logs.
  return createHash('sha256').update(`${config.logsPassword}\n${config.jwtSecret}`).digest();
}

function makeSession(): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  return `${exp}.${createHmac('sha256', sessionKey()).update(String(exp)).digest('base64url')}`;
}

function hasSession(request: FastifyRequest): boolean {
  const raw = (request.headers.cookie ?? '').split(';').map((p) => p.trim()).find((p) => p.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const expected = Buffer.from(createHmac('sha256', sessionKey()).update(exp).digest('base64url'));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function passwordMatches(given: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(config.logsPassword ?? '').digest();
  return timingSafeEqual(a, b);
}

function cookieHeader(request: FastifyRequest, value: string, maxAge: number): string {
  const secure = request.protocol === 'https' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/logs; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>
:root{--ink:#29231d;--muted:#6f665a;--bg:#f6f0e5;--card:#fffdf8;--line:#dfd5c3;--gold:#aa781f;--red:#8d3327;--green:#3f6b4a;--blue:#2f5f8a}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}
header{background:#2b211b;color:#f7f0e4;padding:14px 24px;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
header strong{font-size:16px;margin-right:auto}header a{color:#e2c27a;text-decoration:none;font-weight:600}header a.on{color:#fff;border-bottom:2px solid #e2c27a}
main{max-width:1100px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:16px}
.meta{color:var(--muted);font-size:12px;display:flex;flex-wrap:wrap;gap:6px 16px;margin:6px 0 10px}
.text{white-space:pre-wrap;word-break:break-word;background:#f9f4ea;border-radius:6px;padding:10px 12px;margin:8px 0}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:700;color:#fff}
.b-New{background:var(--blue)}.b-Fixed{background:var(--gold)}.b-Confirmed{background:var(--green)}.b-Still{background:var(--red)}
.shot img{max-width:220px;max-height:160px;border:1px solid var(--line);border-radius:6px;display:block;margin-top:6px}
details{margin:8px 0}summary{cursor:pointer;color:var(--muted);font-size:12px}pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:#f3ede2;padding:10px;border-radius:6px;max-height:300px;overflow:auto}
textarea{width:100%;min-height:70px;font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px}
button,.btn{background:var(--gold);color:#fff;border:0;border-radius:6px;padding:9px 14px;font:inherit;font-weight:700;cursor:pointer}
.reply{border-left:4px solid var(--red);padding-left:12px;margin-top:12px}.reply.works{border-color:var(--green)}
.note{border-left:4px solid var(--gold);padding-left:12px;margin-top:12px}
.flash{background:#e9f2e6;border:1px solid #b9d3b1;padding:10px 14px;border-radius:8px;margin-bottom:16px}
.filters a{margin-right:10px;color:var(--gold);font-weight:600}.filters a.on{color:var(--ink);text-decoration:none}
.err{font-family:ui-monospace,Consolas,monospace;font-size:12px}.src{font-weight:700;text-transform:uppercase;font-size:11px}
.login{max-width:340px;margin:12vh auto}.login input{width:100%;padding:10px;margin:8px 0 12px;border:1px solid var(--line);border-radius:6px;font:inherit}
</style></head><body>${body}</body></html>`;
}

function sendHtml(reply: FastifyReply, html: string, code = 200) {
  return reply
    .code(code)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('X-Frame-Options', 'DENY')
    .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
    .send(html);
}

function loginPage(error = '') {
  return page(
    'Logs: sign in',
    `<form class="card login" method="post" action="/logs/login"><h2>Developer logs</h2>
${error ? `<p style="color:var(--red)">${esc(error)}</p>` : ''}
<label>Password<input type="password" name="password" autocomplete="current-password" autofocus required></label>
<button type="submit">Sign in</button></form>`
  );
}

function shotLink(key: string | null, label: string) {
  if (!key) return '';
  const url = `/logs/shot?key=${encodeURIComponent(key)}`;
  return `<div class="shot"><small>${esc(label)} (click to enlarge)</small><a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${esc(label)}"></a></div>`;
}

function browserSummary(raw: string | null): string {
  if (!raw) return '';
  try {
    const info = JSON.parse(raw);
    return esc([info.userAgent, info.screen && `screen ${info.screen}`, info.viewport && `window ${info.viewport}`, info.language, info.time]
      .filter(Boolean)
      .join(' · '));
  } catch {
    return esc(raw);
  }
}

function reportCard(r: any): string {
  const status = reportStatus(r);
  const badgeClass = status.split(' ')[0];
  const who = r.person_id ? `${esc(r.name ?? 'Unknown')} (${esc(r.person_role)}, ${esc(r.person_id)})` : 'Anonymous';
  let errors = '';
  if (r.recent_errors && r.recent_errors !== '[]') {
    let pretty = r.recent_errors;
    try {
      pretty = JSON.stringify(JSON.parse(r.recent_errors), null, 2);
    } catch {
      /* show as stored */
    }
    errors = `<details><summary>Recent browser errors</summary><pre>${esc(pretty)}</pre></details>`;
  }
  const note = r.fix_note || r.fixed_at
    ? `<div class="note"><strong>Marked fixed</strong> ${fmt(r.fixed_at)}${r.fix_note ? `<div class="text">${esc(r.fix_note)}</div>` : ''}</div>`
    : '';
  const answer = r.answer
    ? `<div class="reply ${r.answer === 'works' ? 'works' : ''}"><strong>${r.answer === 'works' ? 'They said: it works now' : 'They said: still a problem'}</strong> ${fmt(r.answered_at)}${
        r.answer === 'still' && r.reply ? `<div class="text">${esc(r.reply)}</div>${shotLink(r.reply_shot, 'Reply screenshot')}` : ''
      }</div>`
    : r.reply
      ? `<div class="reply"><strong>Earlier reply</strong><div class="text">${esc(r.reply)}</div>${shotLink(r.reply_shot, 'Earlier reply screenshot')}</div>`
      : '';
  const fixForm = `<form method="post" action="/logs/reports/${esc(r.id)}/fix" style="margin-top:14px">
<label><small>What I changed</small><textarea name="note" maxlength="5000" placeholder="Short note for the reporter"></textarea></label>
<button type="submit">${r.fixed_at ? 'Mark as fixed again and tell them' : 'Mark as fixed and tell them'}</button></form>`;
  return `<article class="card" id="r-${esc(r.id)}">
<span class="badge b-${badgeClass}">${esc(status)}</span>
<div class="meta"><span>${who}</span><span>${fmt(r.created_at)}</span><span>Page: ${esc(r.page ?? '')}</span></div>
<div class="meta"><span>${browserSummary(r.browser_info)}</span></div>
<div class="text">${esc(r.text)}</div>
${shotLink(r.screenshot, 'Screenshot')}${errors}${note}${answer}${fixForm}</article>`;
}

export async function logsRoutes(app: FastifyInstance) {
  // HTML forms post urlencoded bodies; only this /logs plugin parses them.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  app.addHook('onRequest', async (_request, reply) => {
    if (!config.logsPassword) return reply.code(404).send({ error: 'Not found' });
  });

  app.post<{ Body: { password?: string } }>('/login', async (request, reply) => {
    if (!loginLimiter(request.ip)) return sendHtml(reply, loginPage('Too many attempts. Wait 15 minutes and try again.'), 429);
    if (!passwordMatches(String(request.body?.password ?? ''))) return sendHtml(reply, loginPage('Wrong password.'), 401);
    reply.header('Set-Cookie', cookieHeader(request, makeSession(), SESSION_HOURS * 3600));
    return reply.redirect(303, '/logs');
  });

  app.post('/logout', async (request, reply) => {
    reply.header('Set-Cookie', cookieHeader(request, '', 0));
    return reply.redirect(303, '/logs');
  });

  app.get<{ Querystring: { tab?: string; source?: string; flash?: string } }>('/', async (request, reply) => {
    if (!hasSession(request)) return sendHtml(reply, loginPage());
    const tab = request.query.tab === 'errors' ? 'errors' : 'reports';
    const flash = request.query.flash ? `<div class="flash">${esc(request.query.flash)}</div>` : '';
    const nav = `<header><strong>Tehseen al-Khat: developer logs</strong>
<a href="/logs?tab=reports" class="${tab === 'reports' ? 'on' : ''}">Reports</a>
<a href="/logs?tab=errors" class="${tab === 'errors' ? 'on' : ''}">Errors</a>
<form method="post" action="/logs/logout" style="margin:0"><button type="submit" style="background:#46382a">Sign out</button></form></header>`;

    if (tab === 'reports') {
      const { rows } = await pool.query(`SELECT * FROM problem_reports ORDER BY created_at DESC LIMIT 200`);
      const body = rows.length ? rows.map(reportCard).join('') : '<p>No reports yet.</p>';
      return sendHtml(reply, page('Logs: reports', `${nav}<main>${flash}<h2>Reports (${rows.length})</h2>${body}</main>`));
    }

    const source = request.query.source === 'server' || request.query.source === 'browser' ? request.query.source : 'all';
    const { rows } = await pool.query(
      `SELECT * FROM error_log ${source === 'all' ? '' : 'WHERE source = $1'} ORDER BY created_at DESC, id DESC LIMIT 300`,
      source === 'all' ? [] : [source]
    );
    const filters = ['all', 'server', 'browser']
      .map((s) => `<a href="/logs?tab=errors&source=${s}" class="${source === s ? 'on' : ''}">${s[0].toUpperCase()}${s.slice(1)}</a>`)
      .join('');
    const list = rows.length
      ? rows
          .map(
            (e: any) => `<article class="card"><span class="src">${esc(e.source)}</span>
<div class="meta"><span>${fmt(e.created_at)}</span><span>${esc(e.url ?? '')}</span><span>${esc(e.person ?? '')}</span></div>
<div class="err">${esc(e.message)}</div>${e.stack ? `<details><summary>Stack</summary><pre>${esc(e.stack)}</pre></details>` : ''}</article>`
          )
          .join('')
      : '<p>No errors logged.</p>';
    return sendHtml(reply, page('Logs: errors', `${nav}<main>${flash}<h2>Errors</h2><p class="filters">${filters}</p>${list}</main>`));
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>('/reports/:id/fix', async (request, reply) => {
    if (!hasSession(request)) return reply.redirect(303, '/logs');
    const note = String(request.body?.note ?? '').trim().slice(0, 5000);
    const { rows } = await pool.query(`SELECT id, person_id, text FROM problem_reports WHERE id = $1`, [request.params.id]);
    const report = rows[0];
    if (!report) return reply.redirect(303, `/logs?flash=${encodeURIComponent('Report not found.')}`);

    // Marking fixed (again) asks the reporter for a fresh answer; an earlier reply stays visible.
    await pool.query(
      `UPDATE problem_reports SET fixed_at = CURRENT_TIMESTAMP(6), fix_note = $1, answer = NULL, answered_at = NULL WHERE id = $2`,
      [note || null, report.id]
    );

    let emailStatus = 'They will see it next time they open the site.';
    if (report.person_id) {
      const { rows: users } = await pool.query(`SELECT email FROM users WHERE id = $1`, [report.person_id]);
      const email = users[0]?.email;
      if (email) {
        try {
          await sendEmail(
            email,
            'We fixed the problem you reported',
            `We fixed the problem you reported:\n\n"${report.text}"\n\n${note ? `What we changed: ${note}\n\n` : ''}Please check and tell us whether it works now: ${config.frontendUrl}\n\n— Tehseen al-Khat`
          );
          emailStatus = config.resendApiKey ? `Email sent to ${email}.` : 'Email printed to the server log (RESEND_API_KEY is not set).';
        } catch (err) {
          request.log.error(err);
          await logError({ source: 'server', message: `Fix email failed: ${(err as Error).message}`, stack: (err as Error).stack, url: request.url });
          emailStatus = 'The email could not be sent (see Errors).';
        }
      }
    }
    return reply.redirect(303, `/logs?flash=${encodeURIComponent(`Marked as fixed. ${emailStatus}`)}#r-${report.id}`);
  });

  // Screenshots are only reachable through this password-protected route.
  app.get<{ Querystring: { key?: string } }>('/shot', async (request, reply) => {
    if (!hasSession(request)) return reply.code(401).send({ error: 'Sign in at /logs first' });
    const key = String(request.query.key ?? '');
    if (!key.startsWith('reports/')) return reply.code(400).send({ error: 'Invalid key' });
    let target: string;
    try {
      target = filePath(key);
    } catch {
      return reply.code(400).send({ error: 'Invalid key' });
    }
    if (!fs.existsSync(target)) return reply.code(404).send({ error: 'Screenshot not found' });
    return reply
      .header('Content-Type', contentTypeFor(key))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=3600')
      .send(fs.createReadStream(target));
  });
}
