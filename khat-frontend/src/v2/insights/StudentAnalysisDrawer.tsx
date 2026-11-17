// owner: analysis — staff drill-down: one student's smart analysis + a ready, encouraging message.
import { useCallback, useEffect, useRef, useState } from 'react';
import { BarChart3, CheckCircle2, Compass, Gem, Mail, MessageCircle, Route, Send, Sparkles, X } from 'lucide-react';
import { apiFetch } from '@/api';
import { PenLoader } from '@/components/ui';
import type { NudgeRequest } from '../contracts';
import type { StudentAnalysis } from './analysisTypes';
import {
  CourseList, MarksLine, MeritRing, NextSteps, RecentMarks, RemarksList, RubricBars, Section, StrengthsFocus, SummaryCards, TrendChip, lastActiveWords,
} from './analysisParts';
import { initials } from './common';
import './analysis.css';

type NudgeResponse = { sent: number; emailed: number; message: string };

const SEGMENT_LABEL: Record<StudentAnalysis['segment'], { label: string; tone: string }> = {
  needs_push: { label: 'Needs a push', tone: 'danger' },
  needs_encouragement: { label: 'Needs encouragement', tone: 'warning' },
  doing_well: { label: 'Doing well', tone: 'positive' },
  new: { label: 'New', tone: 'gold' },
  dormant: { label: 'Dormant', tone: 'muted' },
};

export function StudentAnalysisDrawer({ studentId, studentName, onClose, onSent }: {
  studentId: string;
  studentName?: string;
  onClose: () => void;
  onSent?: (studentId: string, message: string) => void;
}) {
  const [data, setData] = useState<StudentAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState(true);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      const result = await apiFetch<StudentAnalysis>(`/v2/analysis/student/${encodeURIComponent(studentId)}`);
      setData(result);
      setMessage(result.suggestedMessage ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this student.');
    }
  }, [studentId]);

  useEffect(() => { void load(); setSent(null); setSendError(null); }, [load]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = previous; };
  }, [onClose]);

  const send = async () => {
    if (!message.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      const body: NudgeRequest = { studentIds: [studentId], message: message.trim(), sendEmail: email };
      const result = await apiFetch<NudgeResponse>('/v2/insights/nudge', { method: 'POST', body });
      setSent(result.message || 'Sent.');
      onSent?.(studentId, message.trim());
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send the message.');
    } finally {
      setSending(false);
    }
  };

  const name = data?.student.name ?? studentName ?? 'Student';
  const seg = data ? SEGMENT_LABEL[data.segment] : null;

  return (
    <div className="v2-an-drawer-root" role="presentation">
      <div className="v2-an-backdrop" onClick={onClose} />
      <aside className="v2-an-drawer v2-an-page" role="dialog" aria-modal="true" aria-label={`Progress of ${name}`} tabIndex={-1} ref={panel}>
        <header className="v2-an-drawer-head">
          <span className="v2-an-avatar" aria-hidden="true">{initials(name)}</span>
          <div className="v2-an-drawer-who">
            <h2>{name}</h2>
            <small>
              {data ? [data.student.trNumber && `TR ${data.student.trNumber}`, data.student.className, data.student.branchName, `active ${lastActiveWords(data.summary.lastActiveAt).toLowerCase()}`].filter(Boolean).join(' · ') : 'Loading…'}
            </small>
          </div>
          <button type="button" className="v2-an-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        <div className="v2-an-drawer-body">
          {error && (
            <div className="v2-an-error" role="alert"><span>{error}</span><button type="button" className="btn btn-outline" onClick={() => void load()}>Try again</button></div>
          )}
          {!data && !error && <div className="v2-an-loading"><PenLoader compact label="Loading the analysis" /></div>}

          {data && seg && (
            <>
              <p className={`v2-an-segment v2-an-tone-${seg.tone}`}><b>{seg.label}</b><span>{data.segmentReason}</span></p>

              <section className="v2-an-message">
                <h3><Sparkles size={15} /> Suggested encouraging message</h3>
                {sent ? (
                  <p className="v2-an-sent" role="status"><CheckCircle2 size={16} /> {sent}</p>
                ) : (
                  <>
                    <textarea className="field textarea" value={message} onChange={event => setMessage(event.target.value)} maxLength={2000} rows={4} aria-label="Message to the student" />
                    <div className="v2-an-message-actions">
                      <label className="v2-an-email">
                        <input type="checkbox" checked={email} onChange={event => setEmail(event.target.checked)} />
                        <Mail size={14} /> Also email
                      </label>
                      <button type="button" className="btn btn-primary v2-an-send" onClick={() => void send()} disabled={sending || !message.trim()}>
                        <Send size={15} /> {sending ? 'Sending…' : 'Send this encouraging message'}
                      </button>
                    </div>
                    {sendError && <p className="v2-an-send-error" role="alert">{sendError}</p>}
                  </>
                )}
              </section>

              <SummaryCards data={data} audience="staff" />

              <Section title="Suggested next steps" icon={<Route size={16} />} className="is-steps">
                <NextSteps steps={data.nextSteps} />
              </Section>

              <Section title="Marks" icon={<BarChart3 size={16} />} extra={data.marks.length > 1 ? <TrendChip trend={data.summary.trend} /> : null}>
                <MarksLine marks={data.marks} bands={data.bands} compact />
                <p className="v2-an-trend-text">{data.summary.trendText.replace(/^Your /, 'The ').replace(/\byour\b/g, 'the')}</p>
                <RecentMarks marks={data.marks} />
                {data.summary.revisions > 0 && <p className="v2-an-soft">{data.summary.revisions} piece{data.summary.revisions === 1 ? '' : 's'} sent back for another try · {data.summary.attempts} sent in all</p>}
              </Section>

              <Section title="Strengths and focus areas" icon={<Sparkles size={16} />}>
                <StrengthsFocus data={data} audience="staff" />
                <RubricBars rubric={data.rubric} />
              </Section>

              <Section title="What teachers keep telling them" icon={<MessageCircle size={16} />}>
                <RemarksList data={data} audience="staff" />
              </Section>

              <Section title="Courses" icon={<Compass size={16} />}>
                <CourseList data={data} />
              </Section>

              <Section title="Merit points" icon={<Gem size={16} />}>
                <MeritRing merit={data.merit} audience="staff" />
              </Section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
