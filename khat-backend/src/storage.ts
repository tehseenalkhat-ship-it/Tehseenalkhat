import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

// Files live on the server's own disk, in UPLOAD_DIR (default: an `uploads` folder next to the
// app folder, so redeploying the app never touches it). The browser still uploads/downloads
// directly via short-lived signed URLs, exactly like the old object-storage flow:
//   PUT /uploads/put?key=..&exp=..&sig=..   (see uploads.routes.ts)
//   GET /uploads/raw?key=..&exp=..&sig=..
export const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? path.join(process.cwd(), '..', 'uploads'));

const SIGNED_URL_EXPIRY_SECONDS = 60 * 60; // 1 hour — long enough for large uploads and video playback

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  heic: 'image/heic', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', json: 'application/json', txt: 'text/plain',
};

export function contentTypeFor(storageKey: string): string {
  return MIME[storageKey.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/**
 * Builds a consistent storage key. `prefix` groups files by what they are
 * (e.g. 'levels', 'entries', 'showcase', 'certificates') — it becomes a sub-folder.
 */
export function buildStorageKey(prefix: string, originalFilename: string): string {
  const ext = originalFilename.includes('.') ? originalFilename.split('.').pop() : undefined;
  const unique = randomUUID();
  return ext ? `${prefix}/${unique}.${ext}` : `${prefix}/${unique}`;
}

/** Absolute path for a key; throws on anything that could escape the upload folder. */
export function filePath(storageKey: string): string {
  if (!/^[\w\-.]+(\/[\w\-.]+)*$/.test(storageKey) || storageKey.split('/').includes('..')) {
    throw new Error('Invalid storage key');
  }
  const full = path.resolve(uploadDir, storageKey);
  if (!full.startsWith(uploadDir + path.sep)) throw new Error('Invalid storage key');
  return full;
}

function sign(action: string, key: string, exp: number, extra = ''): string {
  return createHmac('sha256', config.jwtSecret).update(`${action}\n${key}\n${exp}\n${extra}`).digest('base64url');
}

export function verifySignature(action: string, key: string, exp: string, sig: string, extra = ''): boolean {
  const expNum = Number(exp);
  if (!key || !sig || !Number.isFinite(expNum) || expNum < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(action, key, expNum, extra));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function signedUrl(action: 'put' | 'raw', storageKey: string, extra: Record<string, string> = {}): string {
  const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_EXPIRY_SECONDS;
  const params = new URLSearchParams({ key: storageKey, exp: String(exp), ...extra });
  params.set('sig', sign(action, storageKey, exp, extra.filename ?? ''));
  return `/uploads/${action}?${params.toString()}`;
}

/** Short-lived URL the frontend PUTs the file bytes to. */
export async function getUploadUrl(storageKey: string, _contentType: string): Promise<string> {
  filePath(storageKey); // validate early
  return signedUrl('put', storageKey);
}

/** Short-lived URL to view (or, with a filename, download) a stored file. */
export async function getDownloadUrl(storageKey: string, downloadFilename?: string): Promise<string> {
  const safeFilename = downloadFilename?.replace(/[\r\n"/\\]/g, '_').trim();
  return signedUrl('raw', storageKey, safeFilename ? { filename: safeFilename } : {});
}

export async function getObjectBytes(storageKey: string): Promise<{ body: Buffer; contentType: string }> {
  return { body: await fs.promises.readFile(filePath(storageKey)), contentType: contentTypeFor(storageKey) };
}

export async function deleteObject(storageKey: string): Promise<void> {
  await fs.promises.rm(filePath(storageKey), { force: true });
}

export async function objectExists(storageKey: string): Promise<boolean> {
  return fs.existsSync(filePath(storageKey));
}
