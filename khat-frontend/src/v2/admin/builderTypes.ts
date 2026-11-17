/**
 * v3 builder — extra types on top of contracts.ts (which is not edited per agent).
 * Mirrors khat-backend/src/v2/lib/builderLogic.ts + routes/badges.routes.ts.
 */
import { API_BASE_URL, ApiError, getToken } from '@/api';
import type { CourseDetail, Level, StudentBadge } from '../contracts';

export type BadgeKind = 'level' | 'course' | 'competition';
export type BadgeDesign = {
  id: string;
  name: string;
  kind: BadgeKind;
  badgeCode: string | null;
  isDefault: boolean;
  storageKey: string | null;
  contentType: string | null;
  note: string | null;
  updatedAt: string | null;
  imageUrl: string | null;   // short-lived link to the artwork
  usedBy: number;            // levels/courses that chose it
};
export type KnownBadgeCode = { badgeCode: string; kind: BadgeKind; label: string; courseId: string | null };
export type BadgeDesignsResponse = { designs: BadgeDesign[]; codes: KnownBadgeCode[] };
/** GET /v2/badges/mine — for student-dash and achievements. */
export type MyBadge = StudentBadge & { artworkUrl: string | null; downloadUrl: string; title: string; subtitle: string };

export type LevelV3 = Level & { badgeDesignId?: string | null };
export type CourseV3 = CourseDetail & { badgeDesignId?: string | null; certificationReady?: boolean };

export const BADGE_KIND_LABEL: Record<BadgeKind, string> = { level: 'Level badge', course: 'Course badge', competition: 'Competition award' };

/** YouTube id from any YouTube link (same rules as the backend). */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, '').toLowerCase();
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname)?.[1] ?? null;
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** Fetches an authenticated PDF (or any file) from the API and opens or saves it. */
export async function openApiFile(path: string, opts: { download?: string } = {}): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_BASE_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (data as { error?: string }).error ?? 'The file could not be opened.');
  }
  const url = URL.createObjectURL(await res.blob());
  if (opts.download) {
    const a = document.createElement('a');
    a.href = url; a.download = opts.download; document.body.appendChild(a); a.click(); a.remove();
  } else {
    const w = window.open(url, '_blank', 'noopener');
    if (!w) window.location.assign(url);
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
