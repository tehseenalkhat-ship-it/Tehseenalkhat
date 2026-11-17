import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import type { RefineCommentRequest, RefineCommentResponse } from '../contracts.js';
import { getActor, requireStaff } from '../lib/access.js';
import { getEffectivePolicies } from '../lib/policies.js';
import { bandForMark, normaliseBands, polishComment, tidyAiComment } from '../lib/reviewLogic.js';

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', ur: 'Urdu', ar: 'Arabic' };

export function buildRefinePrompt(req: { text: string; studentName: string | null; mark: number | null; band: string | null; tone: string; language: string }): { system: string; user: string } {
  const system = [
    'You help Arabic calligraphy teachers at Al-Jamea-tus-Saifiyah (Tadreeb Fanni) write feedback to their students.',
    'Rewrite the teacher\'s note so it is warm, encouraging, specific and respectful, in at most 3 short sentences.',
    'Keep the teacher\'s meaning exactly: every correction they mention must stay, and do not add new criticisms or praise they did not imply.',
    'Keep calligraphy vocabulary as written (alif, nuqta, baseline/satr, huruf, mufradaat, murakkabaat, kursi, qalam, Naskh, Thuluth, Nastaleeq, tazheeb…).',
    'Speak directly to the student ("your alif…"). Start with something encouraging, then the correction as a clear next step.',
    'Never mention marks being automatic, never mention AI, no emojis, no headings, no quotation marks. Reply with the rewritten comment only.',
    req.tone === 'concise' ? 'Keep it very short: 1–2 sentences.' : req.tone === 'detailed' ? 'Use up to 3 sentences with one concrete practice tip.' : 'Use 2–3 gentle sentences.',
    `Write in ${LANGUAGE_NAMES[req.language] ?? 'English'}.`,
  ].join('\n');
  const user = [
    req.studentName ? `Student's first name: ${req.studentName.split(/\s+/)[0]}` : '',
    req.mark !== null ? `Mark given: ${req.mark}/10 (${req.band})` : '',
    `Teacher's note: ${req.text}`,
  ].filter(Boolean).join('\n');
  return { system, user };
}

async function askModel(system: string, user: string): Promise<string | null> {
  if (!config.assistant.baseUrl || !config.assistant.model) return null;
  const endpoint = `${config.assistant.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.assistant.apiKey ? { Authorization: `Bearer ${config.assistant.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.assistant.model,
        temperature: 0.4,
        max_tokens: 220,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Assistant model returned ${response.status}`);
    const result = await response.json() as { choices?: { message?: { content?: unknown } }[] };
    const answer = result.choices?.[0]?.message?.content;
    return typeof answer === 'string' && answer.trim() ? answer.trim() : null;
  } catch (error) {
    console.warn('[v2 ai] refine-comment model unavailable; using rule-based polish.', error);
    return null;
  }
}

export async function aiV2Routes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefineCommentRequest }>(
    '/ai/refine-comment',
    { preHandler: [app.authenticate, requireStaff(app)] },
    async (request, reply) => {
      const actor = await getActor(request);
      const body = (request.body ?? {}) as Partial<RefineCommentRequest>;
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text.length > 2000) return reply.code(400).send({ error: 'Please keep the comment under 2000 characters.' });
      const markNum = body.mark === null || body.mark === undefined ? null : Number(body.mark);
      const mark = markNum !== null && Number.isInteger(markNum) && markNum >= 1 && markNum <= 10 ? markNum : null;
      const studentName = typeof body.studentName === 'string' && body.studentName.trim() ? body.studentName.trim().slice(0, 80) : null;
      const tone = body.tone === 'concise' || body.tone === 'detailed' ? body.tone : 'warm';
      const language = body.language === 'ur' || body.language === 'ar' ? body.language : 'en';
      const bands = normaliseBands((await getEffectivePolicies(actor.branchId ?? null))['assessment.bands']);
      const band = mark !== null ? bandForMark(mark, bands) : null;

      if (text) {
        const prompt = buildRefinePrompt({ text, studentName, mark, band, tone, language });
        const answer = await askModel(prompt.system, prompt.user);
        const refined = answer ? tidyAiComment(answer, 3) : '';
        if (refined) return { refined, usedAi: true } satisfies RefineCommentResponse;
      }
      return { refined: polishComment(text, { studentName, mark, bands }), usedAi: false } satisfies RefineCommentResponse;
    },
  );
}
