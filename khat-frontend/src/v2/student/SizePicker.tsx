import { useState } from 'react';
import { Check, PenLine } from 'lucide-react';
import { Sheet, sizeLabel, sortSizes } from './shared';

const SIZE_HINTS: Record<string, string> = {
  '07': 'Very fine nib',
  '10': 'Fine nib',
  '20': 'Medium nib',
  '30': 'Broad nib',
  NP: 'Ordinary pen',
};

/**
 * Inline mistar size selector — sits right next to a download button or a reference image
 * (owner notes 3.4, 3.5, 2.9). One tap changes the size; the sheets below follow it.
 */
export function SizeChooser({ sizes, current, onChoose, label = 'Mistar size', compact = false }: {
  sizes: string[];
  current: string | null;
  onChoose: (size: string) => Promise<void> | void;
  label?: string;
  compact?: boolean;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = sortSizes(sizes);
  if (list.length === 0) return null;
  const choose = async (size: string) => {
    if (size === current || saving) return;
    setSaving(size); setError(null);
    try { await onChoose(size); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not change the size. Please try again.'); }
    finally { setSaving(null); }
  };
  return (
    <div className={`v3t-size${compact ? ' is-compact' : ''}`}>
      <span className="v3t-size-label" id={`v3t-size-${label.replace(/\W+/g, '')}`}><PenLine size={15} aria-hidden="true" /> {label}</span>
      <div className="v3t-size-options" role="radiogroup" aria-labelledby={`v3t-size-${label.replace(/\W+/g, '')}`}>
        {list.map(size => (
          <button
            key={size}
            type="button"
            role="radio"
            aria-checked={current === size}
            className={`v3t-size-option${current === size ? ' is-selected' : ''}`}
            onClick={() => void choose(size)}
            disabled={Boolean(saving) || list.length === 1}
          >
            {current === size && <Check size={14} strokeWidth={3} aria-hidden="true" />}
            {saving === size ? 'Saving…' : sizeLabel(size)}
          </button>
        ))}
      </div>
      {!current && list.length > 1 && <span className="v3t-size-ask">Choose the size you write with</span>}
      {error && <span className="v2s-form-error" role="alert">{error}</span>}
    </div>
  );
}

/** Friendly one-time question: which mistar size does the student write with? */
export function SizePicker({ sizes, current, remember, onChoose, onClose }: {
  sizes: string[];
  current: string | null;
  remember: boolean;           // true = saved to the student's profile (student.choose_one_size)
  onChoose: (size: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = async (size: string) => {
    setSaving(size); setError(null);
    try { await onChoose(size); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save your size. Please try again.'); }
    finally { setSaving(null); }
  };
  return (
    <Sheet title="Which mistar size do you use?" onClose={onClose}>
      <p className="v2s-sheet-lead">We will show you the worksheets for your size. {remember ? 'We will remember it for all your courses — you can change it any time.' : 'You can change it any time.'}</p>
      <div className="v2s-size-grid" role="radiogroup" aria-label="Mistar size">
        {sortSizes(sizes).map(size => (
          <button
            key={size}
            type="button"
            role="radio"
            aria-checked={current === size}
            className={`v2s-size-option${current === size ? ' is-selected' : ''}`}
            onClick={() => void choose(size)}
            disabled={Boolean(saving)}
          >
            <span className="v2s-size-option-icon" aria-hidden="true">{current === size ? <Check size={18} /> : <PenLine size={18} />}</span>
            <strong>{sizeLabel(size)}</strong>
            <small>{saving === size ? 'Saving…' : SIZE_HINTS[size] ?? 'Mistar size'}</small>
          </button>
        ))}
      </div>
      {error && <p className="v2s-form-error" role="alert">{error}</p>}
    </Sheet>
  );
}
