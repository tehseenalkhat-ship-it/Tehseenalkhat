import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, MessageSquareWarning, Wrench } from 'lucide-react';
import { API_BASE_URL, getToken } from '@/api';
import { compressForUpload } from '@/compress';
import { getRecentErrors } from '@/errorCapture';
import { Modal } from '@/components/ui';
import './ReportProblem.css';

// "Report a problem": floating button + form on every page (also signed out), and the
// "We fixed your problem — please check" bubble / dashboard card once the developer marks it fixed.

export type PendingReport = { id: string; text: string; page: string | null; fix_note: string | null; fixed_at: string; created_at: string };

const TOKENS_KEY = 'khat_report_tokens';

function readTokens(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(TOKENS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function addToken(token: string) {
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify([token, ...readTokens().filter((t) => t !== token)].slice(0, 20)));
  } catch {
    /* storage blocked: the signed-in user is still matched by account */
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getToken();
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Something went wrong (${response.status}). Please try again.`);
  return data as T;
}

/** Shrinks the screenshot (same compressor as other uploads) and returns it as a data URL. */
async function screenshotToDataUrl(file: File | null): Promise<string | undefined> {
  if (!file) return undefined;
  // Never let shrinking block a report: after 15 s (e.g. a backgrounded tab pauses canvas work) send the original.
  const small = await Promise.race([
    compressForUpload(file).catch(() => file),
    new Promise<File>((resolve) => window.setTimeout(() => resolve(file), 15_000)),
  ]);
  if (!/^image\/(jpeg|png|webp)$/.test(small.type)) throw new Error('Please attach a JPG, PNG or WebP screenshot.');
  if (small.size > 3 * 1024 * 1024) throw new Error('That screenshot is too large. Please attach a smaller one.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the screenshot.'));
    reader.readAsDataURL(small);
  });
}

// ---- Shared list of fixed reports waiting for this person's answer ----
let pending: PendingReport[] = [];
const listeners = new Set<() => void>();

export async function refreshPendingReports() {
  try {
    const data = await post<{ reports: PendingReport[] }>('/api/reports/pending', { tokens: readTokens() });
    pending = data.reports ?? [];
  } catch {
    pending = [];
  }
  listeners.forEach((listener) => listener());
}

function usePendingReports(): PendingReport[] {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return pending;
}

function ScreenshotInput({ file, onChange }: { file: File | null; onChange: (file: File | null) => void }) {
  return (
    <label className="report-field">
      <span>Screenshot (optional)</span>
      <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
      {file && <small>{file.name}</small>}
    </label>
  );
}

function ReportForm({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return setError('Please describe what went wrong.');
    setBusy(true);
    setError('');
    try {
      const screenshot = await screenshotToDataUrl(file);
      const result = await post<{ reporterToken: string }>('/api/reports', {
        text: text.trim(),
        page: location.href,
        screenshot,
        browserInfo: {
          userAgent: navigator.userAgent,
          screen: `${screen.width}x${screen.height}`,
          viewport: `${innerWidth}x${innerHeight}`,
          pixelRatio: devicePixelRatio,
          language: navigator.language,
          time: new Date().toISOString(),
        },
        recentErrors: getRecentErrors(),
      });
      addToken(result.reporterToken);
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="report-done">
        <CheckCircle2 size={32} aria-hidden="true" />
        <h2>Thank you!</h2>
        <p>Your report was sent. When it's fixed, you'll see a note here asking you to check.</p>
        <button className="report-primary" onClick={onClose}>Close</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="report-form">
      <h2>Report a problem</h2>
      <label className="report-field">
        <span>What went wrong? *</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} required autoFocus
          placeholder="What were you doing, and what happened?" />
      </label>
      <ScreenshotInput file={file} onChange={setFile} />
      <p className="report-hint">We'll also send the page address, your browser and screen size, and recent error messages.</p>
      {error && <p className="report-error" role="alert">{error}</p>}
      <button className="report-primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
    </form>
  );
}

/** "It works now" / "Still a problem" for one fixed report. Used by the bubble and the dashboard card. */
export function FixedReportAnswer({ report, compact = false }: { report: PendingReport; compact?: boolean }) {
  const [mode, setMode] = useState<'ask' | 'still' | 'done'>('ask');
  const [reply, setReply] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function answer(kind: 'works' | 'still') {
    if (kind === 'still' && !reply.trim()) return setError('Please tell us what still goes wrong.');
    setBusy(true);
    setError('');
    try {
      const screenshot = kind === 'still' ? await screenshotToDataUrl(file) : undefined;
      await post(`/api/reports/${encodeURIComponent(report.id)}/answer`, {
        answer: kind,
        reply: kind === 'still' ? reply.trim() : undefined,
        screenshot,
        tokens: readTokens(),
      });
      setMode('done');
      window.setTimeout(() => void refreshPendingReports(), 1800);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'done') return <p className="report-thanks"><CheckCircle2 size={18} aria-hidden="true" /> Thank you for letting us know.</p>;

  return (
    <div className={`fixed-report${compact ? ' compact' : ''}`}>
      <p className="fixed-quote"><strong>You reported:</strong> {report.text}</p>
      {report.fix_note && <p className="fixed-note"><strong>What we changed:</strong> {report.fix_note}</p>}
      {mode === 'ask' ? (
        <div className="fixed-actions">
          <button className="report-primary" disabled={busy} onClick={() => void answer('works')}>It works now</button>
          <button className="report-secondary" disabled={busy} onClick={() => setMode('still')}>Still a problem</button>
        </div>
      ) : (
        <div className="report-form">
          <label className="report-field">
            <span>What still goes wrong? *</span>
            <textarea value={reply} onChange={(e) => setReply(e.target.value)} maxLength={5000} required autoFocus />
          </label>
          <ScreenshotInput file={file} onChange={setFile} />
          <div className="fixed-actions">
            <button className="report-primary" disabled={busy} onClick={() => void answer('still')}>{busy ? 'Sending…' : 'Send'}</button>
            <button className="report-secondary" disabled={busy} onClick={() => setMode('ask')}>Back</button>
          </div>
        </div>
      )}
      {error && <p className="report-error" role="alert">{error}</p>}
    </div>
  );
}

/** Dashboard card listing fixed reports that wait for an answer (renders nothing otherwise). */
export function FixedReportsCard() {
  const reports = usePendingReports();
  if (!reports.length) return null;
  return (
    <section className="fixed-reports-card" aria-label="Problems we fixed">
      <h2><Wrench size={18} aria-hidden="true" /> We fixed your problem: please check</h2>
      {reports.map((report) => <FixedReportAnswer key={report.id} report={report} />)}
    </section>
  );
}

/** Floating button + "fixed" bubble. Mounted once by App on every page, including sign-in pages. */
export function ProblemReporting({ withAssistant = false, userId }: { withAssistant?: boolean; userId?: string | null }) {
  const reports = usePendingReports();
  const [reportOpen, setReportOpen] = useState(false);
  const [fixedOpen, setFixedOpen] = useState(false);

  useEffect(() => {
    void refreshPendingReports();
  }, [userId]);

  useEffect(() => {
    if (!reports.length) setFixedOpen(false);
  }, [reports.length]);

  return (
    <>
      <div className={`report-dock${withAssistant ? ' with-assistant' : ''}`}>
        {reports.length > 0 && (
          <button className="fixed-bubble" onClick={() => setFixedOpen(true)}>
            <Wrench size={16} aria-hidden="true" /> We fixed your problem: please check
          </button>
        )}
        <button className="report-fab" onClick={() => setReportOpen(true)} aria-label="Report a problem">
          <MessageSquareWarning size={17} aria-hidden="true" /> <span>Report a problem</span>
        </button>
      </div>

      {reportOpen && (
        <Modal className="report-modal" onClose={() => setReportOpen(false)}>
          <ReportForm onClose={() => setReportOpen(false)} />
        </Modal>
      )}

      {fixedOpen && reports.length > 0 && (
        <Modal className="report-modal" onClose={() => setFixedOpen(false)}>
          <h2><Wrench size={20} aria-hidden="true" /> We fixed your problem: please check</h2>
          {reports.map((report) => <FixedReportAnswer key={report.id} report={report} compact />)}
        </Modal>
      )}
    </>
  );
}
