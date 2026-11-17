import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Award, BookOpen, FileSpreadsheet, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { apiFetch } from '@/api';
import type { CourseStatus, CourseSummary, CourseTypeDef, FileCodeDef, StepTypeDef } from '../contracts';
import { BadgeDesignsPanel } from './badges/BadgeDesigns';
import { BuilderGuide } from './BuilderGuide';
import './PreviewReturn';
import './v3-builder.css';
import { CourseDetailView, penLabel, STATUS_INFO } from './CourseDetail';
import { IngestPanel } from './IngestPanel';
import { MasterImportDialog } from './MasterImport';
import { sizeLabel } from './naming';
import {
  Dialog, EmptyState, ErrorBox, Loading, PageHead, plural, ReadOnlyBanner, ToastHost, errorText, loadBranches, loadScope, toast, useLoad, type Branch,
} from './shared';

type Props = Record<string, never>;

const PARAM = 'khat.v2.param.builderCourseId';
// Admin home (or anyone) can open the builder straight on the "New course" form:
//   openV2('v2-builder', { builderAction: 'new' })   — also 'badges' opens Badge designs.
const ACTION = 'khat.v2.param.builderAction';
function readAction(): string | null { return sessionStorage.getItem(ACTION); }

type Ref = { stepTypes: StepTypeDef[]; courseTypes: CourseTypeDef[]; fileCodes: FileCodeDef[] | null; branches: Branch[]; isMaster: boolean };

async function loadRef(): Promise<Ref> {
  const [scope, stepTypes, courseTypes, fileCodes, branches] = await Promise.all([
    loadScope(),
    apiFetch<StepTypeDef[]>('/v2/step-types').catch(() => [] as StepTypeDef[]),
    apiFetch<CourseTypeDef[]>('/v2/course-types').catch(() => [] as CourseTypeDef[]),
    apiFetch<FileCodeDef[]>('/v2/file-codes').catch(() => null),
    loadBranches(),
  ]);
  return { stepTypes, courseTypes, fileCodes, branches, isMaster: scope.scope.isMaster };
}

export function V2CourseBuilderPage(_props: Props) {
  const ref = useLoad(loadRef);
  const courses = useLoad(() => apiFetch<CourseSummary[]>('/v2/courses'));
  // Only the builder's own parameter: the shared "courseId" is set by student/teacher pages and used to
  // open some old course instead of the list (why "Create course" looked broken from the admin home).
  const [action] = useState<string | null>(() => readAction());
  useEffect(() => { sessionStorage.removeItem(ACTION); }, []);
  const [openId, setOpenId] = useState<string | null>(() => (action ? null : sessionStorage.getItem(PARAM)));

  const open = (id: string | null) => {
    if (id) sessionStorage.setItem(PARAM, id); else sessionStorage.removeItem(PARAM);
    setOpenId(id);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="page portal-page v2-admin">
      {(ref.loading && !ref.data) ? <Loading label="Opening the course builder…" /> : openId && ref.data ? (
        <CourseDetailView
          courseId={openId}
          canEdit={ref.data.isMaster}
          stepTypes={ref.data.stepTypes}
          courseTypes={ref.data.courseTypes}
          fileCodes={ref.data.fileCodes}
          branches={ref.data.branches}
          onBack={() => { open(null); void courses.reload(true); }}
          onOpenCourse={id => open(id)}
          onChanged={() => void courses.reload(true)}
        />
      ) : (
        <CourseList
          courses={courses.data}
          loading={courses.loading}
          error={courses.error}
          onRetry={() => void courses.reload()}
          refData={ref.data}
          onOpen={open}
          onRefresh={() => void courses.reload(true)}
          initialAction={action}
        />
      )}
      <ToastHost />
    </div>
  );
}

function CourseList({ courses, loading, error, onRetry, refData, onOpen, onRefresh, initialAction }: {
  courses: CourseSummary[] | null; loading: boolean; error: string | null; onRetry: () => void; refData: Ref | null; onOpen: (id: string) => void; onRefresh: () => void;
  initialAction: string | null;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<CourseStatus | 'all'>('all');
  const [pen, setPen] = useState('');
  const [type, setType] = useState('');
  const [branch, setBranch] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [showNew, setShowNew] = useState(initialAction === 'new');
  const [showBadges, setShowBadges] = useState(initialAction === 'badges');
  const [filtersOpen, setFiltersOpen] = useState(false);
  // v3 audit 18: old empty courses ("No code · 0 levels") are hidden unless "Old courses" is chosen.
  const [showOld, setShowOld] = useState(false);
  const canEdit = refData?.isMaster ?? false;
  const branches = refData?.branches ?? [];
  const courseTypes = refData?.courseTypes ?? [];

  const pens = useMemo(() => Array.from(new Set((courses ?? []).map(c => c.penType).filter(Boolean) as string[])).sort(), [courses]);
  const oldCount = useMemo(() => (courses ?? []).filter(isOldEmpty).length, [courses]);
  const counts = useMemo(() => {
    const c: Record<CourseStatus | 'all', number> = { all: 0, draft: 0, published: 0, held: 0, hidden: 0 };
    (courses ?? []).filter(x => !isOldEmpty(x)).forEach(x => { c.all += 1; c[x.status] += 1; });
    return c;
  }, [courses]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (courses ?? []).filter(c =>
      (showOld ? isOldEmpty(c) : !isOldEmpty(c))
      && (showOld || status === 'all' || c.status === status)
      && (!pen || c.penType === pen)
      && (!type || c.courseType === type)
      && (!branch || c.branchIds.length === 0 || c.branchIds.includes(branch))
      && (!needle || [c.code, c.title, c.titleAr].some(v => v?.toLowerCase().includes(needle))),
    ).sort((a, b) => (a.code ?? a.title).localeCompare(b.code ?? b.title));
  }, [courses, q, status, pen, type, branch, showOld]);
  const activeFilters = [pen, type, branch].filter(Boolean).length;

  return (
    <>
      <PageHead
        eyebrow="Curriculum control"
        title="Course builder"
        text="Upload a file and it becomes a step. Upload a level and it becomes a level. Nothing is fixed by counts."
        actions={canEdit ? <>
          <button type="button" className="btn btn-outline" onClick={() => setShowBadges(true)}><Award size={15} /> Badge designs</button>
          <button type="button" className="btn btn-outline" onClick={() => setShowNew(true)}><Plus size={15} /> New course</button>
          <button type="button" className="btn btn-primary" onClick={() => setShowImport(true)}><FileSpreadsheet size={15} /> Import master list</button>
        </> : undefined}
      />
      {canEdit && <BuilderGuide />}
      {refData && !canEdit && <ReadOnlyBanner>Courses are prepared by the Nairobi team. You can look at every course and preview it as a student.</ReadOnlyBanner>}
      {canEdit && <IngestPanel variant="global" fileCodes={refData?.fileCodes ?? null} onDone={onRefresh} emptyHint="Files for any course — each name says where it belongs, e.g. FNK-C101_MT_LV01_S01_P01_07_v1.jpg." />}

      <div className="v2-status-tabs" role="tablist" aria-label="Filter by status">
        {(['all', 'published', 'draft', 'held', 'hidden'] as const).map(s => (
          <button key={s} type="button" role="tab" aria-selected={!showOld && status === s} className={!showOld && status === s ? 'active' : ''} onClick={() => { setShowOld(false); setStatus(s); }} title={s === 'all' ? undefined : STATUS_INFO[s].text}>
            {s === 'all' ? 'All' : STATUS_INFO[s].label}<span>{counts[s]}</span>
          </button>
        ))}
        {oldCount > 0 && (
          <button type="button" role="tab" aria-selected={showOld} className={`v3-old-tab${showOld ? ' active' : ''}`} onClick={() => setShowOld(o => !o)} title="Courses from the old site with no levels — kept only for their history">
            Old courses<span>{oldCount}</span>
          </button>
        )}
      </div>

      <div className="v2-filterbar">
        <label className="v2-search">
          <Search size={16} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search code or name" aria-label="Search courses" />
        </label>
        <button type="button" className={`btn btn-outline v2-btn-sm v2-filter-toggle${activeFilters ? ' has' : ''}`} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(o => !o)}>
          <SlidersHorizontal size={14} /> Filters{activeFilters ? ` · ${activeFilters}` : ''}
        </button>
        <div className={`v2-filter-fields${filtersOpen ? ' open' : ''}`}>
          <select className="field" value={pen} onChange={e => setPen(e.target.value)} aria-label="Pen type">
            <option value="">Every pen</option>
            {pens.map(p => <option key={p} value={p}>{penLabel(p)}</option>)}
          </select>
          <select className="field" value={type} onChange={e => setType(e.target.value)} aria-label="Course type">
            <option value="">Every type</option>
            {courseTypes.map(t => <option key={t.typeKey} value={t.typeKey}>{t.label}</option>)}
          </select>
          <select className="field" value={branch} onChange={e => setBranch(e.target.value)} aria-label="Branch">
            <option value="">Every branch</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      </div>

      {error && <ErrorBox message={error} onRetry={onRetry} />}
      {loading && !courses && <Loading label="Loading courses…" />}
      {courses && courses.length === 0 && (
        <EmptyState icon={<BookOpen size={28} />} title="No courses yet" text="Start with your Master Course List — every row becomes a Draft course. Or simply drop files above: the course code in each name finds its course.">
          {canEdit && <button type="button" className="btn btn-primary v2-btn-sm" onClick={() => setShowImport(true)}><FileSpreadsheet size={14} /> Import master list</button>}
        </EmptyState>
      )}
      {showOld && list.length > 0 && <p className="v2-help">Old courses from the earlier site. They have no levels and students do not see them unless they are published.</p>}
      {courses && courses.length > 0 && list.length === 0 && (
        <EmptyState icon={<Search size={26} />} title="No course matches" text="Try another word, or clear the filters.">
          <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => { setQ(''); setPen(''); setType(''); setBranch(''); setStatus('all'); }}>Clear filters</button>
        </EmptyState>
      )}

      <div className="v2-course-grid">
        {list.map(c => <CourseCard key={c.id} course={c} branches={branches} courseTypes={courseTypes} onOpen={() => onOpen(c.id)} />)}
      </div>

      {showBadges && (
        <Dialog title="Badge designs" eyebrow="Artwork students receive" wide onClose={() => setShowBadges(false)}>
          <BadgeDesignsPanel canEdit={canEdit} />
        </Dialog>
      )}
      {showImport && <MasterImportDialog onClose={() => setShowImport(false)} onApplied={onRefresh} />}
      {showNew && <NewCourseDialog courseTypes={courseTypes} onClose={() => setShowNew(false)} onCreated={id => { onRefresh(); onOpen(id); }} />}
    </>
  );
}

/** An old-site course that was never built here: no code and no levels. */
function isOldEmpty(c: CourseSummary): boolean {
  return c.counts.levels === 0 && (!c.code || c.structureVersion === 1);
}

function CourseCard({ course, branches, courseTypes, onOpen }: { course: CourseSummary; branches: Branch[]; courseTypes: CourseTypeDef[]; onOpen: () => void }) {
  const s = STATUS_INFO[course.status];
  const type = courseTypes.find(t => t.typeKey === course.courseType)?.label ?? course.courseType;
  const branchText = course.branchIds.length ? course.branchIds.map(id => branches.find(b => b.id === id)?.name ?? id).join(', ') : 'All branches';
  return (
    <button type="button" className={`v2-course-card status-${course.status}`} onClick={onOpen}>
      <div className="v2-course-card-top">
        <span className="v2-code-tag">{course.code ?? 'No code'}</span>
        <span className={s.chip}>{s.label}</span>
      </div>
      <strong className="v2-course-card-title">{course.title}</strong>
      {course.titleAr && <span className="v2-ar" dir="rtl">{course.titleAr}</span>}
      <span className="v2-course-card-meta">{[penLabel(course.penType) || null, type, course.mistarSizes.length ? course.mistarSizes.map(sizeLabel).join(' · ') : null].filter(Boolean).join(' · ')}</span>
      <span className="v2-course-card-counts">
        <span><b>{course.counts.levels}</b> levels</span>
        <span><b>{course.counts.steps}</b> steps</span>
        <span><b>{course.counts.files}</b> files</span>
        <span><b>{course.counts.students}</b> students</span>
      </span>
      <span className="v2-course-card-foot">
        <span>{branchText}</span>
        {course.counts.missing > 0 ? <span className="v2-warn"><AlertTriangle size={12} /> {plural(course.counts.missing, 'file')} missing</span> : <span className="v2-ok">Complete</span>}
      </span>
    </button>
  );
}

function NewCourseDialog({ courseTypes, onClose, onCreated }: { courseTypes: CourseTypeDef[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [titleAr, setTitleAr] = useState('');
  const [penType, setPenType] = useState('normal');
  const [courseType, setCourseType] = useState(courseTypes[0]?.typeKey ?? 'certification');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!courseType && courseTypes[0]) setCourseType(courseTypes[0].typeKey); }, [courseTypes, courseType]);
  const valid = /^[A-Za-z]{2,5}-[A-Za-z]\d{3}$/.test(code.trim()) && title.trim().length > 1;
  const run = async () => {
    setBusy(true);
    try {
      const created = await apiFetch<{ id: string }>('/v2/courses', { method: 'POST', body: { code: code.trim().toUpperCase(), title: title.trim(), titleAr: titleAr.trim() || null, penType, courseType } });
      toast('Course created as Draft. Now drop its files.');
      onClose();
      onCreated(created.id);
    } catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <Dialog
      title="New course"
      eyebrow="Starts as Draft"
      onClose={onClose}
      footer={<><button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={() => void run()}>{busy ? 'Creating…' : 'Create course'}</button></>}
    >
      <p className="v2-help">Usually courses come from the Master Course List. Use this for a quick extra course.</p>
      <div className="v2-grid-2">
        <label className="field-label">Course code<input className="field" value={code} placeholder="FNK-C101" onChange={e => setCode(e.target.value)} /></label>
        <label className="field-label">Pen type
          <select className="field" value={penType} onChange={e => setPenType(e.target.value)}><option value="normal">Normal pen</option><option value="cut">Cut pen</option></select>
        </label>
      </div>
      <label className="field-label">Course name<input className="field" value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="field-label">Arabic name <span className="v2-optional">optional</span><input className="field v2-ar-input" dir="rtl" value={titleAr} onChange={e => setTitleAr(e.target.value)} /></label>
      <label className="field-label">Course type
        <select className="field" value={courseType} onChange={e => setCourseType(e.target.value)}>
          {courseTypes.map(t => <option key={t.typeKey} value={t.typeKey}>{t.label}</option>)}
          {!courseTypes.length && <option value="certification">Certification</option>}
        </select>
      </label>
    </Dialog>
  );
}
