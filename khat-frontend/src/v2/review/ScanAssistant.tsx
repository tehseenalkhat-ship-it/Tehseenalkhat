import { useEffect, useRef } from 'react';
import { Bot, CheckCircle2, Loader2, Send, X, XCircle } from 'lucide-react';
import type { ScanReturnResult } from '../contracts';
import './review-v3.css';

const QUICK_NOTES = [
  'Well done — please see my corrections on the sheet.',
  'Look at the circled letters and practice them a few more times.',
  'Good effort. Keep the baseline steady and send the next sheet.',
];

/**
 * v3 — the scan-return assistant. After the scanned pages are read it asks, like a chat:
 * "Shall I separate each page and send it to each student?" → "Add a message?" → sends → done.
 */
export function ScanAssistant(props: {
  stage: 'ask' | 'message' | 'sending' | 'done';
  pages: number;
  students: { name: string; pages: number }[];
  unreadable: number;
  sending: string | null;
  results: ScanReturnResult[] | null;
  error: string | null;
  note: string;
  setNote: (v: string) => void;
  onYes: () => void;
  onCheck: () => void;
  onSend: (message: string) => void;
  onClose: () => void;
}) {
  const { stage, students, unreadable, note, setNote } = props;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [stage, props.results]);
  const total = students.reduce((s, x) => s + x.pages, 0);
  const okCount = props.results?.filter(r => r.ok).length ?? 0;

  return (
    <div className="v3-bot-backdrop" role="presentation">
      <section className="v3-bot" role="dialog" aria-modal="true" aria-labelledby="v3-bot-title">
        <header className="v3-bot-head">
          <span className="v3-bot-avatar"><Bot size={20} /></span>
          <span><strong id="v3-bot-title">Marking assistant</strong><small>Sends your marked pages to each student</small></span>
          {stage !== 'sending' && <button type="button" className="v2-icon-btn" onClick={props.onClose} aria-label="Close"><X size={18} /></button>}
        </header>
        <div className="v3-bot-body">
          <div className="v3-bot-msg">
            {students.length
              ? <>I read the pages. I found <b>{students.length} student{students.length === 1 ? '' : 's'}</b> ({total} page{total === 1 ? '' : 's'}):</>
              : <>I read the pages, but I could not find a code on any of them.</>}
            {students.length > 0 && <ul>{students.map(s => <li key={s.name}>{s.name} — {s.pages} page{s.pages === 1 ? '' : 's'}</li>)}</ul>}
            {unreadable > 0 && <p className="v3-bot-warn">{unreadable} page{unreadable === 1 ? '' : 's'} had no readable code — I will leave {unreadable === 1 ? 'it' : 'them'} aside for you to match.</p>}
          </div>
          {students.length > 0 && (
            <div className="v3-bot-msg">Shall I <b>separate each page and send it to each student’s chat</b>?</div>
          )}
          {stage === 'ask' && (
            <div className="v3-bot-choices">
              {students.length > 0 && <button type="button" className="btn btn-primary" onClick={props.onYes}>Yes, separate and send</button>}
              <button type="button" className="btn btn-outline" onClick={props.onCheck}>{students.length ? 'Let me check first' : 'Match the pages myself'}</button>
            </div>
          )}
          {stage !== 'ask' && <div className="v3-bot-me">Yes, separate and send.</div>}
          {stage !== 'ask' && <div className="v3-bot-msg">Would you like to add a message along with the pages? (Optional — the same message goes to every student.)</div>}
          {stage === 'message' && (
            <div className="v3-bot-compose">
              <div className="v3-bot-chips">{QUICK_NOTES.map(q => <button key={q} type="button" className={note === q ? 'is-on' : ''} onClick={() => setNote(note === q ? '' : q)}>{q}</button>)}</div>
              <textarea className="field" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Type a message, or leave it empty" aria-label="Message to send with the pages" />
              <div className="v3-bot-choices">
                <button type="button" className="btn btn-primary" onClick={() => props.onSend(note)}><Send size={15} /> {note.trim() ? 'Send with this message' : 'Send without a message'}</button>
              </div>
            </div>
          )}
          {(stage === 'sending' || stage === 'done') && note.trim() && <div className="v3-bot-me">{note.trim()}</div>}
          {stage === 'sending' && <div className="v3-bot-msg"><Loader2 size={15} className="v2-spin" /> {props.sending ?? 'Working…'}</div>}
          {stage === 'done' && props.results && (
            <div className="v3-bot-msg">
              Done — I sent the pages to <b>{okCount} of {props.results.length}</b> student{props.results.length === 1 ? '' : 's'}. Each one will find them in their chat{note.trim() ? ' with your message' : ''}.
              <ul className="v3-bot-results">{props.results.map(r => <li key={r.submissionId} className={r.ok ? 'is-ok' : 'is-bad'}>{r.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />} {r.message}</li>)}</ul>
              <div className="v3-bot-choices"><button type="button" className="btn btn-primary" onClick={props.onClose}>Finish</button></div>
            </div>
          )}
          {props.error && stage !== 'ask' && <p className="v2-inline-error" role="alert">{props.error}</p>}
          <div ref={endRef} />
        </div>
      </section>
    </div>
  );
}
