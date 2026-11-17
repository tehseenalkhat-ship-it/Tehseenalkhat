import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Award, CheckCircle2, Map as MapIcon, ChevronDown, Copy, Eye, EyeOff, FileSpreadsheet, GripVertical, History, Info, Layers,
  ListChecks, Plus, Settings2, Trash2, Undo2, X,
} from 'lucide-react';
import { apiFetch } from '@/api';
import type {
  AuditEntry, CourseDetail, CourseStatus, CourseTypeDef, FileCodeDef, HealthIssue, Level, Step, StepTypeDef,
} from '../contracts';
import { openV2 } from '../nav';
import { IngestPanel } from './IngestPanel';
import { ManifestImportDialog } from './MasterImport';
import { SIZE_CODES, sizeLabel } from './naming';
import { StepRow, type StepPatch } from './StepsTable';
import { AddStepDialog } from './AddStepDialog';
import { CourseMap } from './CourseMap';
import { startStudentPreview } from './PreviewReturn';
import { loadBadgeDesigns } from './badges/BadgeDesigns';
import { BADGE_KIND_LABEL, type BadgeDesign, type CourseV3, type LevelV3 } from './builderTypes';
import './v3-builder.css';
import {
  ConfirmDialog, Dialog, EmptyState, ErrorBox, formatDate, Loading, plural, ReadOnlyBanner, Segmented, Switch, toast, errorText, type Branch,
} from './shared';

export const STATUS_INFO: Record<CourseStatus, { label: string; text: string; chip: string }> = {
  draft: { label: 'Draft', text: 'Being built — only admins can see it.', chip: 'chip v2-chip-muted' },
  published: { label: 'Published', text: 'Live for students of its branches.', chip: 'chip chip-green' },
  held: { label: 'Held', text: 'Paused — enrolled students carry on, new students cannot join.', chip: 'chip chip-amber' },
  hidden: { label: 'Hidden', text: 'Gone for students. Their work is kept and you can bring it back.', chip: 'chip chip-red' },
};

export function penLabel(p: string | null | undefined): string {
  if (!p) return '';
  return `${p.charAt(0).toUpperCase()}${p.slice(1)} pen`;
}

type LevelPatch = Partial<Pick<Level, 'description' | 'instructions' | 'status' | 'badgeCode'>> & { badgeDesignId?: string | null };

const TYPICAL_INSTRUCTIONS = '1. Watch the video.\n2. Download the reference image.\n3. Do the worksheet.\n4. Upload your work.';

type Tab = 'map' | 'build' | 'details' | 'health' | 'history';

export function CourseDetailView({
  courseId, canEdit, stepTypes, courseTypes, fileCodes, branches, onBack, onOpenCourse, onChanged,
}: {
  courseId: string; canEdit: boolean; stepTypes: StepTypeDef[]; courseTypes: CourseTypeDef[]; fileCodes: FileCodeDef[] | null;
  branches: Branch[]; onBack: () => void; onOpenCourse: (id: string) => void; onChanged: () => void;
}) {
  const [course, setCourse] = useState<CourseV3 | null>(null);
  const [designs, setDesigns] = useState<BadgeDesign[] | null>(null);
  const [addStepFor, setAddStepFor] = useState<Level | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [blockMsg, setBlockMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('map');
  const [health, setHealth] = useState<HealthIssue[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<null | { title: string; text: string; label: string; run: () => Promise<void> }>(null);
  const [showCopy, setShowCopy] = useState(false);
  const [showManifest, setShowManifest] = useState(false);
  const [drag, setDrag] = useState<{ kind: 'level' | 'step'; id: string; levelId?: string } | null>(null);
  const [focusStep, setFocusStep] = useState<string | null>(null);

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const c = await apiFetch<CourseV3>(`/v2/courses/${courseId}`);
      setCourse(c);
      setExpanded(prev => (prev.size || quiet ? prev : new Set(c.levels.slice(0, 1).map(l => l.id))));
      apiFetch<HealthIssue[]>(`/v2/courses/${courseId}/health`, { silent: true }).then(setHealth).catch(() => setHealth(null));
    } catch (err) {
      setError(errorText(err, 'Could not open this course.'));
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); setTab('map'); setSelected(new Set()); setBlockMsg(null); }, [courseId]);
  useEffect(() => { loadBadgeDesigns().then(r => setDesigns(r.designs)).catch(() => setDesigns([])); }, [courseId]);

  const courseType = courseTypes.find(t => t.typeKey === course?.courseType);
  const stepsOnly = courseType ? !courseType.hasLevels : false;
  const typeOptions = useMemo(() => {
    const allowed = courseType?.allowedStepTypes?.length ? courseType.allowedStepTypes : stepTypes.map(s => s.typeKey);
    return stepTypes.filter(s => allowed.includes(s.typeKey)).sort((a, b) => a.sortOrder - b.sortOrder);
  }, [courseType, stepTypes]);
  const allSteps = useMemo(() => course?.levels.flatMap(l => l.steps) ?? [], [course]);

  if (loading && !course) return <Loading label="Opening the course…" />;
  if (error && !course) return <ErrorBox message={error} onRetry={() => void load()} />;
  if (!course) return null;

  /* ---------- mutations (optimistic) ---------- */
  const replaceStep = (stepId: string, patch: Partial<Step>) => setCourse(c => c && ({ ...c, levels: c.levels.map(l => ({ ...l, steps: l.steps.map(s => (s.id === stepId ? { ...s, ...patch } : s)) })) }));
  const replaceLevel = (levelId: string, patch: Partial<Level>) => setCourse(c => c && ({ ...c, levels: c.levels.map(l => (l.id === levelId ? { ...l, ...patch } : l)) }));

  const patchCourse = async (patch: Partial<CourseDetail>, okText?: string, undo?: Partial<CourseDetail>) => {
    const before = course;
    setCourse(c => c && ({ ...c, ...patch }));
    try {
      await apiFetch(`/v2/courses/${course.id}`, { method: 'PATCH', body: patch });
      setBlockMsg(null);
      onChanged();
      if (okText) toast(okText, undo ? { action: { label: 'Undo', run: () => void patchCourse(undo) } } : {});
    } catch (err) {
      setCourse(before);
      const text = errorText(err);
      if (/cannot be shown to students yet/.test(text)) setBlockMsg(text); else toast(text, { tone: 'error' });
    }
  };
  const patchStep = async (step: Step, patch: StepPatch) => {
    replaceStep(step.id, patch);
    try {
      await apiFetch(`/v2/steps/${step.id}`, { method: 'PATCH', body: patch });
      if ('status' in patch) toast(patch.status === 'hidden' ? `${step.code} hidden from students.` : `${step.code} visible to students.`);
    } catch (err) { replaceStep(step.id, step); toast(errorText(err), { tone: 'error' }); }
  };
  const patchLevel = async (level: Level, patch: LevelPatch, okText?: string) => {
    replaceLevel(level.id, patch);
    try {
      await apiFetch(`/v2/levels/${level.id}`, { method: 'PATCH', body: patch });
      if (okText) toast(okText);
    } catch (err) {
      replaceLevel(level.id, level);
      const text = errorText(err);
      if (/cannot be shown to students yet/.test(text)) setBlockMsg(text); else toast(text, { tone: 'error' });
    }
  };
  const reorderLevels = async (ids: string[]) => {
    const before = course.levels;
    setCourse(c => c && ({ ...c, levels: ids.map(id => c.levels.find(l => l.id === id)!).filter(Boolean) }));
    try { await apiFetch(`/v2/courses/${course.id}/levels/reorder`, { method: 'POST', body: { orderedIds: ids } }); }
    catch (err) { setCourse(c => c && ({ ...c, levels: before })); toast(errorText(err), { tone: 'error' }); }
  };
  const reorderSteps = async (level: Level, ids: string[]) => {
    replaceLevel(level.id, { steps: ids.map(id => level.steps.find(s => s.id === id)!).filter(Boolean) });
    try { await apiFetch(`/v2/levels/${level.id}/steps/reorder`, { method: 'POST', body: { orderedIds: ids } }); }
    catch (err) { replaceLevel(level.id, { steps: level.steps }); toast(errorText(err), { tone: 'error' }); }
  };
  const moveInList = (ids: string[], id: string, delta: number) => {
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return null;
    const next = [...ids];
    next.splice(i, 1);
    next.splice(j, 0, id);
    return next;
  };
  const dropBefore = (ids: string[], dragged: string, target: string) => {
    if (dragged === target) return null;
    const next = ids.filter(x => x !== dragged);
    const at = next.indexOf(target);
    const from = ids.indexOf(dragged);
    const to = ids.indexOf(target);
    next.splice(from < to ? at + 1 : at, 0, dragged);
    return next;
  };

  const addLevel = async () => {
    try {
      const created = await apiFetch<Level>(`/v2/courses/${course.id}/levels`, { method: 'POST', body: {} });
      await load(true);
      if (created?.id) setExpanded(s => new Set(s).add(created.id));
      toast(`${created?.code ?? 'New level'} added.`);
    } catch (err) { toast(errorText(err), { tone: 'error' }); }
  };
  const addFirstStep = async () => {
    try {
      const lvl = await apiFetch<Level>(`/v2/courses/${course.id}/levels`, { method: 'POST', body: { code: 'LV01' } });
      await load(true);
      if (lvl?.id) setAddStepFor(lvl);
    } catch (err) { toast(errorText(err), { tone: 'error' }); }
  };
  const addStep = (level: Level) => setAddStepFor(level);
  const levelLabel = (level: Level) => (stepsOnly ? 'this course' : `Level ${course.levels.findIndex(l => l.id === level.id) + 1}`);
  const viewAsStudent = () => {
    startStudentPreview({ page: 'v2-builder', courseId: course.id, label: course.title });
    openV2('v2-course', { courseId: course.id });
  };
  const editFromMap = (level: Level, step?: Step) => {
    setTab('build');
    setExpanded(s => new Set(s).add(level.id));
    if (step) setOpenStep(step.id);
    window.setTimeout(() => document.getElementById(step ? `step-${step.id}` : `level-${level.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
  };
  const askDeleteLevel = (level: Level) => setConfirm({
    title: `Remove ${level.code}?`, label: 'Remove level',
    text: `${level.code}${level.description ? ` (${level.description})` : ''} and its ${plural(level.steps.length, 'step')} will be removed. If any student has already worked on it, it is hidden instead, so nothing of theirs is lost.`,
    run: async () => { try { await apiFetch(`/v2/levels/${level.id}`, { method: 'DELETE' }); await load(true); toast(`${level.code} removed.`); } catch (err) { toast(errorText(err), { tone: 'error' }); } },
  });
  const askDeleteStep = (level: Level, step: Step) => setConfirm({
    title: `Remove ${level.code} · ${step.code}?`, label: 'Remove step',
    text: `“${step.title || step.code}” and its files will be removed. If any student has already worked on it, it is hidden instead.`,
    run: async () => { try { await apiFetch(`/v2/steps/${step.id}`, { method: 'DELETE' }); await load(true); toast(`${step.code} removed.`); } catch (err) { toast(errorText(err), { tone: 'error' }); } },
  });

  const bulk = async (patch: StepPatch, text: string) => {
    const ids = Array.from(selected);
    allSteps.filter(s => selected.has(s.id)).forEach(s => replaceStep(s.id, patch));
    try {
      await apiFetch('/v2/steps/bulk', { method: 'POST', body: { stepIds: ids, patch } });
      toast(`${text} · ${plural(ids.length, 'step')}.`);
      void load(true);
    } catch (err) { toast(errorText(err), { tone: 'error' }); void load(true); }
  };

  const jumpTo = (issue: HealthIssue) => {
    setTab('build');
    if (issue.levelId) setExpanded(s => new Set(s).add(issue.levelId!));
    if (issue.stepId) {
      const lvl = course.levels.find(l => l.steps.some(s => s.id === issue.stepId));
      if (lvl) setExpanded(s => new Set(s).add(lvl.id));
      setFocusStep(issue.stepId);
    }
    window.setTimeout(() => document.getElementById(issue.stepId ? `step-${issue.stepId}` : `level-${issue.levelId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
  };

  const status = STATUS_INFO[course.status];
  const issues = health ?? [];
  const errorsCount = issues.filter(i => i.severity !== 'info').length;
  const branchNames = course.branchIds.length ? course.branchIds.map(id => branches.find(b => b.id === id)?.name ?? id).join(', ') : 'All branches';
  const totalFiles = allSteps.reduce((n, s) => n + s.files.length, 0);

  return (
    <div className="v2-detail">
      <button type="button" className="v2-back" onClick={onBack}><ArrowLeft size={15} /> All courses</button>

      <section className="v2-course-hero">
        <div className="v2-course-hero-main">
          <div className="v2-course-hero-tags">
            <span className="v2-code-tag">{course.code ?? 'No code'}</span>
            <span className={status.chip}>{status.label}</span>
            {course.penType && <span className="chip chip-blue">{penLabel(course.penType)}</span>}
            {courseType && <span className="chip chip-blue">{courseType.label}</span>}
          </div>
          <h1>{course.title}</h1>
          {course.titleAr && <p className="v2-ar v2-hero-ar" dir="rtl">{course.titleAr}</p>}
          <p className="v2-hero-meta">
            {!stepsOnly && <>{plural(course.levels.length, 'level')} · </>}{plural(allSteps.length, 'step')} · {plural(totalFiles, 'file')} · {branchNames}
            {course.mistarSizes.length > 0 && <> · {course.mistarSizes.map(sizeLabel).join(', ')}</>}
          </p>
        </div>
        <div className="v2-course-hero-side">
          <div className="v2-status-box">
            <span className="v2-mini-label">Who can see it</span>
            <Segmented<CourseStatus>
              label="Course status"
              size="sm"
              value={course.status}
              disabled={!canEdit}
              options={(['draft', 'published', 'held', 'hidden'] as CourseStatus[]).map(s => ({ value: s, label: STATUS_INFO[s].label, hint: STATUS_INFO[s].text }))}
              onChange={s => { if (s !== course.status) void patchCourse({ status: s }, `Course is now ${STATUS_INFO[s].label}.`, { status: course.status }); }}
            />
            <p className="v2-status-text">{status.text}</p>
            <div className="v3-cert-switch">
              <div className="v3-switch-line">
              <Switch
                id="v3-cert-ready"
                checked={Boolean(course.certificationReady)}
                disabled={!canEdit}
                label="Course complete — certificate can be given"
                onChange={v => void patchCourse({ certificationReady: v } as Partial<CourseDetail>, v ? 'Students who finish every level now receive the certificate.' : 'Certificate paused — the course is still being built.')}
              />
              <label htmlFor="v3-cert-ready"><Award size={13} aria-hidden="true" /> Course complete — certificate can be given</label>
              </div>
              <p className="v2-help">{course.certificationReady ? 'Students who pass every level get the course badge and certificate.' : 'Keep off while levels are still being added, so nobody gets the certificate too early.'}</p>
            </div>
          </div>
          <div className="v2-hero-actions">
            <button type="button" className="btn btn-outline v2-btn-sm" onClick={viewAsStudent}><Eye size={14} /> View as student</button>
            {canEdit && <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => setShowCopy(true)}><Copy size={14} /> Copy course</button>}
          </div>
        </div>
      </section>

      {!canEdit && <ReadOnlyBanner>Only the Nairobi team can change courses. You can look around and preview it as a student.</ReadOnlyBanner>}
      {blockMsg && (
        <div className="v2-error v3-block" role="alert">
          <AlertTriangle size={16} />
          <span>{blockMsg}</span>
          <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => { setTab('health'); setBlockMsg(null); }}>Show me what to fix</button>
          <button type="button" className="v2-icon-btn" aria-label="Close" onClick={() => setBlockMsg(null)}><X size={16} /></button>
        </div>
      )}

      <div className="v2-tabs" role="tablist" aria-label="Course sections">
        {([
          ['map', 'Course map', <MapIcon size={15} key="i" />],
          ['build', 'Levels & steps', <Layers size={15} key="i" />],
          ['details', 'Details', <Settings2 size={15} key="i" />],
          ['health', 'Health', <ListChecks size={15} key="i" />],
          ['history', 'History', <History size={15} key="i" />],
        ] as [Tab, string, JSX.Element][]).map(([key, label, icon]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {icon}{label}{key === 'health' && errorsCount > 0 && <span className="v2-tab-count">{errorsCount}</span>}
          </button>
        ))}
      </div>

      {tab === 'build' && (
        <>
          {canEdit && <IngestPanel scope={{ courseCode: course.code }} fileCodes={fileCodes} onDone={() => { void load(true); onChanged(); }} />}

          {course.levels.length === 0 ? (
            <EmptyState
              icon={<Layers size={26} />}
              title={stepsOnly ? 'No steps yet' : 'No levels yet'}
              text={stepsOnly
                ? <>Drop your first files above — names like <code>{course.code ?? 'CRS-A101'}_MT_S01_P01_NP_v1.jpg</code> create the steps by themselves. Or add a step by hand.</>
                : <>Drop your first files above — names like <code>{course.code ?? 'FNK-C101'}_MT_LV01_S01_P01_07_v1.jpg</code> create levels and steps by themselves. Or add a level by hand.</>}
            >
              {canEdit && <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => void (stepsOnly ? addFirstStep() : addLevel())}><Plus size={14} /> {stepsOnly ? 'Add step by hand' : 'Add level by hand'}</button>}
              {canEdit && <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => setShowManifest(true)}><FileSpreadsheet size={14} /> Bring task names from sheet</button>}
            </EmptyState>
          ) : (
            <>
              {!stepsOnly && (
                <div className="v2-levels-bar">
                  <span className="muted">{plural(course.levels.length, 'level')}{canEdit ? ' · drag to reorder' : ''}</span>
                  <button type="button" className="v2-link" onClick={() => setExpanded(e => (e.size === course.levels.length ? new Set() : new Set(course.levels.map(l => l.id))))}>
                    {expanded.size === course.levels.length ? 'Fold all' : 'Open all'}
                  </button>
                </div>
              )}
              <div className="v2-levels">
                {course.levels.map(level => (
                  <LevelCard
                    key={level.id}
                    course={course}
                    level={level}
                    stepsOnly={stepsOnly}
                    open={stepsOnly || expanded.has(level.id)}
                    onToggle={() => setExpanded(s => { const n = new Set(s); if (n.has(level.id)) n.delete(level.id); else n.add(level.id); return n; })}
                    canEdit={canEdit}
                    fileCodes={fileCodes}
                    typeOptions={typeOptions}
                    stepTypes={stepTypes}
                    selected={selected}
                    setSelected={setSelected}
                    focusStep={focusStep}
                    onPatchLevel={(patch, text) => void patchLevel(level, patch, text)}
                    onPatchStep={(step, patch) => void patchStep(step, patch)}
                    onDeleteLevel={() => askDeleteLevel(level)}
                    onDeleteStep={step => askDeleteStep(level, step)}
                    onAddStep={() => addStep(level)}
                    designs={designs}
                    openStep={openStep}
                    onStepReplaced={fresh => replaceStep(fresh.id, fresh)}
                    onReload={() => { void load(true); onChanged(); }}
                    drag={drag}
                    setDrag={setDrag}
                    onLevelDrop={targetId => { if (drag?.kind === 'level') { const next = dropBefore(course.levels.map(l => l.id), drag.id, targetId); if (next) void reorderLevels(next); } setDrag(null); }}
                    onLevelMove={delta => { const next = moveInList(course.levels.map(l => l.id), level.id, delta); if (next) void reorderLevels(next); }}
                    onStepDrop={targetId => { if (drag?.kind === 'step' && drag.levelId === level.id) { const next = dropBefore(level.steps.map(s => s.id), drag.id, targetId); if (next) void reorderSteps(level, next); } setDrag(null); }}
                    onStepMove={(stepId, delta) => { const next = moveInList(level.steps.map(s => s.id), stepId, delta); if (next) void reorderSteps(level, next); }}
                  />
                ))}
              </div>
              {canEdit && !stepsOnly && <button type="button" className="v2-add-row" onClick={() => void addLevel()}><Plus size={16} /> Add level</button>}
            </>
          )}
        </>
      )}

      {tab === 'map' && (
        <CourseMap
          course={course}
          stepTypes={stepTypes}
          stepsOnly={stepsOnly}
          courseTypeLabel={courseType?.label ?? null}
          designs={designs}
          canEdit={canEdit}
          onEditStep={(level, step) => editFromMap(level, step)}
          onEditLevel={level => editFromMap(level)}
        />
      )}
      {tab === 'details' && <DetailsForm designs={designs} course={course} canEdit={canEdit} courseTypes={courseTypes} branches={branches} onSaved={() => { void load(true); onChanged(); }} onManifest={() => setShowManifest(true)} />}
      {tab === 'health' && <HealthList issues={health} onJump={jumpTo} onRefresh={() => void load(true)} />}
      {tab === 'history' && <HistoryList courseId={course.id} canEdit={canEdit} onUndone={() => void load(true)} />}

      {selected.size > 0 && canEdit && <BulkBar count={selected.size} typeOptions={typeOptions} onClear={() => setSelected(new Set())} onApply={(p, t) => void bulk(p, t)} />}
      {selected.size === 0 && (
        <div className="v2-mobile-bar">
          <button type="button" className="btn btn-outline v2-btn-sm" onClick={viewAsStudent}><Eye size={14} /> Student view</button>
          {canEdit && <button type="button" className="btn btn-primary v2-btn-sm" onClick={() => { setTab('build'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><Plus size={14} /> Add files</button>}
        </div>
      )}

      {addStepFor && (
        <AddStepDialog
          level={addStepFor}
          levelLabel={levelLabel(addStepFor)}
          typeOptions={typeOptions}
          courseTypeLabel={courseType?.label ?? null}
          onClose={() => setAddStepFor(null)}
          onAdded={st => { setExpanded(x => new Set(x).add(st.levelId)); setOpenStep(st.id); void load(true); onChanged(); }}
        />
      )}
      {confirm && <ConfirmDialog title={confirm.title} text={confirm.text} confirmLabel={confirm.label} danger onConfirm={confirm.run} onClose={() => setConfirm(null)} />}
      {showCopy && <CopyCourseDialog course={course} onClose={() => setShowCopy(false)} onCopied={id => { onChanged(); onOpenCourse(id); }} />}
      {showManifest && <ManifestImportDialog courseId={course.id} courseCode={course.code} onClose={() => setShowManifest(false)} onApplied={() => void load(true)} />}
    </div>
  );
}

/* ---------------- Level card ---------------- */

function LevelCard(props: {
  course: CourseDetail; level: Level; stepsOnly: boolean; open: boolean; onToggle: () => void; canEdit: boolean; fileCodes: FileCodeDef[] | null;
  typeOptions: StepTypeDef[]; stepTypes: StepTypeDef[]; selected: Set<string>; setSelected: React.Dispatch<React.SetStateAction<Set<string>>>; focusStep: string | null;
  onPatchLevel: (patch: LevelPatch, text?: string) => void;
  onPatchStep: (step: Step, patch: StepPatch) => void; onDeleteLevel: () => void; onDeleteStep: (step: Step) => void; onAddStep: () => void; onReload: () => void;
  designs: BadgeDesign[] | null; openStep: string | null; onStepReplaced: (step: Step) => void;
  drag: { kind: 'level' | 'step'; id: string; levelId?: string } | null; setDrag: (d: { kind: 'level' | 'step'; id: string; levelId?: string } | null) => void;
  onLevelDrop: (targetId: string) => void; onLevelMove: (delta: number) => void; onStepDrop: (targetId: string) => void; onStepMove: (stepId: string, delta: number) => void;
}) {
  const { course, level, stepsOnly, open, canEdit, selected, setSelected } = props;
  const [description, setDescription] = useState(level.description ?? '');
  const [instructions, setInstructions] = useState(level.instructions ?? '');
  const [badge, setBadge] = useState(level.badgeCode ?? '');
  const [saved, setSaved] = useState<string | null>(null);
  const [seen, setSeen] = useState(level);
  if (seen !== level) { setSeen(level); setDescription(level.description ?? ''); setInstructions(level.instructions ?? ''); setBadge(level.badgeCode ?? ''); }

  const levelDesigns = (props.designs ?? []).filter(d => d.kind === 'level' && !d.badgeCode);
  const defaultDesign = levelDesigns.find(d => d.isDefault) ?? null;
  const hidden = level.status === 'hidden';
  const files = level.steps.reduce((n, s) => n + s.files.length, 0);
  const missing = level.steps.reduce((n, s) => n + s.missing.length, 0);
  const allSelected = level.steps.length > 0 && level.steps.every(s => selected.has(s.id));
  const flash = (what: string) => { setSaved(what); window.setTimeout(() => setSaved(null), 1600); };

  const saveDescription = () => { if ((description.trim() || null) !== (level.description ?? null)) { props.onPatchLevel({ description: description.trim() || null }); flash('Description saved'); } };
  const saveInstructions = () => { if ((instructions.trim() || null) !== (level.instructions ?? null)) { props.onPatchLevel({ instructions: instructions.trim() || null }); flash('Instructions saved'); } };
  const isLevelDragTarget = props.drag?.kind === 'level' && props.drag.id !== level.id;

  return (
    <article
      id={`level-${level.id}`}
      className={`v2-level${open ? ' is-open' : ''}${hidden ? ' is-hidden' : ''}${props.drag?.kind === 'level' && props.drag.id === level.id ? ' is-dragging' : ''}${stepsOnly ? ' is-plain' : ''}`}
      onDragOver={e => { if (isLevelDragTarget) e.preventDefault(); }}
      onDrop={e => { if (props.drag?.kind === 'level') { e.preventDefault(); props.onLevelDrop(level.id); } }}
    >
      {!stepsOnly && (
        <header className="v2-level-head">
          {canEdit && (
            <button
              type="button"
              className="v2-handle"
              draggable
              onDragStart={e => { props.setDrag({ kind: 'level', id: level.id }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', level.id); }}
              onDragEnd={() => props.setDrag(null)}
              onKeyDown={e => { if (e.key === 'ArrowUp') { e.preventDefault(); props.onLevelMove(-1); } if (e.key === 'ArrowDown') { e.preventDefault(); props.onLevelMove(1); } }}
              aria-label={`Move ${level.code}. Drag, or use arrow up or down.`}
              title="Drag to reorder"
            ><GripVertical size={16} /></button>
          )}
          <button type="button" className="v2-level-toggle" aria-expanded={open} onClick={props.onToggle}>
            <span className="v2-level-code">{level.code}</span>
            <span className="v2-level-title">
              <strong dir="auto">{level.description || <span className="muted">Add a description</span>}</strong>
              <small>{plural(level.steps.length, 'step')} · {plural(files, 'file')}{missing > 0 && <span className="v2-warn"> · {missing} missing</span>}{hidden && ' · hidden from students'}</small>
            </span>
            <ChevronDown size={18} className="v2-level-chev" />
          </button>
          <button
            type="button"
            className={`v2-icon-btn v2-eye${hidden ? ' off' : ''}`}
            disabled={!canEdit}
            aria-label={hidden ? `Show ${level.code} to students` : `Hide ${level.code} from students`}
            title={hidden ? 'Hidden from students — tap to show' : 'Visible to students — tap to hide'}
            onClick={() => props.onPatchLevel({ status: hidden ? 'published' : 'hidden' }, hidden ? `${level.code} visible to students.` : `${level.code} hidden from students.`)}
          >{hidden ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        </header>
      )}

      {open && (
        <div className="v2-level-body">
          {!stepsOnly && (
            <div className="v2-level-fields">
              <label className="field-label">Description
                <input className="field" dir="auto" value={description} disabled={!canEdit} placeholder="e.g. مفردات" onChange={e => setDescription(e.target.value)} onBlur={saveDescription} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
              </label>
              <div className="field-label">
                <label htmlFor={`bd-${level.id}`} className="v3-icon-label"><Award size={13} aria-hidden="true" /> {BADGE_KIND_LABEL.level} <span className="v2-optional">given when this level is passed</span></label>
                <select
                  id={`bd-${level.id}`}
                  className="field"
                  disabled={!canEdit}
                  value={(level as LevelV3).badgeDesignId ?? ''}
                  onChange={e => { props.onPatchLevel({ badgeDesignId: e.target.value || null }); flash('Badge saved'); }}
                >
                  <option value="">Usual: {defaultDesign ? defaultDesign.name : 'Funun al-Quran seal'}</option>
                  {levelDesigns.filter(d => !d.isDefault).map(d => <option key={d.id} value={d.id}>{d.name}{d.imageUrl ? '' : ' (no artwork yet)'}</option>)}
                </select>
                <details className="v3-adv">
                  <summary>Badge code (advanced)</summary>
                  <input className="field" value={badge} disabled={!canEdit} placeholder={`BDG_${course.code ?? 'CODE'}_${level.code}`} aria-label="Badge code" onChange={e => setBadge(e.target.value)} onBlur={() => { if ((badge.trim() || null) !== (level.badgeCode ?? null)) { props.onPatchLevel({ badgeCode: badge.trim() || null }); flash('Badge saved'); } }} />
                </details>
              </div>
              <div className="field-label v2-instructions">
                <div className="v2-instructions-head">
                  <label htmlFor={`instr-${level.id}`}>Instructions to students</label>
                  {canEdit && !instructions.trim() && <button type="button" className="v2-link" onClick={() => { setInstructions(TYPICAL_INSTRUCTIONS); props.onPatchLevel({ instructions: TYPICAL_INSTRUCTIONS }); flash('Instructions saved'); }}><Plus size={13} /> Use the usual four steps</button>}
                </div>
                <textarea
                  id={`instr-${level.id}`}
                  className="field v2-textarea"
                  dir="auto"
                  rows={4}
                  value={instructions}
                  disabled={!canEdit}
                  placeholder={course.instructions || TYPICAL_INSTRUCTIONS}
                  onChange={e => setInstructions(e.target.value)}
                  onBlur={saveInstructions}
                  onKeyDown={e => {
                    // Enter on a numbered line continues the numbering
                    if (e.key !== 'Enter' || e.shiftKey) return;
                    const ta = e.currentTarget;
                    const before = ta.value.slice(0, ta.selectionStart);
                    const line = before.split('\n').pop() ?? '';
                    const m = /^(\d+)\.\s/.exec(line);
                    if (!m) return;
                    e.preventDefault();
                    const insert = `\n${Number(m[1]) + 1}. `;
                    const next = before + insert + ta.value.slice(ta.selectionEnd);
                    setInstructions(next);
                    window.requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = before.length + insert.length; });
                  }}
                />
                <small className="v2-help">One line per thing to do. Students see this at the top of {level.code}. {saved && <span className="v2-saved"><CheckCircle2 size={12} /> {saved}</span>}</small>
              </div>
            </div>
          )}

          {canEdit && <IngestPanel variant="level" scope={{ courseCode: course.code, levelCode: level.code }} fileCodes={props.fileCodes} onDone={props.onReload} />}

          {level.steps.length > 0 ? (
            <div className="v2-steps" role="table" aria-label={`Steps of ${level.code}`}>
              <div className="v2-step-head" role="row">
                <label className="v2-check"><input type="checkbox" disabled={!canEdit} checked={allSelected} aria-label={`Select all steps of ${level.code}`} onChange={e => setSelected(s => { const n = new Set(s); level.steps.forEach(st => (e.target.checked ? n.add(st.id) : n.delete(st.id))); return n; })} /></label>
                <span />
                <span>Step</span><span>Task</span><span>Type</span><span>Marks</span><span>Badge</span><span>Files</span><span>Show</span><span />
              </div>
              {level.steps.map(step => (
                <div key={step.id} id={`step-${step.id}`} className={props.focusStep === step.id ? 'v2-focus-flash' : ''}>
                  <StepRow
                    course={course}
                    level={level}
                    step={step}
                    typeOptions={props.typeOptions}
                    stepTypes={props.stepTypes}
                    selected={selected.has(step.id)}
                    onSelect={v => setSelected(s => { const n = new Set(s); if (v) n.add(step.id); else n.delete(step.id); return n; })}
                    onPatch={patch => props.onPatchStep(step, patch)}
                    onDelete={() => props.onDeleteStep(step)}
                    canEdit={canEdit}
                    onReload={props.onReload}
                    isDragging={props.drag?.kind === 'step' && props.drag.id === step.id}
                    forceOpen={props.openStep === step.id}
                    onStepReplaced={props.onStepReplaced}
                    onMove={delta => props.onStepMove(step.id, delta)}
                    dragProps={canEdit ? {
                      draggable: true,
                      onDragStart: e => { if ((e.target as HTMLElement).closest('input,select,textarea')) { e.preventDefault(); return; } e.stopPropagation(); props.setDrag({ kind: 'step', id: step.id, levelId: level.id }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', step.id); },
                      onDragEnd: () => props.setDrag(null),
                      onDragOver: e => { if (props.drag?.kind === 'step' && props.drag.levelId === level.id) { e.preventDefault(); e.stopPropagation(); } },
                      onDrop: e => { if (props.drag?.kind === 'step') { e.preventDefault(); e.stopPropagation(); props.onStepDrop(step.id); } },
                    } : {}}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="v2-help v2-steps-empty">No steps in {level.code} yet. Drop files named …_{level.code}_S01_… above, or add a step by hand.</p>
          )}

          {canEdit && (
            <div className="v2-level-foot">
              <button type="button" className="btn btn-outline v2-btn-sm" onClick={props.onAddStep}><Plus size={14} /> Add step</button>
              {!stepsOnly && <button type="button" className="v2-link v2-danger-link" onClick={props.onDeleteLevel}><Trash2 size={14} /> Remove level</button>}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/* ---------------- Bulk bar ---------------- */

function BulkBar({ count, typeOptions, onClear, onApply }: { count: number; typeOptions: StepTypeDef[]; onClear: () => void; onApply: (patch: StepPatch, text: string) => void }) {
  const [dialog, setDialog] = useState<null | 'type' | 'marks' | 'message' | 'badge'>(null);
  const [value, setValue] = useState('');
  const open = (d: typeof dialog, initial = '') => { setValue(initial); setDialog(d); };
  const apply = () => {
    if (dialog === 'type') onApply({ stepType: value }, `Type set to ${typeOptions.find(t => t.typeKey === value)?.label ?? value}`);
    if (dialog === 'marks') onApply({ maxMarks: value === '' ? null : Number(value) }, `Marks set to ${value || 'none'}`);
    if (dialog === 'message') onApply({ message: value.trim() || null }, value.trim() ? 'Message added' : 'Message cleared');
    if (dialog === 'badge') onApply({ badgeCode: value.trim() || null }, 'Badge set');
    setDialog(null);
  };
  return (
    <div className="v2-bulkbar" role="region" aria-label="Change selected steps">
      <strong>{plural(count, 'step')} selected</strong>
      <div className="v2-bulk-actions">
        <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => open('type', typeOptions[0]?.typeKey ?? '')}>Type</button>
        <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => open('marks', '10')}>Marks</button>
        <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => open('message')}>Message</button>
        <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => open('badge')}>Badge</button>
        <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => onApply({ status: 'hidden' }, 'Hidden from students')}><EyeOff size={14} /> Hide</button>
        <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => onApply({ status: 'published' }, 'Visible to students')}><Eye size={14} /> Show</button>
      </div>
      <button type="button" className="v2-icon-btn" aria-label="Clear selection" onClick={onClear}><X size={18} /></button>
      {dialog && (
        <Dialog
          title={{ type: 'Set the type', marks: 'Set the marks', message: 'Message to students', badge: 'Set the badge' }[dialog]}
          eyebrow={`For ${plural(count, 'step')}`}
          onClose={() => setDialog(null)}
          footer={<><button type="button" className="btn btn-outline" onClick={() => setDialog(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={apply}>Apply to {plural(count, 'step')}</button></>}
        >
          {dialog === 'type' && (
            <div className="v2-choice-list">
              {typeOptions.map(t => (
                <label key={t.typeKey} className={`v2-choice${value === t.typeKey ? ' active' : ''}`}>
                  <input type="radio" name="bulk-type" checked={value === t.typeKey} onChange={() => setValue(t.typeKey)} />
                  <span><strong>{t.label}</strong><small>{experienceLine(t)}</small></span>
                </label>
              ))}
            </div>
          )}
          {dialog === 'marks' && <label className="field-label">Out of<input className="field" inputMode="numeric" value={value} onChange={e => setValue(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))} /></label>}
          {dialog === 'message' && <label className="field-label">Message<textarea className="field v2-textarea" dir="auto" value={value} placeholder="Leave empty to remove the message" onChange={e => setValue(e.target.value)} /></label>}
          {dialog === 'badge' && <label className="field-label">Badge code<input className="field" value={value} placeholder="Leave empty for the level’s own badge" onChange={e => setValue(e.target.value)} /></label>}
        </Dialog>
      )}
    </div>
  );
}

export function experienceLine(t: StepTypeDef): string {
  const action = t.studentAction === 'watch_download' ? 'Students watch, download and tick “done”' : t.studentAction === 'upload' ? 'Students upload their work' : 'Students download a sheet, then upload';
  const fb = t.feedbackMode === 'none' ? 'no teacher check' : t.feedbackMode === 'feedback' ? 'the teacher replies with comments' : 'the teacher marks it on the photo';
  const marks = t.hasMarks ? ', marked 1–10' : '';
  const gate = t.gatesProgress ? '; must pass to open the next level' : '';
  return `${action}; ${fb}${marks}${gate}.`;
}

/* ---------------- Details ---------------- */

function DetailsForm({ course, canEdit, courseTypes, branches, onSaved, onManifest, designs }: { course: CourseV3; canEdit: boolean; courseTypes: CourseTypeDef[]; branches: Branch[]; onSaved: () => void; onManifest: () => void; designs: BadgeDesign[] | null }) {
  const initial = useMemo(() => ({
    title: course.title, titleAr: course.titleAr ?? '', description: course.description ?? '', instructions: course.instructions ?? '',
    penType: course.penType ?? '', courseType: course.courseType ?? '', mistarSizes: course.mistarSizes, driveFolderUrl: course.driveFolderUrl ?? '', branchIds: course.branchIds,
    badgeDesignId: course.badgeDesignId ?? '',
  }), [course]);
  const courseDesigns = (designs ?? []).filter(d => d.kind === 'course' && !d.badgeCode);
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(initial), [initial]);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }));
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

  const save = async () => {
    setBusy(true);
    try {
      const { branchIds, ...rest } = f;
      await apiFetch(`/v2/courses/${course.id}`, {
        method: 'PATCH',
        body: { ...rest, badgeDesignId: rest.badgeDesignId || null, titleAr: rest.titleAr || null, description: rest.description || null, instructions: rest.instructions || null, penType: rest.penType || null, courseType: rest.courseType || null, driveFolderUrl: rest.driveFolderUrl || null },
      });
      if (JSON.stringify(branchIds) !== JSON.stringify(initial.branchIds)) await apiFetch(`/v2/courses/${course.id}/branches`, { method: 'PUT', body: { branchIds } });
      toast('Course details saved.');
      onSaved();
    } catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusy(false); }
  };

  return (
    <section className="v2-card v2-details-form">
      <div className="v2-grid-2">
        <label className="field-label">Course name<input className="field" value={f.title} disabled={!canEdit} onChange={e => set('title', e.target.value)} /></label>
        <label className="field-label">Arabic name<input className="field v2-ar-input" dir="rtl" value={f.titleAr} disabled={!canEdit} onChange={e => set('titleAr', e.target.value)} /></label>
        <label className="field-label">Pen type
          <select className="field" value={f.penType} disabled={!canEdit} onChange={e => set('penType', e.target.value)}>
            <option value="">—</option><option value="normal">Normal pen</option><option value="cut">Cut pen</option>
            {f.penType && !['normal', 'cut'].includes(f.penType) && <option value={f.penType}>{f.penType}</option>}
          </select>
        </label>
        <label className="field-label">Course type
          <select className="field" value={f.courseType} disabled={!canEdit} onChange={e => set('courseType', e.target.value)}>
            <option value="">—</option>
            {courseTypes.map(t => <option key={t.typeKey} value={t.typeKey}>{t.label}</option>)}
          </select>
        </label>
      </div>
      <label className="field-label">Description<textarea className="field v2-textarea" dir="auto" value={f.description} disabled={!canEdit} onChange={e => set('description', e.target.value)} /></label>
      <label className="field-label">Usual instructions for every level <span className="v2-optional">used when a level has none</span><textarea className="field v2-textarea" dir="auto" value={f.instructions} disabled={!canEdit} placeholder={TYPICAL_INSTRUCTIONS} onChange={e => set('instructions', e.target.value)} /></label>
      <div className="field-label">Mistar sizes
        <div className="v2-chip-toggles">
          {SIZE_CODES.map(s => <button key={s} type="button" disabled={!canEdit} aria-pressed={f.mistarSizes.includes(s)} className={f.mistarSizes.includes(s) ? 'on' : ''} onClick={() => set('mistarSizes', toggle(f.mistarSizes, s))}>{sizeLabel(s)}</button>)}
        </div>
      </div>
      <div className="field-label">Branches <span className="v2-optional">{f.branchIds.length ? '' : 'none ticked = all branches'}</span>
        <div className="v2-chip-toggles">
          {branches.map(b => <button key={b.id} type="button" disabled={!canEdit} aria-pressed={f.branchIds.includes(b.id)} className={f.branchIds.includes(b.id) ? 'on' : ''} onClick={() => set('branchIds', toggle(f.branchIds, b.id))}>{b.name}</button>)}
          {!branches.length && <span className="muted">Branches could not be loaded.</span>}
        </div>
      </div>
      <label className="field-label"><span className="v3-icon-label"><Award size={13} aria-hidden="true" /> {BADGE_KIND_LABEL.course}</span> <span className="v2-optional">given when the whole course is completed</span>
        <select className="field" value={f.badgeDesignId} disabled={!canEdit} onChange={e => set('badgeDesignId', e.target.value)}>
          <option value="">Usual: {courseDesigns.find(d => d.isDefault)?.name ?? 'Funun al-Quran seal'}</option>
          {courseDesigns.filter(d => !d.isDefault).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      <label className="field-label">Drive folder<input className="field" inputMode="url" value={f.driveFolderUrl} disabled={!canEdit} placeholder="https://drive.google.com/drive/folders/…" onChange={e => set('driveFolderUrl', e.target.value)} /></label>
      {course.masterRow && (
        <details className="v2-details">
          <summary>Row in the Master Course List</summary>
          <dl className="v2-dl">{Object.entries(course.masterRow).filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        </details>
      )}
      {canEdit && (
        <div className="v2-form-foot">
          <button type="button" className="btn btn-outline v2-btn-sm" onClick={onManifest}><FileSpreadsheet size={14} /> Bring task names from sheet</button>
          <span className="v2-grow" />
          {dirty && <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => setF(initial)}>Undo changes</button>}
          <button type="button" className="btn btn-primary" disabled={!dirty || busy || !f.title.trim()} onClick={() => void save()}>{busy ? 'Saving…' : dirty ? 'Save details' : 'Saved'}</button>
        </div>
      )}
    </section>
  );
}

/* ---------------- Health + history ---------------- */

function HealthList({ issues, onJump, onRefresh }: { issues: HealthIssue[] | null; onJump: (i: HealthIssue) => void; onRefresh: () => void }) {
  if (!issues) return <ErrorBox message="The health check could not be loaded." onRetry={onRefresh} />;
  if (!issues.length) return <EmptyState icon={<CheckCircle2 size={26} />} title="All good" text="Nothing is missing. Every step has what students need." />;
  const order = { error: 0, warning: 1, info: 2 } as const;
  return (
    <ul className="v2-health">
      {[...issues].sort((a, b) => order[a.severity] - order[b.severity]).map((i, n) => (
        <li key={n} className={`sev-${i.severity}`}>
          {i.severity === 'info' ? <Info size={16} /> : <AlertTriangle size={16} />}
          <span>{i.message}</span>
          {(i.stepId || i.levelId) && <button type="button" className="v2-link" onClick={() => onJump(i)}>Show me</button>}
        </li>
      ))}
    </ul>
  );
}

function HistoryList({ courseId, canEdit, onUndone }: { courseId: string; canEdit: boolean; onUndone: () => void }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { setError(null); apiFetch<AuditEntry[]>(`/v2/audit?courseId=${encodeURIComponent(courseId)}&limit=80`).then(setRows).catch(err => setError(errorText(err))); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [courseId]);
  if (error) return <ErrorBox message={error} onRetry={load} />;
  if (!rows) return <Loading label="Loading history…" />;
  if (!rows.length) return <EmptyState icon={<History size={26} />} title="No changes yet" text="Every change to this course will be listed here, with who made it. Most changes can be undone." />;
  const undo = async (id: string) => {
    try { await apiFetch(`/v2/audit/${id}/undo`, { method: 'POST' }); toast('Change undone.'); load(); onUndone(); }
    catch (err) { toast(errorText(err), { tone: 'error' }); }
  };
  return (
    <ul className="v2-history">
      {rows.map(r => (
        <li key={r.id}>
          <span className="v2-history-dot" aria-hidden="true" />
          <div>
            <p>{r.summary}</p>
            <small>{r.actorName ?? 'System'} · {formatDate(r.createdAt, true)}</small>
          </div>
          {canEdit && r.canUndo && <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => void undo(r.id)}><Undo2 size={14} /> Undo</button>}
        </li>
      ))}
    </ul>
  );
}

function CopyCourseDialog({ course, onClose, onCopied }: { course: CourseDetail; onClose: () => void; onCopied: (id: string) => void }) {
  const [code, setCode] = useState('');
  const [title, setTitle] = useState(`${course.title} (copy)`);
  const [busy, setBusy] = useState(false);
  const valid = /^[A-Za-z]{2,5}-[A-Za-z]\d{3}$/.test(code.trim());
  const run = async () => {
    setBusy(true);
    try {
      const created = await apiFetch<CourseDetail>(`/v2/courses/${course.id}/copy`, { method: 'POST', body: { code: code.trim().toUpperCase(), title: title.trim() } });
      toast(`Copied as ${created.code ?? code.toUpperCase()} — it starts as Draft.`);
      onClose();
      onCopied(created.id);
    } catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <Dialog
      title="Copy this course"
      eyebrow={course.code ?? undefined}
      onClose={onClose}
      footer={<><button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!valid || !title.trim() || busy} onClick={() => void run()}>{busy ? 'Copying…' : 'Make the copy'}</button></>}
    >
      <p className="v2-help">Levels, steps, instructions, messages and files are copied. The copy starts as Draft, so students see nothing until you publish it.</p>
      <label className="field-label">New course code<input className="field" value={code} placeholder="e.g. FNK-C102" onChange={e => setCode(e.target.value)} /></label>
      {code && !valid && <p className="v2-bad v2-help">A code looks like FNK-C102 — letters, a dash, one letter and three numbers.</p>}
      <label className="field-label">Course name<input className="field" value={title} onChange={e => setTitle(e.target.value)} /></label>
    </Dialog>
  );
}
