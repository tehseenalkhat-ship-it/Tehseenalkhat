/**
 * Pure helpers for the v3 chat (owner: chat). No database, no network — unit tested.
 *  - friendly labels ("Level 1 · Step 2", "Certification course") instead of internal codes
 *  - voice-note meta (duration + waveform peaks)
 *  - the "request to meet at Funun" message
 *  - the AI helper prompt and its offline fallback
 */

export const DEPARTMENT_NAME = 'Funun al-Quran';
export const DEPARTMENT_CHAT_NAME = 'Funun al-Quran Department';
export const MEET_REQUEST_TEXT = 'Please come to the Funun al-Quran office to discuss your kitabat further.';

/** "LV02" → 2, "S01" → 1, falls back to order index + 1. */
export function numberFromCode(code: string | null | undefined, fallbackIndex?: number | null): number | null {
  const m = /(\d+)\s*$/.exec(String(code ?? ''));
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (typeof fallbackIndex === 'number' && Number.isFinite(fallbackIndex)) return fallbackIndex + 1;
  return null;
}

export function courseKindLabel(courseType: string | null | undefined): string | null {
  switch ((courseType ?? '').toLowerCase()) {
    case 'certification': return 'Certification course';
    case 'crash': return 'Crash course';
    case 'mashq': return 'Mashq worksheets';
    default: return null;
  }
}

/** "Level 1 · Step 2 — Two-letter joins" (no internal codes). */
export function friendlyStepLabel(s: { levelCode?: string | null; levelOrder?: number | null; stepCode?: string | null; title?: string | null; hideLevel?: boolean }): string {
  const level = numberFromCode(s.levelCode, s.levelOrder ?? null);
  const step = numberFromCode(s.stepCode, null);
  const parts: string[] = [];
  if (!s.hideLevel && level) parts.push(`Level ${level}`);
  if (step) parts.push(`Step ${step}`);
  const head = parts.join(' · ');
  const title = (s.title ?? '').trim();
  if (head && title) return `${head} — ${title}`;
  return head || title || 'this step';
}

/** "Fann al-Khat 1, Level 1 · Step 2 — Two-letter joins" for emails and notifications. */
export function friendlyThreadLabel(ctx: { courseTitle?: string | null; levelCode?: string | null; levelOrder?: number | null; code?: string | null; title?: string | null; courseType?: string | null }): string {
  const hideLevel = (ctx.courseType ?? '') !== 'certification' && numberFromCode(ctx.levelCode, ctx.levelOrder ?? null) === 1;
  const step = friendlyStepLabel({ levelCode: ctx.levelCode, levelOrder: ctx.levelOrder, stepCode: ctx.code, title: ctx.title, hideLevel });
  const course = (ctx.courseTitle ?? '').trim();
  return course ? `${course}, ${step}` : step;
}

/** Keeps voice duration + a small waveform (0..1 peaks, max 64) from the client meta. */
export function sanitiseVoiceMeta(raw: unknown): { durationSec?: number; waveform?: number[] } {
  const meta = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: { durationSec?: number; waveform?: number[] } = {};
  const dur = Number(meta.durationSec);
  if (Number.isFinite(dur) && dur >= 0) out.durationSec = Math.round(Math.min(dur, 3600) * 10) / 10;
  if (Array.isArray(meta.waveform)) {
    const peaks = meta.waveform.slice(0, 64).map(v => Number(v)).filter(v => Number.isFinite(v)).map(v => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100);
    if (peaks.length >= 8) out.waveform = peaks;
  }
  return out;
}

export function messagePreview(m: { kind: string; body: string | null; meta?: Record<string, unknown> | null }): string {
  if (m.meta && (m.meta as { event?: unknown }).event === 'meet_request') return 'Request to meet at the Funun al-Quran office';
  if (m.kind === 'voice') return '🎤 Voice note';
  if (m.kind === 'files') return m.body?.trim() ? `📷 ${m.body.trim().slice(0, 80)}` : '📷 Photo';
  if (m.kind === 'mark') return 'Marks given';
  if (m.kind === 'annotation') return '✏️ Corrected sheet';
  return (m.body ?? '').trim().slice(0, 120);
}

/* ---------------- AI helper ---------------- */

export type AssistMode = 'polish' | 'ask' | 'reply';
export type AssistRequest = { mode: AssistMode; text: string; studentName?: string | null; context?: string | null };

export function normaliseAssist(body: unknown): AssistRequest | { error: string } {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const mode: AssistMode = b.mode === 'ask' || b.mode === 'reply' ? b.mode : 'polish';
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (mode !== 'reply' && !text) return { error: mode === 'ask' ? 'Type your question first.' : 'Write a few words first — the helper will polish them.' };
  if (text.length > 2000) return { error: 'Please keep it under 2000 characters.' };
  const studentName = typeof b.studentName === 'string' && b.studentName.trim() ? b.studentName.trim().slice(0, 80) : null;
  const context = typeof b.context === 'string' && b.context.trim() ? b.context.trim().slice(0, 1500) : null;
  return { mode, text, studentName, context };
}

export function buildAssistPrompt(r: AssistRequest): { system: string; user: string } {
  const base = [
    'You are a helper for Arabic calligraphy teachers of Funun al-Quran at Al-Jamea-tus-Saifiyah.',
    'The teachers are calligraphers, not technical people. Use plain, warm, respectful English. No headings, no markdown, no emojis.',
    'Use calligraphy vocabulary naturally (alif, nuqta, satr/baseline, huruf, mufradaat, murakkabaat, kursi, qalam, mistar, Naskh, Thuluth, Nastaleeq).',
  ];
  if (r.mode === 'ask') {
    return {
      system: [...base, 'Answer the teacher\'s question briefly and practically (at most 5 short sentences). If it is about a student, suggest what to say to them.'].join('\n'),
      user: [r.context ? `Conversation so far (latest last):\n${r.context}` : '', `Question: ${r.text}`].filter(Boolean).join('\n\n'),
    };
  }
  if (r.mode === 'reply') {
    return {
      system: [...base, 'Suggest one short reply (1–3 sentences) the teacher can send to the student, speaking directly to the student. Reply with the message only.'].join('\n'),
      user: [r.studentName ? `Student's first name: ${r.studentName.split(/\s+/)[0]}` : '', r.context ? `Conversation so far (latest last):\n${r.context}` : '', r.text ? `Teacher's idea: ${r.text}` : ''].filter(Boolean).join('\n\n'),
    };
  }
  return {
    system: [...base, 'Rewrite the teacher\'s message so it is clear, warm and encouraging, keeping the exact meaning and every correction. At most 3 sentences. Reply with the message only.'].join('\n'),
    user: [r.studentName ? `Student's first name: ${r.studentName.split(/\s+/)[0]}` : '', `Teacher's message: ${r.text}`].filter(Boolean).join('\n'),
  };
}

const TIPS: { re: RegExp; tip: string }[] = [
  { re: /\balif\b/i, tip: 'For the alif: keep the qalam at the same angle from top to bottom and check its height against the nuqta measure (three nuqtas in Naskh is a good guide).' },
  { re: /nuq?ta|dot/i, tip: 'For the nuqta: one clean, square press of the qalam — practice a row of nuqtas first and use them to measure the letters.' },
  { re: /baseline|satr|line/i, tip: 'For the baseline: ask the student to draw a light pencil line with the mistar and let every letter rest on it.' },
  { re: /space|spacing|gap/i, tip: 'For spacing: compare the gaps between words with the width of one letter; even gaps make the page calm.' },
  { re: /qalam|pen|cut/i, tip: 'For the qalam: a fresh, even cut and a steady angle solve most uneven strokes — check the nib before blaming the hand.' },
  { re: /motivat|encourag|lazy|push|dormant|slow/i, tip: 'For encouragement: praise one specific thing that improved, then give one small, clear next step — small wins keep students coming back.' },
  { re: /meet|office|in person/i, tip: 'If the correction is easier shown than written, use "Ask to meet" — it sends a ready message inviting the student to the Funun al-Quran office.' },
];

/** Used when no AI model is configured: a light, honest fallback. */
export function offlineAssist(r: AssistRequest): string {
  const first = r.studentName ? r.studentName.split(/\s+/)[0] : '';
  if (r.mode === 'polish') {
    let t = r.text.replace(/\s+/g, ' ').trim();
    t = t.charAt(0).toUpperCase() + t.slice(1);
    if (!/[.!?]$/.test(t)) t += '.';
    const opener = first ? `${first}, ` : '';
    return `${opener}${opener ? t.charAt(0).toLowerCase() + t.slice(1) : t} Keep practicing — you are making progress.`;
  }
  if (r.mode === 'reply') {
    return `${first ? `Salaam ${first}, ` : 'Salaam, '}thank you for your message. I have seen your work — keep practicing as we discussed, and send me your next page when it is ready.`;
  }
  const hits = TIPS.filter(t => t.re.test(r.text)).map(t => t.tip);
  if (hits.length) return hits.slice(0, 2).join(' ');
  return 'The AI helper is not connected right now. A good rule: start with one thing the student did well, then give one clear correction and a small next step.';
}

/** Trims model output to plain text (no quotes/markdown). */
export function tidyAssist(answer: string, maxChars = 900): string {
  return answer
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\*\*|__|^#+\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

/* ---------------- dept chat list ---------------- */

export type DeptThreadRow = { studentId: string; lastAt: string | null; unread: number };

/** Unread first, then most recent activity. Students without messages last (by name). */
export function sortDeptThreads<T extends DeptThreadRow & { name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if ((b.unread > 0 ? 1 : 0) !== (a.unread > 0 ? 1 : 0)) return (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0);
    if (a.lastAt && b.lastAt) return b.lastAt.localeCompare(a.lastAt);
    if (a.lastAt) return -1;
    if (b.lastAt) return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Staff emails for a new student message: at most one per conversation every `minutes`. */
export function shouldEmailStaff(previousStudentMessageAt: Date | null, now: Date, minutes = 30): boolean {
  if (!previousStudentMessageAt) return true;
  return now.getTime() - previousStudentMessageAt.getTime() >= minutes * 60_000;
}
