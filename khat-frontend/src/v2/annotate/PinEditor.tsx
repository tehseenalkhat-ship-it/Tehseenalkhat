import { useState } from 'react';
import { Check, Loader2, Mic, RotateCcw, Trash2 } from 'lucide-react';
import { uploadFile } from '@/api';
import type { AnnotationPin } from '../contracts';
import { useVoiceRecorder } from '../chat/useVoiceRecorder';
import { RecordingBar, VoicePlayer } from '../chat/VoicePlayer';

/** Bottom panel for one numbered pin: voice note and/or typed note. */
export function PinEditor({ pin, onChange, onDelete, onClose, trackUpload }: {
  pin: AnnotationPin;
  onChange: (patch: Partial<AnnotationPin>) => void;
  onDelete: () => void;
  onClose: () => void;
  trackUpload: (p: Promise<unknown>) => void;
}) {
  const rec = useVoiceRecorder();
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    const clip = await rec.stop();
    if (!clip) return;
    setLocalUrl(clip.url);
    setUploading(true);
    setError(null);
    const job = uploadFile('voice', clip.file)
      .then(up => onChange({ voiceStorageKey: up.storageKey, durationSec: clip.durationSec }))
      .catch(() => setError('The voice note could not be uploaded. Record it again when you are online.'))
      .finally(() => setUploading(false));
    trackUpload(job);
  };

  const hasVoice = !!pin.voiceStorageKey || !!localUrl;
  return (
    <div className="v2-pin-editor" role="dialog" aria-label={`Note ${pin.n}`}>
      <div className="v2-pin-editor-head">
        <span className="v2-pin-badge" aria-hidden="true">{pin.n}</span>
        <strong>Note {pin.n}</strong>
        <span className="v2-pin-editor-spacer" />
        <button type="button" className="v2-icon-btn" onClick={onDelete} aria-label={`Delete note ${pin.n}`}><Trash2 size={17} /></button>
        <button type="button" className="btn btn-primary v2-pin-done" onClick={onClose} disabled={rec.recording}><Check size={15} /> Done</button>
      </div>
      {rec.recording ? (
        <RecordingBar seconds={rec.seconds} levels={rec.levels} onCancel={rec.cancel} onSend={() => void finish()} sendLabel="Finish voice note" />
      ) : hasVoice ? (
        <div className="v2-pin-voice">
          <VoicePlayer storageKey={pin.voiceStorageKey} src={localUrl} durationSec={pin.durationSec} label={`voice note ${pin.n}`} />
          {uploading ? <span className="v2-pin-status"><Loader2 size={14} className="v2-spin" /> Uploading…</span> : (
            <>
              <button type="button" className="v2-icon-btn" onClick={() => void rec.start()} aria-label="Record again"><RotateCcw size={16} /></button>
              <button type="button" className="v2-icon-btn" onClick={() => { setLocalUrl(null); onChange({ voiceStorageKey: null, durationSec: null }); }} aria-label="Remove voice note"><Trash2 size={16} /></button>
            </>
          )}
        </div>
      ) : (
        <button type="button" className="v2-pin-record" onClick={() => void rec.start()}><Mic size={18} /> Record a voice note for this spot</button>
      )}
      <textarea
        className="field v2-pin-text"
        rows={2}
        value={pin.text ?? ''}
        placeholder="…or type a note for this spot"
        onChange={e => onChange({ text: e.target.value || null })}
        aria-label={`Text for note ${pin.n}`}
      />
      {(error || rec.error) && <p className="v2-inline-error" role="alert">{error ?? rec.error}</p>}
    </div>
  );
}
