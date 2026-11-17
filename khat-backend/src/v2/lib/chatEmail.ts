/**
 * Chat emails (owner: chat). Uses admin-comms' `queueEmail(to, key, vars)` from
 * `src/v2/lib/emailTemplates.ts` when it exists (batched, capped, logged), otherwise
 * falls back to sending the plain text directly with `sendEmail`. Never throws.
 */
import { config } from '../../config.js';
import { sendEmail } from '../../email.js';

type QueueEmail = (to: string, key: string, vars: Record<string, unknown>) => Promise<unknown>;
let queueFn: QueueEmail | null | undefined;

async function loadQueue(): Promise<QueueEmail | null> {
  if (queueFn !== undefined) return queueFn;
  try {
    const path = './emailTemplates.js';
    const mod = (await import(/* @vite-ignore */ path)) as { queueEmail?: QueueEmail };
    queueFn = typeof mod.queueEmail === 'function' ? mod.queueEmail : null;
  } catch {
    queueFn = null;
  }
  return queueFn;
}

export function chatLink(page: string): string {
  return `${config.frontendUrl.replace(/\/+$/, '')}/#${page}`;
}

export const CHAT_SIGN_OFF = '— Tehseen al-Khat · Funun al-Quran, Al-Jamea-tus-Saifiyah';

export async function sendChatEmail(
  to: string | null | undefined,
  key: 'teacher_reply' | 'dept_reply' | 'mark_given',
  vars: Record<string, unknown>,
  fallback: { subject: string; text: string },
): Promise<boolean> {
  if (!to || !/^[^\s@]+@[^\s@]+$/.test(to)) return false;
  try {
    const queue = await loadQueue();
    if (queue) { await queue(to, key, { ...vars, subject: fallback.subject, text: fallback.text }); return true; }
    await sendEmail(to, fallback.subject, fallback.text);
    return true;
  } catch (error) {
    console.error('[v3 chat] email failed', error);
    return false;
  }
}
