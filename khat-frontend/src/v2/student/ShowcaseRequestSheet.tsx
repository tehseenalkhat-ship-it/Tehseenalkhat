import { useEffect, useState } from 'react';
import { Camera, Check, Sparkles } from 'lucide-react';
import { apiFetch, uploadFile } from '@/api';
import type { Attachment, ThreadResponse } from '../contracts';
import { errorMessage, Sheet, SignedImage } from './shared';

type Choice = { storageKey: string; label: string; submissionId: string | null };

function isImage(attachment: Attachment): boolean {
  return attachment.contentType?.startsWith('image/') || /\.(jpe?g|png|webp|heic)$/i.test(attachment.originalFilename);
}

/**
 * "Request to showcase my work" — one tap to suggest a piece for the gallery.
 * With a stepId it offers the photos from the student's passed work on that step.
 */
export function ShowcaseRequestSheet({ stepId, defaultCaption = '', onClose, onSent }: { stepId?: string; defaultCaption?: string; onClose: () => void; onSent?: () => void }) {
  const [choices, setChoices] = useState<Choice[]>([]);
  const [loading, setLoading] = useState(Boolean(stepId));
  const [picked, setPicked] = useState<Choice | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState(defaultCaption);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!stepId) return;
    let cancelled = false;
    apiFetch<ThreadResponse>(`/v2/threads/${stepId}`, { silent: true })
      .then(thread => {
        if (cancelled) return;
        const passed = [...thread.submissions].filter(s => s.status === 'passed' || s.status === 'reviewed').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const list = passed.flatMap(s => s.files.filter(isImage).map((f, i) => ({ storageKey: f.storageKey, label: f.originalFilename || `Photo ${i + 1}`, submissionId: s.id })));
        setChoices(list);
        setPicked(list[list.length - 1] ?? null);
      })
      .catch(() => { if (!cancelled) setChoices([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [stepId]);

  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const send = async () => {
    if (sending) return;
    if (!file && !picked) { setError('Choose a photo of your work first.'); return; }
    setSending(true); setError(null);
    try {
      let storageKey = picked?.storageKey ?? '';
      let submissionId = picked?.submissionId ?? null;
      if (file) { storageKey = (await uploadFile('showcase', file)).storageKey; submissionId = null; }
      await apiFetch('/v2/showcase/requests', { method: 'POST', body: { storageKey, caption: caption.trim(), ...(submissionId ? { submissionId } : {}) } });
      setSent(true);
      onSent?.();
    } catch (err) {
      setError(errorMessage(err, 'Your request could not be sent. Please try again.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet title="Request to showcase my work" onClose={onClose}>
      {sent ? (
        <div className="v2s-sent-state" role="status">
          <span className="v2s-sent-icon"><Check size={22} /></span>
          <strong>Request sent — well done!</strong>
          <p>Your branch team will look at it soon. If it is approved, it will appear in the gallery for everyone to enjoy.</p>
          <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      ) : (
        <>
          <p className="v2s-sheet-lead">Proud of a piece? Suggest it for the gallery. Your branch team looks at every request.</p>
          {loading && <p className="muted">Finding your passed work…</p>}
          {choices.length > 0 && (
            <div className="v2s-pick-grid" role="radiogroup" aria-label="Choose a photo">
              {choices.map(choice => (
                <button key={choice.storageKey} type="button" role="radio" aria-checked={!file && picked?.storageKey === choice.storageKey} className={`v2s-pick${!file && picked?.storageKey === choice.storageKey ? ' is-picked' : ''}`} onClick={() => { setPicked(choice); setFile(null); }}>
                  <SignedImage storageKey={choice.storageKey} alt={choice.label} />
                  {!file && picked?.storageKey === choice.storageKey && <span className="v2s-pick-check"><Check size={14} /></span>}
                </button>
              ))}
            </div>
          )}
          <label className={`v2s-photo-drop${file ? ' has-file' : ''}`}>
            {preview ? <img src={preview} alt="Your chosen photo" /> : <Camera size={22} aria-hidden="true" />}
            <strong>{file ? file.name : choices.length ? 'Or take / choose another photo' : 'Take or choose a photo'}</strong>
            <small>Clear photo in daylight, the whole page in frame</small>
            <input type="file" accept="image/*" onChange={event => { const next = event.target.files?.[0]; if (next) { setFile(next); setError(null); } }} />
          </label>
          <label className="field-label v2s-field">A few words (optional)
            <input className="field" value={caption} maxLength={200} onChange={event => setCaption(event.target.value)} placeholder="e.g. My Naskh mufradat, Level 3" />
          </label>
          {error && <p className="v2s-form-error" role="alert">{error}</p>}
          <div className="v2s-sheet-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={sending || (!file && !picked)}><Sparkles size={15} /> {sending ? 'Sending…' : 'Send request'}</button>
          </div>
        </>
      )}
    </Sheet>
  );
}
