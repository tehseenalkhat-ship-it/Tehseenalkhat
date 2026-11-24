// owner: student-dash (v3). Courses for the student's branch, embedded on the Courses page.
// Same cards as the dashboard: pen (green / blue) → kind (Certification / Crash / Mashq).
import { useEffect, useMemo, useState } from 'react';
import { Clock, PenLine } from 'lucide-react';
import { PenLoader } from '@/components/ui';
import { InlineError, ensureAmiri } from './shared';
import { CourseCard } from './home/CourseCard';
import { useStudentCourses } from './home/useStudentCourses';
import { courseKind, KIND_GROUP, KIND_LABEL, KIND_ORDER, penKind, PEN_TEXT, STYLE_TEXT, styleOf as styleOfText, type PenKind } from './home/studentText';
import './student-v2.css';
import './home/v3-student.css';

type Props = Record<string, never>;

/** Kept for older imports. */
export const styleOf = styleOfText;
export const STYLE_LABEL: Record<1 | 2, { ar: string; en: string }> = { 1: { ar: STYLE_TEXT[1].ar, en: STYLE_TEXT[1].latin }, 2: { ar: STYLE_TEXT[2].ar, en: STYLE_TEXT[2].latin } };

export function V2StudentCatalogSection(_props: Props) {
  const { entries, error, reload } = useStudentCourses();
  const [pen, setPen] = useState<PenKind | null>(() => localStorage.getItem('khat.v3.pen') as PenKind | null);
  useEffect(() => { ensureAmiri(); }, []);

  const counts = useMemo(() => {
    const c: Record<PenKind, number> = { normal: 0, cut: 0, other: 0 };
    (entries ?? []).forEach(e => { c[penKind(e.summary.penType)] += 1; });
    return c;
  }, [entries]);
  const active: PenKind = pen && counts[pen] ? pen : counts.normal ? 'normal' : counts.cut ? 'cut' : counts.other ? 'other' : 'normal';
  const groups = KIND_ORDER.map(kind => ({ kind, items: (entries ?? []).filter(e => penKind(e.summary.penType) === active && courseKind(e.summary.courseType) === kind) }))
    .filter(group => group.items.length || group.kind !== 'other');

  if (entries && entries.length === 0) {
    return (
      <section className="v3-sd-page v3-sd-section" style={{ padding: 0, marginBottom: 40 }} aria-labelledby="v3-sd-catalog-title">
        <div className="v3-sd-section-head">
          <p className="v3-sd-eyebrow">Courses for your branch</p>
          <h2 id="v3-sd-catalog-title">Courses are being prepared</h2>
          <p>Your teachers are setting up the courses. Please check again soon.</p>
        </div>
      </section>
    );
  }
  return (
    <section className="v3-sd-page v3-sd-section" style={{ padding: 0, marginBottom: 40 }} aria-labelledby="v3-sd-catalog-title">
      <div className="v3-sd-section-head">
        <p className="v3-sd-eyebrow">Courses for your branch</p>
        <h2 id="v3-sd-catalog-title">Choose your pen and course</h2>
        <p>Start whenever you are ready. Everything you need — videos, worksheets and the chat with your teacher — is inside each course.</p>
      </div>
      {error && <InlineError message={error} onRetry={() => void reload()} />}
      {!entries && !error && <PenLoader label="Loading courses…" compact />}
      {entries && (
        <>
          <div className="v3-sd-pens" role="tablist" aria-label="Pen">
            {(['normal', 'cut', 'other'] as PenKind[]).filter(p => p !== 'other' || counts.other).map(p => (
              <button key={p} type="button" role="tab" aria-selected={active === p} className={`v3-sd-pen is-${p}${active === p ? ' is-active' : ''}`} onClick={() => { setPen(p); localStorage.setItem('khat.v3.pen', p); }}>
                <PenLine size={18} aria-hidden="true" />
                <span><strong>{PEN_TEXT[p].label}</strong><small>{counts[p]} {counts[p] === 1 ? 'course' : 'courses'}</small></span>
              </button>
            ))}
          </div>
          <div className="v3-sd-kind-groups">
            {groups.map(group => (
              <div key={group.kind} className="v3-sd-kind-group">
                <h3>{KIND_GROUP[group.kind].title} {group.items.length > 0 && <span className="v3-sd-count">{group.items.length}</span>}</h3>
                <p className="v3-sd-kind-text">{KIND_GROUP[group.kind].text}</p>
                {group.items.length === 0
                  ? <p className="v3-sd-quiet-box"><Clock size={16} aria-hidden="true" /> {KIND_GROUP[group.kind].title} for the {PEN_TEXT[active].label.toLowerCase()} are being prepared. Please check again soon.</p>
                  : <div className="v3-sd-card-grid">{group.items.map(entry => <CourseCard key={entry.summary.id} entry={entry} />)}</div>}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
