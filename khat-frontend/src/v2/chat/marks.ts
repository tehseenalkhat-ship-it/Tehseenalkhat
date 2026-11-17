import type { MarkBand } from '../contracts';

/** What a mark means, in one plain line (owner note 5.4 — shown when a mark is pressed). */
export function markMeaning(mark: number, band: MarkBand): string {
  if (band === 'revision') {
    if (mark >= 5) return 'Nearly there — practice the corrections and send it again.';
    if (mark >= 3) return 'Needs more practice — follow the notes and try again.';
    return 'Let’s go over this together — practice slowly and send it again.';
  }
  if (band === 'distinction') return mark >= 10 ? 'Outstanding — a perfect page. Mubarak!' : 'Excellent — a beautiful, confident page.';
  if (mark >= 8) return 'Very good — neat and confident, small points to polish.';
  if (mark >= 7) return 'Good — clear progress. Keep polishing the small points.';
  return 'Pass — the basics are right. Keep practicing the corrections.';
}

export function bandName(band: MarkBand | null | undefined): string {
  return band === 'distinction' ? 'Distinction' : band === 'pass' ? 'Pass' : band === 'revision' ? 'Try again' : '';
}

export function bandFrom(mark: number, bands: { revisionMax: number; passMax: number }): MarkBand {
  if (mark <= bands.revisionMax) return 'revision';
  if (mark <= bands.passMax) return 'pass';
  return 'distinction';
}

/** "LV02" → "Level 2", "S01" → "Step 1" (students never see codes). */
export function codeNumber(code: string | null | undefined): number | null {
  const m = /(\d+)\s*$/.exec(code ?? '');
  return m ? Number(m[1]) || null : null;
}
export function friendlyStep(step: { levelCode?: string | null; code?: string | null; title?: string | null; friendlyLabel?: string | null }): string {
  if (step.friendlyLabel) return step.friendlyLabel;
  const lv = codeNumber(step.levelCode);
  const st = codeNumber(step.code);
  const head = [lv ? `Level ${lv}` : null, st ? `Step ${st}` : null].filter(Boolean).join(' · ');
  return [head, step.title].filter(Boolean).join(' — ') || 'This step';
}
