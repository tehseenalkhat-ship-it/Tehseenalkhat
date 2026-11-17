import { useCallback, useEffect, useState } from 'react';
import { BookOpen, ChevronRight, Inbox, ScanLine, SlidersHorizontal } from 'lucide-react';
import { apiFetch } from '@/api';
import type { InboxItem, ReviewerLoad } from '../contracts';
import { openV2 } from '../nav';
import { LoadMeter, WorkloadPanel } from '../review/WorkloadPanel';
import { COURSE_KINDS, KIND_LABEL, kindOf, type CourseKind } from './teacherTypes';
import './teacher.css';

/**
 * v3 — the top of the teacher dashboard: "N pieces waiting for you" with ONE big Review button,
 * then My workload and Upload marked items. Nothing to learn, nothing to set up.
 */
export function TeacherActionStrip() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [me, setMe] = useState<ReviewerLoad | null>(null);
  const [workloadOpen, setWorkloadOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<InboxItem[]>('/v2/review/inbox?status=open', { silent: true });
      setItems(Array.isArray(res) ? res : []);
      setFailed(false);
    } catch { setFailed(true); }
  }, []);
  useEffect(() => {
    void load();
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  const n = items?.length ?? 0;
  const counts = COURSE_KINDS.reduce((acc, k) => ({ ...acc, [k]: (items ?? []).filter(i => kindOf(i) === k).length }), {} as Record<CourseKind, number>);
  const overdue = (items ?? []).filter(i => i.waitingHours >= 72).length;
  const confirm = (items ?? []).filter(i => i.submission.autoMarked).length;
  const goInbox = (kind?: CourseKind) => openV2('v2-inbox', { inboxKind: kind ?? null, submissionId: null });

  return (
    <section className="v3-strip" aria-label="Your work today">
      <div className="v3-strip-main">
        <span className="v3-strip-icon" aria-hidden="true"><Inbox size={26} /></span>
        <div className="v3-strip-text">
          <p className="v3-strip-big">
            {items === null ? (failed ? 'Your review inbox' : 'Checking your inbox…') : n === 0 ? 'Nothing waiting — all caught up' : `${n} piece${n === 1 ? '' : 's'} waiting for you`}
          </p>
          {n > 0 && (
            <p className="v3-strip-kinds">
              {COURSE_KINDS.filter(k => counts[k] > 0).map(k => (
                <button key={k} type="button" className={`v3tc-kind-tag kind-${k}`} onClick={() => goInbox(k)}>{KIND_LABEL[k]} {counts[k]}</button>
              ))}
              {overdue > 0 && <span className="v3-strip-warn">{overdue} waiting over 3 days</span>}
              {confirm > 0 && <span className="v3-strip-note">{confirm} automatic mark{confirm === 1 ? '' : 's'} to confirm</span>}
            </p>
          )}
        </div>
        <button type="button" className="btn btn-primary v3-strip-review" onClick={() => goInbox()}>
          {n > 0 ? 'Review' : 'Open inbox'} <ChevronRight size={20} />
        </button>
      </div>
      <div className="v3-strip-more">
        <button type="button" className="v3-strip-btn" onClick={() => setWorkloadOpen(true)}>
          <SlidersHorizontal size={20} />
          <span><strong>My workload</strong>{me ? <LoadMeter open={me.openNow} limit={me.threshold} away={!!me.awayUntil && me.awayUntil.slice(0, 10) >= new Date().toISOString().slice(0, 10)} /> : <small>How much I hold · who gets the rest</small>}</span>
        </button>
        <button type="button" className="v3-strip-btn" onClick={() => openV2('v2-scan-return')}>
          <ScanLine size={20} />
          <span><strong>Upload marked items</strong><small>Marked on paper? Drop the scans here</small></span>
        </button>
        <button type="button" className="v3-strip-btn" onClick={() => openV2('v2-teacher-courses')}>
          <BookOpen size={20} />
          <span><strong>All courses</strong><small>What students are learning</small></span>
        </button>
      </div>
      <WorkloadPanel open={workloadOpen} onClose={() => setWorkloadOpen(false)} onLoaded={setMe} />
    </section>
  );
}
