/**
 * Minimal Google Drive v3 client for course-file import (no extra npm packages).
 *
 * Credentials (either one):
 *   GOOGLE_API_KEY               — works for folders shared "Anyone with the link can view"
 *   GOOGLE_SERVICE_ACCOUNT_JSON  — the service-account key JSON (raw JSON, base64 of it, or a file path);
 *                                  share the Drive folder with the service account's e-mail.
 */
import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

export type DriveAuth = { kind: 'key'; key: string } | { kind: 'token'; token: string };
export type DriveFile = { id: string; name: string; mimeType: string; size: number | null; path: string };

export class DriveError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const MAX_DRIVE_FILE_BYTES = 300 * 1024 * 1024;

/** Folder / file id from any Drive link (or a bare id). */
export function driveIdFromUrl(input: string): string | null {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (!/google\.com$/.test(u.hostname)) return null;
  const m = u.pathname.match(/\/(?:folders|d)\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  const id = u.searchParams.get('id');
  return id && /^[a-zA-Z0-9_-]{10,}$/.test(id) ? id : null;
}

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

function readServiceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  let text = raw;
  if (!raw.startsWith('{')) {
    if (existsSync(raw)) text = readFileSync(raw, 'utf8');
    else {
      try { text = Buffer.from(raw, 'base64').toString('utf8'); } catch { return null; }
    }
  }
  try {
    const sa = JSON.parse(text) as ServiceAccount;
    return sa.client_email && sa.private_key ? sa : null;
  } catch {
    return null;
  }
}

let cachedToken: { token: string; exp: number } | null = null;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function serviceAccountToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: tokenUri, iat: now, exp: now + 3600 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = b64url(signer.sign(sa.private_key.replace(/\\n/g, '\n')));
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${signature}` }),
  });
  if (!res.ok) throw new DriveError('Google did not accept the service account key. Check GOOGLE_SERVICE_ACCOUNT_JSON.', 502);
  const body = await res.json() as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new DriveError('Google did not return an access token for the service account.', 502);
  cachedToken = { token: body.access_token, exp: now + Number(body.expires_in ?? 3600) };
  return body.access_token;
}

export function driveConfigured(): boolean {
  return Boolean(process.env.GOOGLE_API_KEY?.trim() || readServiceAccount());
}

export const DRIVE_NOT_CONFIGURED = 'Google Drive import is not set up on the server yet. Ask the technical team to add GOOGLE_API_KEY (for folders shared "Anyone with the link") or GOOGLE_SERVICE_ACCOUNT_JSON to the backend settings. Until then, download the files and upload them in the course builder.';

export async function getDriveAuth(): Promise<DriveAuth> {
  const sa = readServiceAccount();
  if (sa) return { kind: 'token', token: await serviceAccountToken(sa) };
  const key = process.env.GOOGLE_API_KEY?.trim();
  if (key) return { kind: 'key', key };
  throw new DriveError(DRIVE_NOT_CONFIGURED, 400);
}

async function driveFetch(path: string, params: Record<string, string>, auth: DriveAuth): Promise<Response> {
  const qs = new URLSearchParams({ ...params, supportsAllDrives: 'true' });
  if (auth.kind === 'key') qs.set('key', auth.key);
  const headers: Record<string, string> = auth.kind === 'token' ? { Authorization: `Bearer ${auth.token}` } : {};
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}?${qs.toString()}`, { headers });
  if (res.status === 404 || res.status === 403) {
    throw new DriveError(auth.kind === 'key'
      ? 'Google Drive says this folder or file cannot be opened. Share it as "Anyone with the link can view" and try again.'
      : 'Google Drive says this folder or file cannot be opened. Share it with the service account e-mail and try again.', 400);
  }
  if (!res.ok) throw new DriveError(`Google Drive returned an error (${res.status}). Please try again in a minute.`, 502);
  return res;
}

/** Lists every file under a folder (recursively), skipping Google Docs/Sheets and trashed items. */
export async function listDriveFolder(folderId: string, auth: DriveAuth, opts: { maxFiles?: number; maxDepth?: number } = {}): Promise<DriveFile[]> {
  const maxFiles = opts.maxFiles ?? 3000;
  const maxDepth = opts.maxDepth ?? 6;
  const out: DriveFile[] = [];
  const queue: { id: string; path: string; depth: number }[] = [{ id: folderId, path: '', depth: 0 }];
  const seen = new Set<string>();
  while (queue.length && out.length < maxFiles) {
    const folder = queue.shift()!;
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    let pageToken: string | undefined;
    do {
      const res = await driveFetch('files', {
        q: `'${folder.id.replace(/'/g, '')}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size)',
        pageSize: '1000',
        includeItemsFromAllDrives: 'true',
        ...(pageToken ? { pageToken } : {}),
      }, auth);
      const body = await res.json() as { nextPageToken?: string; files?: { id: string; name: string; mimeType: string; size?: string }[] };
      for (const f of body.files ?? []) {
        if (f.mimeType === FOLDER_MIME) {
          if (folder.depth < maxDepth) queue.push({ id: f.id, path: `${folder.path}${f.name}/`, depth: folder.depth + 1 });
        } else if (!f.mimeType.startsWith('application/vnd.google-apps.')) {
          out.push({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size ? Number(f.size) : null, path: folder.path });
        }
      }
      pageToken = body.nextPageToken;
    } while (pageToken && out.length < maxFiles);
  }
  return out;
}

export async function getDriveFileMeta(fileId: string, auth: DriveAuth): Promise<{ id: string; name: string; mimeType: string; size: number | null }> {
  const res = await driveFetch(`files/${encodeURIComponent(fileId)}`, { fields: 'id, name, mimeType, size' }, auth);
  const f = await res.json() as { id: string; name: string; mimeType: string; size?: string };
  return { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size ? Number(f.size) : null };
}

export async function downloadDriveFile(fileId: string, auth: DriveAuth): Promise<Buffer> {
  const res = await driveFetch(`files/${encodeURIComponent(fileId)}`, { alt: 'media' }, auth);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DRIVE_FILE_BYTES) throw new DriveError('This file is larger than 300 MB and was skipped.', 413);
  return buf;
}
