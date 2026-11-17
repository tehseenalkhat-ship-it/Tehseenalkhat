import { useEffect, useState } from 'react';
import { CheckCircle2, ClipboardList } from 'lucide-react';
import { apiFetch } from '@/api';
import type { SurveyQuestion } from './commsTypes';
import './v3-comms.css';

// owner: admin-comms (v3 integration) — a survey opened from the emailed link, no sign-in needed.
// Route: `#survey?t=<token>` (public in App.tsx). One answer per person; answering again replaces it.

type LinkedSurvey = {
  id: string; title: string; body: string; branchName: string | null; firstName: string | null;
  questions: SurveyQuestion[]; closed: boolean; answered: boolean; answers: Record<string, string | number> | null; endsAt: string | null;
};

function tokenFromHash(): string {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('t') ?? '';
}

export function V3SurveyByLinkPage() {
  const [token] = useState(tokenFromHash);
  const [survey, setSurvey] = useState<LinkedSurvey | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!token) { setLoadError('This survey link is not complete. Please open the link from your email again.'); return; }
    apiFetch<LinkedSurvey>(`/v2/surveys/by-link?t=${encodeURIComponent(token)}`, { auth: false, silent: true })
      .then(data => { setSurvey(data); if (data.answers) setAnswers(data.answers); })
      .catch(err => setLoadError(err instanceof Error ? err.message : 'This survey could not be opened.'));
  }, [token]);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await apiFetch('/v2/surveys/by-link', { method: 'POST', body: { t: token, answers }, auth: false, silent: true });
      setSent(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your answers could not be sent. Please try again.');
    } finally { setBusy(false); }
  };

  return (
    <main className="v3ann-link-page">
      <header className="v3ann-link-brand">
        <img src="/funun-logo-white.png" alt="" />
        <span><strong>Funun al-Quran</strong><small>Tehseen al-Khat · Al-Jamea-tus-Saifiyah</small></span>
      </header>
      <section className="v3ann-link-card" aria-live="polite">
        {!survey && !loadError && <p className="v3ann-link-muted">Opening your survey…</p>}
        {loadError && (
          <>
            <h1>We could not open this survey</h1>
            <p>{loadError}</p>
          </>
        )}
        {survey && sent && (
          <div className="v3ann-link-done">
            <CheckCircle2 size={40} aria-hidden="true" />
            <h1>Shukran{survey.firstName ? `, ${survey.firstName}` : ''}!</h1>
            <p>Your answers were sent to Funun al-Quran. You can close this page now.</p>
            <button type="button" className="btn btn-outline" onClick={() => setSent(false)}>Change my answers</button>
          </div>
        )}
        {survey && !sent && (
          <>
            <p className="v3ann-link-kicker"><ClipboardList size={16} aria-hidden="true" /> A short survey{survey.branchName ? ` · ${survey.branchName}` : ''}</p>
            <h1 dir="auto">{survey.title}</h1>
            {survey.firstName && <p className="v3ann-link-hello">Salaam {survey.firstName},</p>}
            <p dir="auto" className="v3ann-link-body">{survey.body}</p>
            {survey.closed ? (
              <p className="v3ann-link-note">This survey is closed now. Thank you all the same!</p>
            ) : (
              <>
                {survey.answered && <p className="v3ann-link-note">You have already answered — your answers are below. You can change them and send again.</p>}
                <ol className="v3ann-link-questions">
                  {survey.questions.map(q => (
                    <li key={q.id} className="v3-survey-q">
                      <b dir="auto">{q.text}{q.required === false && <span className="v3-muted"> (optional)</span>}</b>
                      {q.type === 'choice' && (
                        <div className="v3-pick" role="radiogroup" aria-label={q.text}>
                          {(q.options ?? []).map(o => <button key={o} type="button" role="radio" aria-checked={answers[q.id] === o} className={answers[q.id] === o ? 'on' : ''} onClick={() => setAnswers(a => ({ ...a, [q.id]: o }))}>{o}</button>)}
                        </div>
                      )}
                      {q.type === 'rating' && (
                        <div className="v3-pick" role="radiogroup" aria-label={q.text}>
                          {[1, 2, 3, 4, 5].map(n => <button key={n} type="button" role="radio" aria-checked={Number(answers[q.id]) === n} aria-label={`${n} of 5`} className={Number(answers[q.id]) === n ? 'on' : ''} onClick={() => setAnswers(a => ({ ...a, [q.id]: n }))}>{'★'.repeat(n)}</button>)}
                        </div>
                      )}
                      {q.type === 'text' && <textarea className="field" dir="auto" rows={3} value={String(answers[q.id] ?? '')} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))} aria-label={q.text} />}
                    </li>
                  ))}
                </ol>
                {error && <p className="v2-error" role="alert">{error}</p>}
                <button type="button" className="btn btn-primary v3ann-link-send" disabled={busy} onClick={() => void submit()}>{busy ? 'Sending…' : survey.answered ? 'Send my new answers' : 'Send my answers'}</button>
                <p className="v3ann-link-muted">No sign-in needed — this link is just for you. Please do not forward it.</p>
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}
