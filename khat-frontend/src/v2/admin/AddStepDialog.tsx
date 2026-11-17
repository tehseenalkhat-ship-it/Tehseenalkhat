import { useState } from 'react';
import { apiFetch } from '@/api';
import type { Level, Step, StepTypeDef } from '../contracts';
import { experienceLine } from './CourseDetail';
import { Dialog, errorText, toast } from './shared';

/**
 * Owner note 6.12: a step is added by choosing from the step types allowed for this kind of
 * course — nothing else can be picked, so the course cannot become a mess. The backend refuses
 * other types too.
 */
export function AddStepDialog({ level, levelLabel, typeOptions, courseTypeLabel, onClose, onAdded }: {
  level: Level; levelLabel: string; typeOptions: StepTypeDef[]; courseTypeLabel: string | null; onClose: () => void; onAdded: (step: Step) => void;
}) {
  const [type, setType] = useState(typeOptions[0]?.typeKey ?? '');
  const [title, setTitle] = useState('');
  const [video, setVideo] = useState('');
  const [busy, setBusy] = useState(false);
  const def = typeOptions.find(t => t.typeKey === type);
  const run = async () => {
    setBusy(true);
    try {
      const created = await apiFetch<Step>(`/v2/levels/${level.id}/steps`, { method: 'POST', body: { stepType: type, title: title.trim() || undefined, videoUrl: video.trim() || null } });
      toast(`Step ${created.orderIndex + 1} added to ${levelLabel}.`);
      onAdded(created);
      onClose();
    } catch (err) { toast(errorText(err), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <Dialog
      title={`Add a step to ${levelLabel}`}
      eyebrow={courseTypeLabel ? `Steps allowed in a ${courseTypeLabel}` : 'Choose the kind of step'}
      onClose={onClose}
      footer={<><button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!type || busy} onClick={() => void run()}>{busy ? 'Adding…' : `Add ${def?.label ?? 'step'}`}</button></>}
    >
      <label className="field-label" htmlFor="v3-add-type">What kind of step?</label>
      <select id="v3-add-type" className="field" value={type} onChange={e => setType(e.target.value)}>
        {typeOptions.map(t => <option key={t.typeKey} value={t.typeKey}>{t.label}</option>)}
      </select>
      {def && <p className="v3-type-explain">{experienceLine(def)}</p>}
      <label className="field-label">Task name <span className="v2-optional">what students see, e.g. “Alif and Baa”</span>
        <input className="field" value={title} onChange={e => setTitle(e.target.value)} />
      </label>
      {def?.studentAction !== 'upload' && (
        <label className="field-label">YouTube video link <span className="v2-optional">optional</span>
          <input className="field" inputMode="url" value={video} placeholder="https://youtu.be/…" onChange={e => setVideo(e.target.value)} />
        </label>
      )}
      <p className="v2-help">After adding, open the step to upload its reference image and worksheets — or drop files named …_{level.code}_S0…_… on the level.</p>
    </Dialog>
  );
}
