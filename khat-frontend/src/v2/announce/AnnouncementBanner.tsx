import { useEffect, useState } from 'react';
import { ClipboardList, Megaphone, X } from 'lucide-react';
import { apiFetch, getSessionUser } from '@/api';
import type { ActiveAnnouncement } from './commsTypes';
import './v3-comms.css';

// owner: admin-comms (v3 note 6.20) — shown once per announcement when someone opens the site.
// "Got it" hides it for good; "Later" (surveys) hides it until the next visit.
// v3 audit 17: each one shows at most ONCE per visit (session), as a slim strip at the bottom unless
// the admin chose "Pop-up". Tapping the strip opens the full message / survey.

const LATER_KEY = 'khat.v3.announce.later';
const SHOWN_KEY = 'khat.v3.announce.shown';
const readSet = (key: string) => { try { return new Set<string>(JSON.parse(sessionStorage.getItem(key) ?? '[]')); } catch { return new Set<string>(); } };

export function V2AnnouncementBanner() {
  const [items, setItems] = useState<ActiveAnnouncement[]>([]);
  const [answering, setAnswering] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [thanks, setThanks] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const userId = getSessionUser()?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    const later = readSet(LATER_KEY);
    const shown = readSet(SHOWN_KEY);
    apiFetch<ActiveAnnouncement[]>('/v2/announcements/active', { silent: true })
      .then(list => { if (alive) setItems(list.filter(a => !later.has(a.id) && !shown.has(a.id))); })
      .catch(() => {});
    return () => { alive = false; };
  }, [userId]);

  const current = items[0];
  // Remember it was shown in this visit, so a reload or another page does not show it again.
  useEffect(() => {
    if (!current) return;
    const shown = readSet(SHOWN_KEY);
    if (!shown.has(current.id)) { shown.add(current.id); sessionStorage.setItem(SHOWN_KEY, JSON.stringify([...shown])); }
  }, [current]);
  if (!current && !thanks) return null;

  const next = () => { setItems(list => list.slice(1)); setAnswering(false); setAnswers({}); setError(null); setExpanded(false); };
  const gotIt = () => {
    if (current) void apiFetch(`/v2/announcements/${current.id}/seen`, { method: 'POST', body: {}, silent: true }).catch(() => {});
    next();
  };
  const later = () => {
    if (!current) return;
    const set = new Set<string>(JSON.parse(sessionStorage.getItem(LATER_KEY) ?? '[]'));
    set.add(current.id);
    sessionStorage.setItem(LATER_KEY, JSON.stringify([...set]));
    next();
  };
  const submit = async () => {
    if (!current) return;
    setBusy(true); setError(null);
    try {
      await apiFetch(`/v2/surveys/${current.id}/responses`, { method: 'POST', body: { answers }, silent: true });
      next();
      setThanks(true);
      window.setTimeout(() => setThanks(false), 3500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send your answers.');
    } finally { setBusy(false); }
  };

  if (!current && thanks) {
    return (
      <div className="v3-banner-wrap" role="status">
        <div className="v3-banner is-survey"><div className="v3-banner-top"><ClipboardList size={20} /><div><h2>Shukran — your answers were sent.</h2></div></div></div>
      </div>
    );
  }
  if (!current) return null;
  const isSurvey = current.kind === 'survey';
  const popup = current.siteStyle === 'popup';
  if (!popup && !expanded) {
    return (
      <div className="v3-banner-wrap is-slim">
        <section className={`v3-slim${isSurvey ? ' is-survey' : ''}`} aria-label={current.title}>
          {isSurvey ? <ClipboardList size={17} aria-hidden="true" /> : <Megaphone size={17} aria-hidden="true" />}
          <button type="button" className="v3-slim-text" onClick={() => { setExpanded(true); if (isSurvey) setAnswering(true); }}>
            <b>{current.title}</b><span dir="auto">{current.body}</span>
          </button>
          <button type="button" className="btn btn-outline v3-slim-btn" onClick={() => { setExpanded(true); if (isSurvey) setAnswering(true); }}>{isSurvey ? 'Answer' : 'Read'}</button>
          <button type="button" className="v3-banner-x" aria-label={isSurvey ? 'Later' : 'Close'} onClick={isSurvey ? later : gotIt}><X size={17} /></button>
        </section>
      </div>
    );
  }
  return (
    <div className={`v3-banner-wrap${popup ? ' is-popup' : ''}`}>
      <section className={`v3-banner${isSurvey ? ' is-survey' : ''}`} role="dialog" aria-label={current.title}>
        <div className="v3-banner-top">
          {isSurvey ? <ClipboardList size={20} /> : <Megaphone size={20} />}
          <div>
            <span className="v3-banner-kicker">{isSurvey ? 'A short survey' : 'Announcement'} · Funun al-Quran{current.branchName ? ` · ${current.branchName}` : ''}</span>
            <h2>{current.title}</h2>
          </div>
          <button type="button" className="v3-banner-x" aria-label="Close" onClick={isSurvey ? later : gotIt}><X size={18} /></button>
        </div>
        <p dir="auto">{current.body}</p>
        {isSurvey && answering && current.questions.map(q => (
          <div key={q.id} className="v3-survey-q">
            <b>{q.text}{q.required === false && <span className="v3-muted"> (optional)</span>}</b>
            {q.type === 'choice' && (
              <div className="v3-pick" role="radiogroup" aria-label={q.text}>
                {(q.options ?? []).map(o => <button key={o} type="button" role="radio" aria-checked={answers[q.id] === o} className={answers[q.id] === o ? 'on' : ''} onClick={() => setAnswers(a => ({ ...a, [q.id]: o }))}>{o}</button>)}
              </div>
            )}
            {q.type === 'rating' && (
              <div className="v3-pick" role="radiogroup" aria-label={q.text}>
                {[1, 2, 3, 4, 5].map(n => <button key={n} type="button" role="radio" aria-checked={answers[q.id] === n} aria-label={`${n} of 5`} className={answers[q.id] === n ? 'on' : ''} onClick={() => setAnswers(a => ({ ...a, [q.id]: n }))}>{'★'.repeat(n)}</button>)}
              </div>
            )}
            {q.type === 'text' && <textarea className="field" dir="auto" rows={2} value={String(answers[q.id] ?? '')} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))} />}
          </div>
        ))}
        {error && <p className="v2-error" role="alert">{error}</p>}
        <div className="v3-banner-actions">
          {isSurvey && !answering && <><button type="button" className="btn btn-outline" onClick={later}>Later</button><button type="button" className="btn btn-primary" onClick={() => setAnswering(true)}>Answer now</button></>}
          {isSurvey && answering && <><button type="button" className="btn btn-outline" onClick={later}>Later</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Sending…' : 'Send'}</button></>}
          {!isSurvey && <button type="button" className="btn btn-primary" onClick={gotIt}>Got it</button>}
        </div>
      </section>
    </div>
  );
}
