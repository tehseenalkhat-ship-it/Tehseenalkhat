import { useState } from 'react';
import { Award, CheckCircle2, ChevronRight, CircleAlert, FileText, Image as ImageIcon, MessageSquareText, Pencil, Upload, Video } from 'lucide-react';
import type { Level, Step, StepFile, StepTypeDef } from '../contracts';
import { BADGE_KIND_LABEL, youtubeId, type BadgeDesign, type CourseV3, type LevelV3 } from './builderTypes';
import { sizeLabel } from './naming';
import { plural } from './shared';

const SOURCE_LABEL: Record<StepFile['source'], string> = { upload: 'uploaded here', zip: 'from a ZIP', drive: 'from Drive', webhook: 'from the Drive portal' };

/** What one step holds, in plain words — used by the map and the step editor. */
export function stepContents(step: Step, typeDef: StepTypeDef | undefined, sizes: string[]) {
  const cur = step.files.filter(f => f.isCurrent !== false);
  const sheets = cur.filter(f => f.role === 'worksheet' || f.role === 'resource' || f.role === 'other');
  const refs = cur.filter(f => f.role === 'reference');
  const videoFiles = cur.filter(f => f.role === 'video');
  const assess = cur.filter(f => f.role === 'assessment_sheet');
  const hasSheetRole = typeDef?.studentAction !== 'upload';
  const sizeState = (sizes.length ? sizes : Array.from(new Set(sheets.map(f => f.sizeCode).filter(Boolean) as string[]))).map(s => ({
    size: s, ok: sheets.some(f => f.sizeCode === s || f.sizeCode === null),
  }));
  const sources = Array.from(new Set(cur.map(f => SOURCE_LABEL[f.source] ?? f.source)));
  return {
    video: Boolean(step.videoUrl) || videoFiles.length > 0,
    videoKind: step.videoUrl ? (youtubeId(step.videoUrl) ? 'YouTube' : 'link') : videoFiles.length ? 'file' : null,
    reference: refs.length,
    sheets: sheets.length,
    sizeState: hasSheetRole && step.stepType !== 'assessment' ? sizeState : [],
    assessment: step.stepType === 'assessment' ? assess.length : null,
    upload: typeDef ? typeDef.studentAction !== 'watch_download' : false,
    message: Boolean(step.message?.trim()),
    sources,
  };
}

function StepNode({ step, typeDef, sizes, canEdit, onEdit }: { step: Step; typeDef: StepTypeDef | undefined; sizes: string[]; canEdit: boolean; onEdit: () => void }) {
  const c = stepContents(step, typeDef, sizes);
  const problems = step.missing.length + (c.assessment === 0 ? 1 : 0);
  return (
    <li className={`v3-map-step${step.status === 'hidden' ? ' is-hidden' : ''}${problems ? ' has-problem' : ''}`}>
      <div className="v3-map-step-head">
        <span className="v2-code-tag">{step.code}</span>
        <strong>{step.title || <span className="muted">No task name</span>}</strong>
        <span className="v3-type-chip">{typeDef?.label ?? step.stepType}</span>
        {step.status === 'hidden' && <span className="v3-tag">Hidden</span>}
        <button type="button" className="v2-link v3-map-edit" onClick={onEdit}><Pencil size={13} /> {canEdit ? 'Edit' : 'Open'}</button>
      </div>
      <ul className="v3-map-contents" aria-label={`What is in ${step.code}`}>
        {c.video && <li className="ok"><Video size={13} /> Video{c.videoKind ? ` (${c.videoKind})` : ''}</li>}
        {c.reference > 0 && <li className="ok"><ImageIcon size={13} /> Reference image{c.reference > 1 ? ` ×${c.reference}` : ''}</li>}
        {c.sizeState.map(s => <li key={s.size} className={s.ok ? 'ok' : 'bad'}><FileText size={13} /> Worksheet {sizeLabel(s.size)}{s.ok ? '' : ' — missing'}</li>)}
        {!c.sizeState.length && c.sheets > 0 && <li className="ok"><FileText size={13} /> {plural(c.sheets, 'sheet')}</li>}
        {c.assessment !== null && <li className={c.assessment ? 'ok' : 'bad'}><FileText size={13} /> Assessment sheet{c.assessment ? '' : ' — missing'}</li>}
        {c.upload && <li className="info"><Upload size={13} /> Student uploads{typeDef?.hasMarks ? ' · marked out of 10' : ' · teacher replies'}</li>}
        {c.message && <li className="info"><MessageSquareText size={13} /> Message to students</li>}
        {!c.video && !c.reference && !c.sheets && c.assessment === null && !c.upload && <li className="bad"><CircleAlert size={13} /> Empty</li>}
      </ul>
      {c.sources.length > 0 && <small className="v3-map-source">Files {c.sources.join(', ')}</small>}
    </li>
  );
}

/**
 * Owner note 6.6: one cascading view — course → levels → steps → what is in each step.
 * Everything opens the editor below, so all of it stays editable.
 */
export function CourseMap({ course, stepTypes, stepsOnly, courseTypeLabel, designs, canEdit, onEditStep, onEditLevel }: {
  course: CourseV3; stepTypes: StepTypeDef[]; stepsOnly: boolean; courseTypeLabel: string | null; designs: BadgeDesign[] | null; canEdit: boolean;
  onEditStep: (level: Level, step: Step) => void; onEditLevel: (level: Level) => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const steps = course.levels.flatMap(l => l.steps);
  const problems = steps.reduce((n, s) => n + s.missing.length, 0);
  const typeOf = (k: string) => stepTypes.find(t => t.typeKey === k);
  const designName = (l: LevelV3) => {
    const d = designs?.find(x => x.id === l.badgeDesignId) ?? designs?.find(x => x.kind === 'level' && x.isDefault);
    return d ? d.name : 'Funun al-Quran seal';
  };
  const gating = (l: Level) => l.steps.some(s => typeOf(s.stepType)?.gatesProgress);

  return (
    <section className="v3-map" aria-label="Course map">
      <div className="v3-map-root">
        <div>
          <span className="v2-mini-label">Course map</span>
          <h2>{course.title}</h2>
          <p className="v2-help">
            {[courseTypeLabel, stepsOnly ? null : plural(course.levels.length, 'level'), plural(steps.length, 'step'), course.mistarSizes.length ? course.mistarSizes.map(sizeLabel).join(' · ') : null].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="v3-map-root-state">
          {problems ? <span className="v3-tag v3-tag-amber"><CircleAlert size={12} /> {plural(problems, 'thing')} missing</span> : <span className="v3-tag v3-tag-green"><CheckCircle2 size={12} /> Nothing missing</span>}
          <span className={`v3-tag${course.certificationReady ? ' v3-tag-green' : ''}`}><Award size={12} /> {course.certificationReady ? 'Certificate can be given' : 'Certificate not given yet'}</span>
        </div>
      </div>
      {course.levels.length === 0 && <p className="v3-badge-empty">Nothing here yet — add files or a level below.</p>}
      <ol className="v3-map-levels">
        {course.levels.map((level, i) => {
          const open = stepsOnly || !closed.has(level.id);
          const missing = level.steps.reduce((n, s) => n + s.missing.length, 0);
          return (
            <li key={level.id} className={`v3-map-level${level.status === 'hidden' ? ' is-hidden' : ''}`}>
              {!stepsOnly && (
                <div className="v3-map-level-head">
                  <button type="button" className="v3-map-toggle" aria-expanded={open} onClick={() => setClosed(s => { const n = new Set(s); if (n.has(level.id)) n.delete(level.id); else n.add(level.id); return n; })}>
                    <ChevronRight size={16} className="v3-map-chev" aria-hidden="true" />
                    <span className="v3-map-level-no">Level {i + 1}</span>
                    {level.description && <span className="v2-ar v3-map-ar" dir="auto">{level.description}</span>}
                  </button>
                  <span className="v3-map-level-meta">
                    {plural(level.steps.length, 'step')}
                    {' · '}{gating(level) ? 'assessment at the end' : 'no assessment'}
                    {' · '}<Award size={12} aria-hidden="true" /> {BADGE_KIND_LABEL.level}: {designName(level)}
                    {missing > 0 && <span className="v2-warn"> · {missing} missing</span>}
                    {level.status === 'hidden' && ' · hidden'}
                  </span>
                  <button type="button" className="v2-link" onClick={() => onEditLevel(level)}><Pencil size={13} /> {canEdit ? 'Edit level' : 'Open'}</button>
                </div>
              )}
              {open && (
                <ol className="v3-map-steps">
                  {level.steps.map(step => (
                    <StepNode key={step.id} step={step} typeDef={typeOf(step.stepType)} sizes={course.mistarSizes} canEdit={canEdit} onEdit={() => onEditStep(level, step)} />
                  ))}
                  {!level.steps.length && <li className="v3-map-empty">No steps yet</li>}
                </ol>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
