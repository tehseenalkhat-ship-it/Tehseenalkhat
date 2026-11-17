/**
 * v3 content — pure helpers (no DB) for the gallery, showcase, events, resources and
 * older-courses endpoints. Unit tested in tests/v2/v3-content.test.ts.
 */

/** Returns the 11-character YouTube video id of a watch / share / embed / shorts / live link, else null. */
export function youTubeId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\.|^music\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] ?? null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
      id = m ? m[1] : null;
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** Canonical watch link stored in the database. */
export function youTubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** Privacy-enhanced embed used by the site's player. */
export function youTubeEmbedUrl(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1`;
}

/** "How much time did this take you?" — accepts whole minutes 1..6000 (100 h), else null. */
export function normaliseMinutes(input: unknown): number | null {
  const n = typeof input === 'string' ? Number(input.trim()) : typeof input === 'number' ? input : NaN;
  if (!Number.isFinite(n)) return null;
  const m = Math.round(n);
  return m >= 1 && m <= 6000 ? m : null;
}

/** Effort label shown on a showcase card: 45 → "45 min", 90 → "1 h 30 min", 120 → "2 hours". */
export function effortLabel(minutes: number | null | undefined): string | null {
  if (!minutes || minutes < 1) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  if (!m) return h === 1 ? '1 hour' : `${h} hours`;
  return `${h} h ${m} min`;
}

/** Note 1.10: "Selected for decoration" is no longer shown; it reads simply "Selected". */
export function cleanAwardLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const t = label.trim();
  if (!t) return null;
  return /^selected for decoration$/i.test(t) ? 'Selected' : t;
}

/** Removes a legacy "Selected for decoration — " prefix from a caption. */
export function cleanCaption(caption: string | null | undefined): string | null {
  if (!caption) return null;
  const t = caption.replace(/^\s*selected for decoration\s*[—–-]\s*/i, '').trim();
  return t || null;
}

export function cleanText(input: unknown, max: number): string | null {
  if (typeof input !== 'string') return null;
  const t = input.trim().slice(0, max);
  return t || null;
}

export const BOOK_LANGUAGES = ['Arabic', 'Lisan ud-Dawat', 'Urdu', 'English', 'Farsi'] as const;
export function normaliseLanguage(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const t = input.trim().toLowerCase();
  return BOOK_LANGUAGES.find(l => l.toLowerCase() === t) ?? null;
}

/**
 * Old-system ("older") course visibility for a student:
 * published, structure_version 1, has at least one level, and open to the student's branch
 * (a course with no branch rows is open to every branch).
 */
export function olderCourseVisible(c: { status: string | null; structureVersion: number | null; levelCount: number; branchIds: string[] }, branchId: string | null): boolean {
  if ((c.status ?? 'published') !== 'published') return false;
  if ((c.structureVersion ?? 1) !== 1) return false;
  if (c.levelCount < 1) return false;
  if (!c.branchIds.length) return true;
  return !!branchId && c.branchIds.includes(branchId);
}

/** Who may change a gallery work: master any; other staff only their own branch's works. */
export function canEditGalleryWork(actor: { isMaster: boolean; isStaff: boolean; branchId: string | null }, workBranchId: string | null): boolean {
  if (actor.isMaster) return true;
  return actor.isStaff && !!workBranchId && workBranchId === actor.branchId;
}
