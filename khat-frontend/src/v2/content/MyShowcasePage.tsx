import { useEffect, useState } from 'react';
import { ArrowRight, Clock3, FileImage, Images, Trash2 } from 'lucide-react';
import { apiFetch, ApiError, uploadFile } from '@/api';
import { Button, PenLoader, UploadBox, navigate } from '@/components/ui';
import { ShowcaseImageEditor } from '@/components/ShowcaseImageEditor';
import type { ShowcaseItem } from './contentTypes';
import { cleanLabel, effortLabel, useViewUrls } from './contentShared';
import { ShowcaseFeedView } from './GalleryPage';

/** Note 4.7: calligraphy- and thought-process-centred questions; the student answers one. */
export const STUDENT_QUESTIONS = [
  'Which letter or join was hardest, and how did you fix it?',
  'What did you focus on in this piece — proportion, spacing or the flow of the pen?',
  'Which part are you proudest of, and why?',
  'What did your teacher’s comments help you change?',
  'What would you do differently next time?',
];
export const TEACHER_QUESTIONS = [
  'What should students notice in this piece?',
  'Which rule of the script does this piece show well?',
  'How did you plan the layout of this piece?',
];

const HOURS = Array.from({ length: 41 }, (_, i) => i);
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

/**
 * "My showcase" — students and teachers share finished work (note E: the two are distinct):
 * students answer a reflection question and say how long the piece took (shown as effort),
 * then a branch admin approves; teachers post straight to their branch's teacher showcase.
 */
export function V3MyShowcasePage({ mode }: { mode: 'student' | 'teacher' }) {
  const questions = mode === 'student' ? STUDENT_QUESTIONS : TEACHER_QUESTIONS;
  const [posts, setPosts] = useState<ShowcaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [question, setQuestion] = useState(questions[0]);
  const [answer, setAnswer] = useState('');
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [editing, setEditing] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeError, setTimeError] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const urls = useViewUrls(posts.map(p => p.imageStorageKey));
  const preview = useFilePreview(file);

  const load = () => apiFetch<ShowcaseItem[]>('/v2/showcase/mine')
    .then(setPosts).catch(() => setPosts([])).finally(() => setLoading(false));
  useEffect(() => { void load(); }, []);

  const total = hours * 60 + minutes;
  const submit = async () => {
    setError(null); setDone(null); setTimeError(false);
    if (!file) { setError('Please add a photo of your piece.'); return; }
    if (mode === 'student' && !answer.trim()) { setError('Please answer the question in a sentence or two.'); return; }
    if (mode === 'student' && total < 1) {
      // audit 24: a clear message right by the time field (not a tiny line at the bottom)
      setTimeError(true);
      window.setTimeout(() => document.getElementById('v3c-time-field')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
      return;
    }
    setSaving(true);
    try {
      const { storageKey } = await uploadFile('showcase', file);
      const post = await apiFetch<ShowcaseItem>('/v2/showcase/posts', { method: 'POST', body: { storageKey, question, caption: answer, timeMinutes: total || null } });
      setAnswer(''); setFile(null); setHours(0); setMinutes(0);
      setDone(post.status === 'approved' ? 'Shared! Your piece is now in the showcase of your branch.' : 'Sent! Your branch admin will look at it soon.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not share your piece. Please try again.');
    } finally { setSaving(false); }
  };

  const withdraw = async (p: ShowcaseItem) => {
    if (!window.confirm('Remove this piece from the showcase?')) return;
    try { await apiFetch(`/v2/showcase/posts/${p.id}`, { method: 'DELETE' }); await load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not remove it.'); }
  };

  const statusText = (s: string) => s === 'approved' ? 'In the showcase' : s === 'rejected' ? 'Not accepted this time' : 'Waiting for approval';

  return (
    <main className={`page portal-page v3c-content-page v3c-myshow is-${mode}`}>
      <header className="v3c-page-head">
        <div>
          <p className="eyebrow">{mode === 'student' ? 'My showcase' : 'Teacher showcase'}</p>
          <h1>{mode === 'student' ? 'Share a finished piece' : 'Share a demonstration piece'}</h1>
          <p className="v3c-lede">{mode === 'student'
            ? 'Show your best work to the students and teachers of your branch. Tell us how you made it.'
            : 'Your piece goes straight to the teacher showcase of your branch, for students to learn from.'}</p>
        </div>
        {/* v3 audit 15: student work lives here (the gallery is reference work only) */}
        <button type="button" className="v3c-ghost-btn" onClick={() => {
          if (mode === 'teacher') { sessionStorage.setItem('khat.v3.galleryTab', 'teacher'); navigate('gallery'); return; }
          document.getElementById('v3c-branch-showcase')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}><Images size={15} /> See the showcase</button>
      </header>

      <section className="v3c-share-card" aria-label="Share a piece">
        <div className="v3c-share-photo">
          {preview ? <img src={preview} alt="Your piece" /> : null}
          <UploadBox tall label={file?.name ?? 'Add a photo of your piece'} sublabel={file ? 'Tap to replace or straighten it' : 'A clear photo in good light'} icon={FileImage} onChange={setEditing} />
        </div>
        <div className="v3c-share-fields">
          <div className="field-label">
            <span>{mode === 'student' ? 'Choose a question to answer' : 'A note for students'}</span>
            <div className="v3c-question-list" role="radiogroup" aria-label="Question">
              {questions.map(q => <button key={q} type="button" role="radio" aria-checked={question === q} className={question === q ? 'is-active' : ''} onClick={() => setQuestion(q)}>{q}</button>)}
            </div>
          </div>
          <label className="field-label">Your answer<textarea className="field textarea" value={answer} maxLength={1000} onChange={e => setAnswer(e.target.value)} placeholder={mode === 'student' ? 'e.g. The meem kept coming out too round, so I…' : 'e.g. Keep the pen angle steady in the joins…'} /></label>
          <div className={`field-label${timeError ? ' v3c-field-invalid' : ''}`} id="v3c-time-field">
            <span><Clock3 size={14} /> How much time did this take you?{mode === 'teacher' && ' (optional)'}</span>
            <div className="v3c-time-row">
              <label><select className="field" value={hours} onChange={e => { setHours(Number(e.target.value)); setTimeError(false); }} aria-label="Hours" aria-invalid={timeError || undefined}>{HOURS.map(h => <option key={h} value={h}>{h}</option>)}</select><span>hours</span></label>
              <label><select className="field" value={minutes} onChange={e => { setMinutes(Number(e.target.value)); setTimeError(false); }} aria-label="Minutes" aria-invalid={timeError || undefined}>{MINUTES.map(m => <option key={m} value={m}>{m}</option>)}</select><span>minutes</span></label>
            </div>
            {timeError && <p className="v3c-field-error" role="alert">Please choose how long this piece took you — pick the hours and minutes above.</p>}
            {mode === 'student' && <small className="v3c-hint">This is shown on your piece as your effort.</small>}
          </div>
          {error && <p className="error-text" role="alert">{error}</p>}
          {done && <p className="v3c-success" role="status">{done}</p>}
          <Button onClick={() => void submit()} disabled={saving}>{saving ? 'Sharing…' : mode === 'student' ? 'Send to the showcase' : 'Share with students'} {!saving && <ArrowRight size={15} />}</Button>
        </div>
      </section>

      <h2 className="v3c-h2">{mode === 'student' ? 'My shared pieces' : 'My posted pieces'}</h2>
      {loading ? <PenLoader label="Loading your pieces…" compact /> : posts.length === 0 ? (
        <div className="v3c-empty"><FileImage size={20} /><div><strong>Nothing shared yet</strong><p>Your pieces will appear here after you share them.</p></div></div>
      ) : (
        <div className="v3c-mine-list">
          {posts.map(p => (
            <article className="v3c-mine-row" key={p.id}>
              <span className="v3c-mine-img">{urls[p.imageStorageKey] ? <img src={urls[p.imageStorageKey]} alt="" /> : <FileImage size={22} />}</span>
              <div className="v3c-mine-copy">
                {p.question && <small className="v3c-q">{p.question}</small>}
                <strong>{p.caption ?? (cleanLabel(p.awardLabel) ? `${cleanLabel(p.awardLabel)} — competition piece` : 'Untitled piece')}</strong>
                <span className="v3c-mine-meta">{new Date(p.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}{effortLabel(p.timeMinutes) && ` · ${effortLabel(p.timeMinutes)} of effort`}</span>
              </div>
              <span className={`v3c-status is-${p.status}`}>{statusText(p.status)}</span>
              {p.source === 'post' && <button type="button" className="v3c-icon-btn" onClick={() => void withdraw(p)} aria-label="Remove this piece"><Trash2 size={16} /></button>}
            </article>
          ))}
        </div>
      )}
      <section id="v3c-branch-showcase" className="v3c-branch-showcase" aria-label="Student showcase of your branch">
        <h2 className="v3c-h2">Student showcase of your branch</h2>
        <ShowcaseFeedView role="student" />
      </section>
      {editing && <ShowcaseImageEditor file={editing} onCancel={() => setEditing(null)} onSave={f => { setFile(f); setEditing(null); }} />}
    </main>
  );
}

function useFilePreview(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setUrl(null); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}
