import { useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, FileSearch, FileText, Image as ImageIcon, QrCode, Upload, Video, X } from 'lucide-react';
import { apiFetch, getViewUrl, uploadFile } from '@/api';
import type { CourseDetail, Step, StepFile, StepTypeDef } from '../contracts';
import { openApiFile, youtubeId } from './builderTypes';
import { SIZE_CODES, sizeLabel } from './naming';
import { errorText, toast } from './shared';

type Role = 'worksheet' | 'reference' | 'assessment_sheet';

/**
 * Owner note 6.7: per step — YouTube video link, reference image, worksheet image(s),
 * and a preview of how the student's details are printed on every download.
 */
export function StepContents({ course, step, typeDef, canEdit, onVideo, onStep }: {
  course: CourseDetail; step: Step; typeDef: StepTypeDef | undefined; canEdit: boolean;
  onVideo: (url: string | null) => Promise<void> | void; onStep: (step: Step) => void;
}) {
  const [video, setVideo] = useState(step.videoUrl ?? '');
  const [seen, setSeen] = useState(step.videoUrl);
  if (seen !== step.videoUrl) { setSeen(step.videoUrl); setVideo(step.videoUrl ?? ''); }
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef<{ role: Role; size: string | null } | null>(null);

  const cur = step.files.filter(f => f.isCurrent !== false);
  const refs = cur.filter(f => f.role === 'reference');
  const isAssessment = step.stepType === 'assessment';
  const uploadOnly = typeDef?.studentAction === 'upload';
  const sizes = course.mistarSizes.length ? course.mistarSizes : ['NP'];
  const sheetRole: Role = isAssessment ? 'assessment_sheet' : 'worksheet';
  const sheetFor = (size: string) => cur.find(f => (f.role === sheetRole || (sheetRole === 'worksheet' && f.role === 'resource')) && (f.sizeCode === size || f.sizeCode === null));
  const ytId = youtubeId(video);
  const sampleFile = cur.find(f => f.role === 'worksheet' || f.role === 'assessment_sheet' || f.role === 'resource') ?? refs[0] ?? null;

  const choose = (role: Role, size: string | null) => { pending.current = { role, size }; fileInput.current?.click(); };
  const onFile = async (file: File | undefined) => {
    const p = pending.current;
    if (!file || !p) return;
    if (!/\.(jpe?g|png|webp|pdf)$/i.test(file.name)) { toast('Use a JPG, PNG or PDF file.', { tone: 'error' }); return; }
    setBusy(`${p.role}-${p.size ?? ''}`);
    try {
      const up = await uploadFile('course-files', file);
      const fresh = await apiFetch<Step>(`/v2/steps/${step.id}/files`, {
        method: 'POST',
        body: { role: p.role, sizeCode: p.size, storageKey: up.storageKey, originalFilename: file.name, contentType: file.type || undefined, byteSize: file.size },
      });
      onStep(fresh);
      toast(p.role === 'reference' ? 'Reference image added.' : `${p.role === 'assessment_sheet' ? 'Assessment sheet' : 'Worksheet'}${p.size ? ` (${sizeLabel(p.size)})` : ''} added.`);
    } catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusy(null); if (fileInput.current) fileInput.current.value = ''; }
  };
  const view = async (f: StepFile) => { try { window.open(await getViewUrl(f.storageKey), '_blank', 'noopener'); } catch (err) { toast(errorText(err), { tone: 'error' }); } };
  const saveVideo = () => { const v = video.trim() || null; if (v !== (step.videoUrl ?? null)) void onVideo(v); };

  return (
    <div className="v3-contents">
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden onChange={e => void onFile(e.target.files?.[0])} />

      {/* 1. video */}
      <div className="v3-content-row">
        <span className="v3-content-label"><Video size={15} /> Video <span className="v2-optional">optional</span></span>
        <div className="v3-content-main">
          <div className="v3-video-field">
            <input
              className="field"
              inputMode="url"
              value={video}
              disabled={!canEdit}
              placeholder="Paste a YouTube link, e.g. https://youtu.be/…"
              aria-label={`Video link for ${step.code}`}
              onChange={e => setVideo(e.target.value)}
              onBlur={saveVideo}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
            {canEdit && video && <button type="button" className="v2-icon-btn" aria-label="Remove the video link" onClick={() => { setVideo(''); void onVideo(null); }}><X size={16} /></button>}
          </div>
          {ytId ? (
            <a className="v3-yt" href={`https://www.youtube.com/watch?v=${ytId}`} target="_blank" rel="noopener noreferrer">
              <img src={`https://i.ytimg.com/vi/${ytId}/mqdefault.jpg`} alt="Video preview" loading="lazy" />
              <span>Students watch it inside the step (YouTube window, no ads from other videos).</span>
            </a>
          ) : video.trim() ? <p className="v2-help">Not a YouTube link — students get a button to open it.</p>
            : <p className="v2-help">If there is no video, students simply do not see a “watch” step.</p>}
        </div>
      </div>

      {/* 2. reference image */}
      {!uploadOnly && (
        <div className="v3-content-row">
          <span className="v3-content-label"><ImageIcon size={15} /> Reference image</span>
          <div className="v3-content-main">
            <div className="v3-chip-row">
              {refs.map(f => (
                <button key={f.id} type="button" className="v3-file-chip ok" onClick={() => void view(f)} title={f.canonicalName}><CheckCircle2 size={13} /> {f.page !== 'P01' ? `Page ${Number(f.page.slice(1))}` : 'Reference'} · v{f.version}</button>
              ))}
              {canEdit && <button type="button" className="btn btn-outline v2-btn-sm" disabled={busy !== null} onClick={() => choose('reference', null)}><Upload size={14} /> {busy === 'reference-' ? 'Uploading…' : refs.length ? 'Replace' : 'Add reference image'}</button>}
              {!refs.length && !canEdit && <span className="v2-help">None</span>}
            </div>
          </div>
        </div>
      )}

      {/* 3. worksheet / assessment sheet per mistar size */}
      {!uploadOnly && (
        <div className="v3-content-row">
          <span className="v3-content-label"><FileText size={15} /> {isAssessment ? 'Assessment sheet' : 'Worksheet'}</span>
          <div className="v3-content-main">
            <div className="v3-size-grid">
              {sizes.filter(s => (SIZE_CODES as readonly string[]).includes(s)).map(size => {
                const f = sheetFor(size);
                const key = `${sheetRole}-${size}`;
                return (
                  <div key={size} className={`v3-size-slot ${f ? 'ok' : 'bad'}`}>
                    <span className="v3-size-name">{sizeLabel(size)}</span>
                    {f ? <button type="button" className="v3-slot-file" onClick={() => void view(f)} title={f.canonicalName}><CheckCircle2 size={13} /> v{f.version}</button>
                      : <span className="v3-slot-missing"><CircleAlert size={13} /> missing</span>}
                    {canEdit && <button type="button" className="v2-link" disabled={busy !== null} onClick={() => choose(sheetRole, size)}><Upload size={13} /> {busy === key ? 'Uploading…' : f ? 'Replace' : 'Upload'}</button>}
                  </div>
                );
              })}
            </div>
            <p className="v2-help">JPG, PNG or PDF. Replacing keeps the old file in history. Files dropped above (or from Drive) appear here by themselves.</p>
          </div>
        </div>
      )}

      {/* 4. stamp preview */}
      <div className="v3-content-row">
        <span className="v3-content-label"><QrCode size={15} /> Student copy</span>
        <div className="v3-content-main">
          <StampMock />
          {sampleFile
            ? <button type="button" className="btn btn-outline v2-btn-sm" onClick={() => void openApiFile(`/v2/step-files/${sampleFile.id}/stamp-preview`).catch(err => toast(errorText(err), { tone: 'error' }))}><FileSearch size={14} /> See a stamped copy of this sheet</button>
            : <p className="v2-help">Add a sheet to see a real stamped copy.</p>}
        </div>
      </div>
    </div>
  );
}

/** How the student's details sit on every printed sheet (header band + footer with the sheet ID). */
export function StampMock() {
  const today = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date());
  return (
    <figure className="v3-stamp" aria-label="Example of the details printed on a student's sheet">
      <div className="v3-stamp-head">
        <b className="v3-stamp-brand">TEHSEEN AL-KHAT</b>
        <span><b>Student name</b> · TR number · Class · Branch</span>
        <span className="v3-stamp-date">Downloaded {today}</span>
      </div>
      <div className="v3-stamp-sheet"><span>the worksheet</span></div>
      <div className="v3-stamp-foot">
        <span className="v3-stamp-id"><QrCode size={12} /> Sheet ID FQ-7K2M9Q</span>
        <span>© Funun al-Quran — for personal practice only</span>
      </div>
      <figcaption className="v2-help">Every download gets the student’s own details and its own sheet ID, so the scan bot knows whose sheet it is.</figcaption>
    </figure>
  );
}
