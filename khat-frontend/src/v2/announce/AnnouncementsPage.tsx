import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3, CheckCircle2, Download, Globe2, Mail, Megaphone, MonitorSmartphone, Pencil, Plus, RotateCcw, Send, Trash2, Upload, Users, X,
  ClipboardList, ListChecks, Search,
} from 'lucide-react';
import { apiFetch } from '@/api';
import { readV2Param } from '../nav';
import {
  ConfirmDialog, Dialog, ErrorBox, Loading, PageHead, ToastHost, errorText, formatDate, loadBranches, loadScope, plural, toast, useLoad,
  type Branch,
} from '../admin/shared';
import type {
  Announcement, AnnouncementInput, AnnouncementKind, AudiencePreview, EmailQueueStatus, EmailTemplateRow, RosterImportResult, RosterRow,
  RosterSummary, SurveyQuestion, SurveyResults,
} from './commsTypes';
import { downloadFromApi, fileToBase64 } from './commsShared';
import './v3-comms.css';

// owner: admin-comms (v3 notes 1.11, 4.8, 6.20) — route v2-announcements.
type Props = Record<string, never>;
type Tab = 'announcements' | 'surveys' | 'templates' | 'roster';

const TABS: { id: Tab; label: string; icon: typeof Megaphone }[] = [
  { id: 'announcements', label: 'Announcements', icon: Megaphone },
  { id: 'surveys', label: 'Surveys', icon: ClipboardList },
  { id: 'templates', label: 'Email templates', icon: Mail },
  { id: 'roster', label: 'Student list', icon: Users },
];

export function V2AnnouncementsPage(_props: Props) {
  const [tab, setTab] = useState<Tab>(() => (readV2Param('announceTab') as Tab) || 'announcements');
  const scope = useLoad(async () => {
    const [s, b] = await Promise.all([loadScope(), loadBranches()]);
    return { isMaster: s.scope.isMaster, homeBranchId: s.scope.homeBranchId, branches: b };
  });
  return (
    <div className="page portal-page v2-admin v3-page">
      <PageHead
        eyebrow="Funun al-Quran"
        title="Announcements & surveys"
        text="Tell your branch what is happening. Show it on the site when people open it, send it by email, or both — to registered students or to every student on the branch list. Teachers get it too."
      />
      <div className="v2-tabs" role="tablist" aria-label="Sections">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={e => { setTab(t.id); e.currentTarget.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }); }}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      {scope.error && <ErrorBox message={scope.error} onRetry={() => void scope.reload()} />}
      {!scope.data && !scope.error && <Loading label="Loading…" />}
      {scope.data && (tab === 'announcements' || tab === 'surveys') && <AnnouncementList key={tab} kind={tab === 'surveys' ? 'survey' : 'announcement'} {...scope.data} />}
      {scope.data && tab === 'templates' && <TemplatesTab isMaster={scope.data.isMaster} />}
      {scope.data && tab === 'roster' && <RosterTab {...scope.data} />}
      <ToastHost />
    </div>
  );
}

type ScopeData = { isMaster: boolean; homeBranchId: string | null; branches: Branch[] };

/* ================================================================== announcements & surveys */
function AnnouncementList({ kind, isMaster, homeBranchId, branches }: { kind: AnnouncementKind } & ScopeData) {
  const list = useLoad(() => apiFetch<Announcement[]>(`/v2/announcements?kind=${kind}`), [kind]);
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null);
  const [results, setResults] = useState<Announcement | null>(null);
  const [confirm, setConfirm] = useState<{ a: Announcement; action: 'publish' | 'close' | 'delete' } | null>(null);
  const word = kind === 'survey' ? 'survey' : 'announcement';

  const act = async (a: Announcement, action: 'publish' | 'close' | 'delete') => {
    try {
      if (action === 'delete') {
        await apiFetch(`/v2/announcements/${a.id}`, { method: 'DELETE' });
        toast('Draft deleted.');
      } else if (action === 'close') {
        await apiFetch(`/v2/announcements/${a.id}/close`, { method: 'POST', body: {} });
        toast(`The ${word} is closed and no longer shown.`);
      } else {
        const res = await apiFetch<{ emailsQueued: number }>(`/v2/announcements/${a.id}/publish`, { method: 'POST', body: {} });
        toast(a.sendEmail ? `Sent. ${plural(res.emailsQueued, 'email')} on the way — they go out a few at a time.` : 'Sent. People see it when they open the site.');
      }
      await list.reload(true);
    } catch (err) { toast(errorText(err), { tone: 'error' }); }
  };

  const items = list.data ?? [];
  return (
    <>
      <div className="v3-toolbar">
        <p className="v3-muted v3-small">{kind === 'survey' ? 'Ask a few short questions. Answers are collected here.' : 'News, reminders, competitions, events — anything the branch should know.'}</p>
        <span className="v2-grow" />
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> New {word}</button>
      </div>
      {list.error && <ErrorBox message={list.error} onRetry={() => void list.reload()} />}
      {list.loading && !list.data && <Loading label="Loading…" />}
      {list.data && !items.length && (
        <div className="v3-empty"><strong>No {word}s yet</strong>Press “New {word}” to write the first one.</div>
      )}
      <div className="v3-ann-list">
        {items.map(a => (
          <article key={a.id} className={`v3-ann is-${a.status}`}>
            <div>
              <h3>{a.title}</h3>
              <p>{a.body}</p>
              <div className="v3-ann-meta">
                <span className={`v3-chip is-${a.status === 'published' ? 'live' : a.status}`}>{a.status === 'published' ? 'Live' : a.status === 'draft' ? 'Draft' : 'Closed'}</span>
                <span className="v3-chip">{a.branchName ?? 'All branches'}</span>
                {a.showOnSite && <span className="v3-chip"><MonitorSmartphone size={12} /> On the site</span>}
                {a.sendEmail && <span className="v3-chip"><Mail size={12} /> Email</span>}
                <span className="v3-chip"><Users size={12} /> {a.audience === 'roster' ? 'All branch students' : 'Registered students'}{a.includeTeachers ? ' + teachers' : ''}</span>
              </div>
              {a.status !== 'draft' && (
                <div className="v3-ann-stats">
                  <span>Sent {formatDate(a.publishedAt, true)}</span>
                  {a.sendEmail && <span><b>{a.emailsQueued}</b>emails</span>}
                  {a.showOnSite && <span><b>{a.seenCount}</b>seen on the site</span>}
                  {a.kind === 'survey' && <span><b>{a.responseCount}</b>answers</span>}
                </div>
              )}
            </div>
            <div className="v3-ann-actions">
              {a.kind === 'survey' && a.status !== 'draft' && <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => setResults(a)}><BarChart3 size={14} /> Answers</button>}
              {a.canEdit && a.status === 'draft' && <>
                <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => setEditing(a)}><Pencil size={14} /> Edit</button>
                <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => setConfirm({ a, action: 'delete' })}><Trash2 size={14} /> Delete</button>
                <button type="button" className="btn btn-primary v2-btn-sm" onClick={() => setConfirm({ a, action: 'publish' })}><Send size={14} /> Send</button>
              </>}
              {a.canEdit && a.status === 'published' && <>
                <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => setEditing(a)}><Pencil size={14} /> Edit words</button>
                <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => setConfirm({ a, action: 'close' })}><X size={14} /> Close</button>
              </>}
            </div>
          </article>
        ))}
      </div>

      {editing && (
        <AnnouncementEditor
          kind={kind} item={editing === 'new' ? null : editing} isMaster={isMaster} homeBranchId={homeBranchId} branches={branches}
          onClose={() => setEditing(null)}
          onSaved={async (saved, sendNow) => {
            setEditing(null);
            if (sendNow) await act(saved, 'publish');
            else { toast(saved.status === 'draft' ? 'Saved as a draft.' : 'Saved.'); await list.reload(true); }
          }}
        />
      )}
      {results && <ResultsDialog item={results} onClose={() => setResults(null)} />}
      {confirm && (
        <ConfirmDialog
          title={confirm.action === 'publish' ? `Send this ${word}?` : confirm.action === 'close' ? `Close this ${word}?` : 'Delete this draft?'}
          confirmLabel={confirm.action === 'publish' ? 'Yes, send it' : confirm.action === 'close' ? 'Close it' : 'Delete'}
          danger={confirm.action === 'delete'}
          onClose={() => setConfirm(null)}
          onConfirm={() => act(confirm.a, confirm.action)}
          text={confirm.action === 'publish'
            ? <>“{confirm.a.title}” goes to {confirm.a.branchName ?? 'every branch'}{confirm.a.showOnSite ? ' — shown when people open the site' : ''}{confirm.a.sendEmail ? `${confirm.a.showOnSite ? ' and' : ' —'} emailed` : ''}. Emails go out a few at a time (about 95 a day).</>
            : confirm.action === 'close' ? <>It will no longer be shown on the site{confirm.a.kind === 'survey' ? ' and no more answers are taken' : ''}. Everything already collected is kept.</>
              : <>The draft “{confirm.a.title}” will be removed.</>}
        />
      )}
    </>
  );
}

const newQuestion = (n: number): SurveyQuestion => ({ id: `q${n}`, text: '', type: 'choice', options: ['', ''], required: true });

function AnnouncementEditor({ kind, item, isMaster, homeBranchId, branches, onClose, onSaved }: {
  kind: AnnouncementKind; item: Announcement | null; onClose: () => void; onSaved: (a: Announcement, sendNow: boolean) => void;
} & ScopeData) {
  const sent = item ? item.status !== 'draft' : false;
  const [title, setTitle] = useState(item?.title ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [branchId, setBranchId] = useState<string>(item ? item.branchId ?? '' : isMaster ? '' : homeBranchId ?? '');
  const [showOnSite, setShowOnSite] = useState(item?.showOnSite ?? true);
  const [sendEmail, setSendEmail] = useState(item?.sendEmail ?? false);
  const [siteStyle, setSiteStyle] = useState<'banner' | 'popup'>(item?.siteStyle ?? 'banner');
  const [audience, setAudience] = useState(item?.audience ?? 'registered');
  const [includeTeachers, setIncludeTeachers] = useState(item?.includeTeachers ?? true);
  const [endsAt, setEndsAt] = useState(item?.endsAt ? item.endsAt.slice(0, 10) : '');
  const [questions, setQuestions] = useState<SurveyQuestion[]>(item?.questions?.length ? item.questions : kind === 'survey' ? [newQuestion(1)] : []);
  const [reach, setReach] = useState<AudiencePreview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ audience, includeTeachers: includeTeachers ? '1' : '0', ...(branchId ? { branchId } : {}) });
    apiFetch<AudiencePreview>(`/v2/announcements/audience?${q}`, { silent: true }).then(r => { if (alive) setReach(r); }).catch(() => { if (alive) setReach(null); });
    return () => { alive = false; };
  }, [branchId, audience, includeTeachers]);

  const setQ = (i: number, patch: Partial<SurveyQuestion>) => setQuestions(qs => qs.map((q, n) => (n === i ? { ...q, ...patch } : q)));
  const save = async (sendNow: boolean) => {
    const input: AnnouncementInput = {
      title, body, showOnSite, siteStyle, sendEmail, endsAt: endsAt ? new Date(`${endsAt}T23:59:00`).toISOString() : null,
      ...(sent ? {} : { kind, audience, includeTeachers, branchId: branchId || null, questions: kind === 'survey' ? questions.map(q => ({ ...q, options: q.type === 'choice' ? (q.options ?? []).filter(o => o.trim()) : undefined })) : [] }),
    };
    setBusy(true);
    try {
      const saved = item
        ? await apiFetch<Announcement>(`/v2/announcements/${item.id}`, { method: 'PATCH', body: input })
        : await apiFetch<Announcement>('/v2/announcements', { method: 'POST', body: input });
      onSaved(saved, sendNow);
    } catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusy(false); }
  };
  const word = kind === 'survey' ? 'survey' : 'announcement';

  return (
    <Dialog
      wide
      title={item ? (sent ? 'Edit the words' : `Edit ${word}`) : `New ${word}`}
      eyebrow={sent ? 'Already sent — the emails are not sent again' : 'Nothing is sent until you press Send'}
      onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
        {!sent && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void save(false)}>Save draft</button>}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save(!sent)}>{busy ? 'Working…' : sent ? 'Save' : <><Send size={15} /> Send now</>}</button>
      </>}
    >
      <div className="v3-grid">
        <label className="field-label">Title<input className="field" value={title} maxLength={200} placeholder={kind === 'survey' ? 'e.g. Which day suits the extra class?' : 'e.g. Calligraphy exhibition on Thursday'} onChange={e => setTitle(e.target.value)} /></label>
        <label className="field-label">{kind === 'survey' ? 'A short note above the questions' : 'Message'}
          <textarea className="field v2-textarea" dir="auto" rows={4} value={body} onChange={e => setBody(e.target.value)} placeholder="Write it as you would say it — warm and simple." />
        </label>

        {kind === 'survey' && (
          <div className="v3-grid">
            <span className="v3-label">Questions</span>
            {questions.map((q, i) => (
              <div key={i} className="v3-q">
                <div className="v3-q-head">
                  <span className="v3-q-num">{i + 1}.</span>
                  <input className="field" value={q.text} disabled={sent} placeholder="Question" aria-label={`Question ${i + 1}`} onChange={e => setQ(i, { text: e.target.value })} />
                  {!sent && questions.length > 1 && <button type="button" className="v2-icon-btn" aria-label="Remove question" onClick={() => setQuestions(qs => qs.filter((_, n) => n !== i))}><Trash2 size={15} /></button>}
                </div>
                <div className="v3-pick" role="radiogroup" aria-label="Answer type">
                  {([['choice', 'Pick one'], ['rating', 'Stars 1–5'], ['text', 'Own words']] as const).map(([t, l]) => (
                    <button key={t} type="button" disabled={sent} className={q.type === t ? 'on' : ''} aria-pressed={q.type === t} onClick={() => setQ(i, { type: t, options: t === 'choice' ? (q.options?.length ? q.options : ['', '']) : undefined })}>{l}</button>
                  ))}
                </div>
                {q.type === 'choice' && (
                  <div className="v3-q-options">
                    {(q.options ?? []).map((o, k) => (
                      <div key={k} className="v3-q-option">
                        <input className="field" value={o} disabled={sent} placeholder={`Choice ${k + 1}`} aria-label={`Choice ${k + 1}`} onChange={e => setQ(i, { options: (q.options ?? []).map((x, m) => (m === k ? e.target.value : x)) })} />
                        {!sent && (q.options?.length ?? 0) > 2 && <button type="button" className="v2-icon-btn" aria-label="Remove choice" onClick={() => setQ(i, { options: (q.options ?? []).filter((_, m) => m !== k) })}><X size={14} /></button>}
                      </div>
                    ))}
                    {!sent && (q.options?.length ?? 0) < 10 && <button type="button" className="v2-link" onClick={() => setQ(i, { options: [...(q.options ?? []), ''] })}><Plus size={13} /> Add a choice</button>}
                  </div>
                )}
                {q.type === 'text' && (
                  <label className="v3-person-coord"><input type="checkbox" disabled={sent} checked={q.required === false} onChange={e => setQ(i, { required: !e.target.checked })} /> They may leave this empty</label>
                )}
              </div>
            ))}
            {!sent && questions.length < 20 && <button type="button" className="v2-link" onClick={() => setQuestions(qs => [...qs, newQuestion(qs.length + 1)])}><Plus size={14} /> Add a question</button>}
          </div>
        )}

        <div>
          <span className="v3-label">How should it reach people?</span>
          <div className="v3-field-row">
            <label className={`v3-check${showOnSite ? ' on' : ''}`}><input type="checkbox" checked={showOnSite} onChange={e => setShowOnSite(e.target.checked)} /><span><b><MonitorSmartphone size={14} /> Show on the site</b><small>Shown once per visit when they open Tehseen al-Khat, until they press “Got it”{kind === 'survey' ? ' or answer' : ''}.</small></span></label>
            <label className={`v3-check${sendEmail ? ' on' : ''}`}><input type="checkbox" checked={sendEmail} disabled={sent} onChange={e => setSendEmail(e.target.checked)} /><span><b><Mail size={14} /> Send by email</b><small>Uses the “{kind === 'survey' ? 'Survey' : 'Announcement'}” email template.</small></span></label>
          </div>
          {showOnSite && (
            <div className="v3-style-pick" role="radiogroup" aria-label="How it looks on the site">
              <button type="button" role="radio" aria-checked={siteStyle === 'banner'} className={siteStyle === 'banner' ? 'on' : ''} onClick={() => setSiteStyle('banner')}><b>Slim banner</b><small>A thin strip at the bottom — does not block the page (recommended)</small></button>
              <button type="button" role="radio" aria-checked={siteStyle === 'popup'} className={siteStyle === 'popup' ? 'on' : ''} onClick={() => setSiteStyle('popup')}><b>Pop-up</b><small>A box in the middle of the screen — for something important</small></button>
            </div>
          )}
        </div>

        {!sent && (
          <div>
            <span className="v3-label">Who should get it?</span>
            {isMaster && (
              <select className="field" value={branchId} onChange={e => setBranchId(e.target.value)} aria-label="Branch" style={{ marginBottom: 10 }}>
                <option value="">Every branch</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            )}
            <div className="v3-field-row">
              <label className={`v3-check${audience === 'registered' ? ' on' : ''}`}><input type="radio" name="aud" checked={audience === 'registered'} onChange={() => setAudience('registered')} /><span><b>Registered students</b><small>Everyone with an account on the site.</small></span></label>
              <label className={`v3-check${audience === 'roster' ? ' on' : ''}`}><input type="radio" name="aud" checked={audience === 'roster'} onChange={() => setAudience('roster')} /><span><b>All branch students</b><small>Also students on the branch list who have not signed up yet (by email).</small></span></label>
            </div>
            <label className={`v3-check${includeTeachers ? ' on' : ''}`} style={{ marginTop: 10 }}><input type="checkbox" checked={includeTeachers} onChange={e => setIncludeTeachers(e.target.checked)} /><span><b>Teachers of the branch get it too</b><small>So they know what is happening in the branch.</small></span></label>
          </div>
        )}

        {!sent && reach && (
          <p className="v3-reach"><Globe2 size={15} />
            Reaches {plural(reach.students, 'student')}{reach.notRegistered ? ` (${reach.notRegistered} not signed up)` : ''}{includeTeachers ? ` and ${plural(reach.teachers, 'teacher')}` : ''}.
            {sendEmail && <> {plural(reach.withEmail, 'email')}{reach.withoutEmail ? ` · ${reach.withoutEmail} without an email address` : ''}.</>}
          </p>
        )}
        <label className="field-label">Stop showing it after <span className="v2-optional">optional</span>
          <input className="field" type="date" value={endsAt} onChange={e => setEndsAt(e.target.value)} />
        </label>
      </div>
    </Dialog>
  );
}

function ResultsDialog({ item, onClose }: { item: Announcement; onClose: () => void }) {
  const res = useLoad(() => apiFetch<SurveyResults>(`/v2/surveys/${item.id}/results`), [item.id]);
  return (
    <Dialog wide title={item.title} eyebrow="Survey answers" onClose={onClose} footer={<button type="button" className="btn btn-outline" onClick={onClose}>Close</button>}>
      {res.loading && <Loading label="Counting answers…" />}
      {res.error && <ErrorBox message={res.error} />}
      {res.data && (
        <>
          <p className="v3-reach"><ListChecks size={15} /> {plural(res.data.total, 'person has', 'people have')} answered.</p>
          {res.data.questions.map(q => {
            const max = Math.max(1, ...q.counts.map(c => c.n));
            return (
              <div key={q.id} className="v3-result">
                <h4>{q.text}{q.average !== null && <span className="v3-muted"> · average {q.average} of 5</span>}</h4>
                {q.type !== 'text' && q.counts.map(c => (
                  <div key={c.option} className="v3cm-bar-row">
                    <span>{q.type === 'rating' ? `${'★'.repeat(Number(c.option))}` : c.option}</span>
                    <span className="v3cm-bar"><i style={{ width: `${(c.n / max) * 100}%` }} /></span>
                    <b>{c.n}</b>
                  </div>
                ))}
                {q.type === 'text' && (q.answers.length ? q.answers.map((a, i) => <div key={i} className="v3-answer">{a.text}<small>{a.name}</small></div>) : <p className="v3-muted v3-small">No written answers yet.</p>)}
              </div>
            );
          })}
        </>
      )}
    </Dialog>
  );
}

/* ================================================================== email templates */
const fill = (text: string, vars: Record<string, string>) => text.replace(/\{([a-zA-Z_]+)\}/g, (_, k: string) => vars[k] ?? '').replace(/\n{3,}/g, '\n\n').trim();
const SAMPLE: Record<string, string> = {
  name: 'Fatema', course: 'Naskh — Al-Usloob al-Awwal', step: 'Level 1 · Step 3', mark: '8', band: 'pass',
  comment: '"Your alif is standing straight now — keep the same care with the nuqta."', teacher: 'Ustad Ali Hakimuddin',
  title: 'Calligraphy exhibition on Thursday', message: 'Salaam! The exhibition opens on Thursday after Maghrib in the Funun al-Quran hall. Please bring one framed piece.',
  branch: 'Nairobi', kind: 'Certification course', link: 'https://tehseen.example/#dashboard',
};
const VAR_WORDS: Record<string, string> = {
  name: 'first name', course: 'course', step: 'level & step', mark: 'mark', band: 'band', comment: 'teacher’s words', teacher: 'teacher’s name',
  title: 'title', message: 'message', branch: 'branch', kind: 'course kind', link: 'link to the site',
};

function TemplatesTab({ isMaster }: { isMaster: boolean }) {
  const list = useLoad(() => apiFetch<EmailTemplateRow[]>('/v2/email-templates'));
  const queue = useLoad(() => apiFetch<EmailQueueStatus>('/v2/email-queue'));
  const [key, setKey] = useState<string | null>(null);
  const current = list.data?.find(t => t.key === key) ?? list.data?.[0] ?? null;
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (current) { setSubject(current.subject); setBody(current.body); } }, [current?.key, current?.subject, current?.body]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = Boolean(current && (subject !== current.subject || body !== current.body));
  const groups = useMemo(() => {
    const g = new Map<string, EmailTemplateRow[]>();
    (list.data ?? []).forEach(t => g.set(t.group, [...(g.get(t.group) ?? []), t]));
    return [...g.entries()];
  }, [list.data]);

  const insert = (token: string) => {
    const el = bodyRef.current;
    if (!el) { setBody(b => b + token); return; }
    const s = el.selectionStart; const e = el.selectionEnd;
    setBody(b => b.slice(0, s) + token + b.slice(e));
    window.requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = s + token.length; });
  };
  const save = async () => {
    if (!current) return;
    setBusy(true);
    try { await apiFetch(`/v2/email-templates/${current.key}`, { method: 'PUT', body: { subject, body } }); toast(`“${current.label}” email saved.`); await list.reload(true); }
    catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!current) return;
    try { await apiFetch(`/v2/email-templates/${current.key}`, { method: 'DELETE' }); toast('Back to the standard wording.'); await list.reload(true); }
    catch (err) { toast(errorText(err), { tone: 'error' }); }
  };
  const test = async () => {
    if (!current) return;
    try { const r = await apiFetch<{ to: string }>(`/v2/email-templates/${current.key}/test`, { method: 'POST', body: {} }); toast(`A test email is on its way to ${r.to}.`); void queue.reload(true); }
    catch (err) { toast(errorText(err), { tone: 'error' }); }
  };

  return (
    <>
      {list.error && <ErrorBox message={list.error} onRetry={() => void list.reload()} />}
      {list.loading && !list.data && <Loading label="Loading emails…" />}
      {current && (
        <div className="v3-tpl">
          <nav className="v3-tpl-nav" aria-label="Emails">
            {groups.map(([g, items]) => (
              <div key={g} style={{ display: 'contents' }}>
                <h4>{g === 'Everyone' ? 'Announcements & news' : g === 'Staff' ? 'For staff' : 'For students'}</h4>
                {items.map(t => (
                  <button key={t.key} type="button" className={t.key === current.key ? 'active' : ''} aria-current={t.key === current.key} onClick={() => { if (!dirty || window.confirm('Leave without saving your changes?')) setKey(t.key); }}>
                    <span>{t.label}</span>{t.isCustom && <i>edited</i>}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <section className="v3-tpl-edit" aria-label={`${current.label} email`}>
            <div>
              <h3 className="v3-section-title" style={{ margin: 0 }}>{current.label}</h3>
              <p className="v3-muted v3-small">{current.description}</p>
            </div>
            {!isMaster && <div className="v2-banner"><Mail size={15} /><span>The wording of emails is set by the master team. You can read it here.</span></div>}
            <label className="field-label">Subject<input className="field" value={subject} disabled={!isMaster} onChange={e => setSubject(e.target.value)} /></label>
            <label className="field-label">Email<textarea ref={bodyRef} className="field" dir="auto" rows={11} value={body} disabled={!isMaster} onChange={e => setBody(e.target.value)} /></label>
            {isMaster && (
              <div className="v3-tokens"><span className="v3-muted">Insert:</span>
                {current.vars.map(v => <button key={v} type="button" title={VAR_WORDS[v] ?? v} onClick={() => insert(`{${v}}`)}>{`{${v}}`} <span className="v3-muted">{VAR_WORDS[v] ?? ''}</span></button>)}
              </div>
            )}
            <div className="v3-mail" aria-label="Preview">
              <div className="v3-mail-top"><span className="v3-muted">Preview · Subject: </span><b>{fill(subject, SAMPLE) || '—'}</b></div>
              <div className="v3-mail-body">{fill(body, SAMPLE)}{'\n\n'}— Funun al-Quran · Tehseen al-Khat{'\n'}Al-Jamea-tus-Saifiyah</div>
            </div>
            <div className="v3-toolbar" style={{ margin: 0 }}>
              {isMaster && current.isCustom && !dirty && <button type="button" className="v2-link" onClick={() => void reset()}><RotateCcw size={13} /> Back to the standard wording</button>}
              <span className="v2-grow" />
              <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => void test()} disabled={dirty}><Send size={14} /> Send me a test</button>
              {isMaster && dirty && <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => { setSubject(current.subject); setBody(current.body); }}>Undo</button>}
              {isMaster && <button type="button" className="btn btn-primary v2-btn-sm" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>}
            </div>
          </section>
        </div>
      )}

      <h3 className="v3-section-title">Sending</h3>
      <p className="v3-muted v3-small" style={{ marginTop: -4, marginBottom: 10 }}>Emails wait in a queue and go out a few at a time, at most {queue.data?.dailyCap ?? 95} a day (the free email plan). Marks and replies go first; nothing is lost — what does not fit today goes tomorrow.</p>
      {queue.data && (
        <>
          <div className="v3-sending">
            <div className="v3-stat"><strong>{queue.data.sentLast24h}</strong><span>sent in the last 24 hours</span></div>
            <div className="v3-stat"><strong>{Math.max(0, queue.data.dailyCap - queue.data.sentLast24h)}</strong><span>can still go today</span></div>
            <div className="v3-stat"><strong>{queue.data.waiting}</strong><span>waiting</span></div>
            <div className="v3-stat"><strong>{queue.data.failed}</strong><span>could not be sent</span></div>
          </div>
          {queue.data.recent.length > 0 && (
            <div className="v3-card v3-log">
              {queue.data.recent.slice(0, 12).map(r => (
                <div key={r.id} className="v3-log-row">
                  <span className={`v3-chip ${r.status === 'sent' ? 'is-live' : r.status === 'queued' ? 'is-draft' : ''}`}>{r.status === 'sent' ? 'Sent' : r.status === 'queued' ? 'Waiting' : 'Not sent'}</span>
                  <span title={r.to}>{r.to}</span>
                  <span title={r.lastError ?? r.subject}>{r.subject}</span>
                  <span className="v3-muted">{formatDate(r.sentAt ?? r.createdAt, true)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

/* ================================================================== student list (JHS) */
function RosterTab({ isMaster, homeBranchId, branches }: ScopeData) {
  const [branchId, setBranchId] = useState<string>(isMaster ? '' : homeBranchId ?? '');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const summary = useLoad(() => apiFetch<RosterSummary>('/v2/roster/summary'));
  const rows = useLoad(() => apiFetch<{ rows: RosterRow[]; total: number }>(`/v2/roster?limit=200${branchId ? `&branchId=${encodeURIComponent(branchId)}` : ''}${query ? `&q=${encodeURIComponent(query)}` : ''}`), [branchId, query]);
  const [importBranch, setImportBranch] = useState<string>(isMaster ? '' : homeBranchId ?? '');
  const [result, setResult] = useState<RosterImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setQuery(q.trim()), 300); return () => window.clearTimeout(t); }, [q]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setResult(null);
    try {
      const isExcel = /\.xlsx$/i.test(file.name);
      if (!isExcel && !/\.(csv|txt)$/i.test(file.name)) throw new Error('Please choose an Excel (.xlsx) or CSV file. Old .xls files: open in Excel and “Save as” .xlsx first.');
      const body = isExcel ? { xlsxBase64: await fileToBase64(file) } : { csvText: await file.text() };
      const res = await apiFetch<RosterImportResult>('/v2/roster/import', { method: 'POST', body: { ...body, branchId: importBranch || null, fileName: file.name } });
      setResult(res);
      if (res.total === 0) toast(res.skipped[0]?.reason ?? 'No students were found in this file.', { tone: 'error' });
      else toast(`Student list updated: ${res.added} new, ${res.updated} changed.`);
      await Promise.all([summary.reload(true), rows.reload(true)]);
    } catch (err) {
      toast(errorText(err, 'Could not read this file.'), { tone: 'error' });
    } finally { setBusy(false); }
  };
  const remove = async (r: RosterRow) => {
    try { await apiFetch(`/v2/roster/${r.id}`, { method: 'DELETE' }); toast(`${r.name} removed from the list.`); await Promise.all([summary.reload(true), rows.reload(true)]); }
    catch (err) { toast(errorText(err), { tone: 'error' }); }
  };

  return (
    <>
      <p className="v3-muted v3-small" style={{ marginBottom: 12 }}>
        The list of every student of the branch, from JHS — also those who have not signed up yet — so announcements and surveys can reach them by email.
        Upload the JHS export (Excel or CSV) with the columns <b>Name, TR, Class, Branch, Email</b>. Uploading again updates the list; nobody is added twice.
      </p>
      {summary.data && (
        <div className="v3-branch-cards">
          {isMaster && (
            <button type="button" className={`v3-branch-card${branchId === '' ? ' active' : ''}`} onClick={() => setBranchId('')}>
              <b>All branches</b>
              <span>{summary.data.branches.reduce((n, b) => n + b.total, 0)} students on the list</span>
            </button>
          )}
          {summary.data.branches.map(b => (
            <button key={b.branchId} type="button" className={`v3-branch-card${branchId === b.branchId ? ' active' : ''}`} onClick={() => { setBranchId(b.branchId); if (isMaster) setImportBranch(b.branchId); }}>
              <b>{b.branchName}</b>
              <span>{b.total ? `${b.total} students · ${b.withEmail} with email` : 'No list yet'}</span>
              {b.total > 0 && <span>{b.registered} signed up · {b.total - b.registered} not yet</span>}
            </button>
          ))}
        </div>
      )}

      <div className="v3-grid" style={{ marginBottom: 16 }}>
        {isMaster && (
          <label className="field-label">Students in the file belong to
            <select className="field" value={importBranch} onChange={e => setImportBranch(e.target.value)}>
              <option value="">The branch written in each row (Branch column)</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}
        <label className={`v3-drop${drag ? ' drag' : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files?.[0]); }}>
          <Upload size={24} />
          <span><strong>{busy ? 'Reading the file…' : 'Upload the JHS student list'}</strong><small>Excel (.xlsx) or CSV · tap to choose, or drop the file here</small></span>
          <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} aria-label="Upload the student list" />
        </label>
        <div className="v3-toolbar" style={{ margin: 0 }}>
          <button type="button" className="v2-link" onClick={() => void downloadFromApi('/v2/roster/template.csv', 'student-list-template.csv').catch(err => toast(errorText(err), { tone: 'error' }))}><Download size={13} /> Download an example file</button>
        </div>
        {result && (
          <div className="v3-result-box" role="status">
            <span><CheckCircle2 size={14} /> <b>{result.added}</b> new · <b>{result.updated}</b> changed · <b>{result.unchanged}</b> already up to date{result.skipped.length ? <> · <b>{result.skipped.length}</b> rows need a look</> : null}</span>
            {result.skipped.length > 0 && <ul>{result.skipped.slice(0, 30).map((s, i) => <li key={i}>Row {s.row}: {s.reason}</li>)}</ul>}
          </div>
        )}
      </div>

      <div className="v3-toolbar">
        <label className="v2-search" style={{ flex: 1, minWidth: 200 }}><Search size={16} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, TR, class or email" aria-label="Search the student list" /></label>
        {rows.data && <span className="v3-muted v3-small">{rows.data.total} on the list{rows.data.total > rows.data.rows.length ? ` · showing ${rows.data.rows.length}` : ''}</span>}
      </div>
      {rows.error && <ErrorBox message={rows.error} onRetry={() => void rows.reload()} />}
      {rows.data && rows.data.rows.length === 0 && <div className="v3-empty"><strong>{query ? 'Nobody found' : 'The list is empty'}</strong>{query ? 'Try another name or TR number.' : 'Upload the JHS export above.'}</div>}
      {rows.data && rows.data.rows.length > 0 && (
        <div className="v3-table-wrap">
          <table className="v3-table">
            <thead><tr><th>Name</th><th>TR</th><th className="v3-hide-sm">Class</th>{isMaster && !branchId && <th className="v3-hide-sm">Branch</th>}<th className="v3-hide-sm">Email</th><th>On the site</th><th aria-label="Remove" /></tr></thead>
            <tbody>
              {rows.data.rows.map(r => (
                <tr key={r.id}>
                  <td><b>{r.name}</b></td>
                  <td>{r.trNumber}</td>
                  <td className="v3-hide-sm">{r.className ?? '—'}</td>
                  {isMaster && !branchId && <td className="v3-hide-sm">{r.branchName}</td>}
                  <td className="v3-hide-sm">{r.email ?? <span className="v3-muted">no email</span>}</td>
                  <td>{r.registered ? <span className="v3-chip is-live">Signed up</span> : <span className="v3-chip">Not yet</span>}</td>
                  <td><button type="button" className="v2-icon-btn" aria-label={`Remove ${r.name}`} onClick={() => void remove(r)}><Trash2 size={15} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
