// owner: student-dash (v3). "Guide me" — highlights parts of a page one by one, like a teacher pointing.
// Reusable: mark parts with data-guide="<id>" and pass steps [{ target: '<id>', title, text }].
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';

export type GuideStep = { target: string; title: string; text: string };

type Rect = { top: number; left: number; width: number; height: number };
const PAD = 5;

export function GuideTour({ steps, open, onClose }: { steps: GuideStep[]; open: boolean; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const cardRef = useRef<HTMLDivElement>(null);
  // Only steps whose part is on the page right now.
  const available = steps.filter(step => document.querySelector(`[data-guide="${step.target}"]`));
  const step = available[Math.min(index, available.length - 1)];

  useEffect(() => { if (open) setIndex(0); }, [open]);

  const measure = useCallback(() => {
    setViewport({ w: window.innerWidth, h: window.innerHeight });
    if (!step) { setRect(null); return; }
    const el = document.querySelector<HTMLElement>(`[data-guide="${step.target}"]`);
    if (!el) { setRect(null); return; }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
  }, [step]);

  useLayoutEffect(() => {
    if (!open || !step) return;
    const el = document.querySelector<HTMLElement>(`[data-guide="${step.target}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const tall = r.height > window.innerHeight * 0.6;
    el.scrollIntoView({ behavior: 'smooth', block: tall ? 'start' : 'center' });
    measure();
    const timers = [120, 300, 520, 800].map(ms => window.setTimeout(measure, ms));
    window.setTimeout(() => cardRef.current?.focus({ preventScroll: true }), 60);
    return () => timers.forEach(window.clearTimeout);
  }, [open, step, measure]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const onMove = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') setIndex(i => Math.min(i + 1, available.length - 1));
      if (event.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1));
    };
    window.addEventListener('scroll', onMove, { passive: true });
    window.addEventListener('resize', onMove);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('scroll', onMove); window.removeEventListener('resize', onMove); window.removeEventListener('keydown', onKey); cancelAnimationFrame(frame); };
  }, [open, measure, onClose, available.length]);

  if (!open || !step) return null;
  const last = index >= available.length - 1;
  const phone = viewport.w < 640;

  // Card position: below the highlighted part if there is room, else above; phones use the bottom of the screen.
  let cardStyle: React.CSSProperties = {};
  if (!phone && rect) {
    const cardW = Math.min(380, viewport.w - 32);
    const left = Math.max(16, Math.min(rect.left, viewport.w - cardW - 16));
    const below = rect.top + rect.height + 14;
    const fitsBelow = below + 220 < viewport.h;
    cardStyle = fitsBelow ? { top: below, left, width: cardW } : { top: Math.max(16, rect.top - 14 - 220), left, width: cardW };
    if (!fitsBelow && rect.top < 250) cardStyle = { bottom: 24, left, width: cardW };
  }

  return createPortal(
    <div className="v3-sd-tour" role="dialog" aria-modal="true" aria-labelledby="v3-sd-tour-title" aria-describedby="v3-sd-tour-text">
      <div className="v3-sd-tour-catch" onClick={event => event.stopPropagation()} />
      {rect && <div className="v3-sd-tour-spot" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} aria-hidden="true" />}
      <div ref={cardRef} tabIndex={-1} className={`v3-sd-tour-card${phone ? ' is-phone' : ''}`} style={cardStyle}>
        <div className="v3-sd-tour-top">
          <span className="v3-sd-tour-count">Step {index + 1} of {available.length}</span>
          <button type="button" className="v3-sd-icon-btn" onClick={onClose} aria-label="Close the guide"><X size={18} /></button>
        </div>
        <h2 id="v3-sd-tour-title">{step.title}</h2>
        <p id="v3-sd-tour-text">{step.text}</p>
        <div className="v3-sd-tour-dots" aria-hidden="true">{available.map((s, i) => <i key={s.target} className={i === index ? 'is-on' : ''} />)}</div>
        <div className="v3-sd-tour-actions">
          {index > 0
            ? <button type="button" className="v3-sd-btn is-ghost" onClick={() => setIndex(i => i - 1)}><ArrowLeft size={16} /> Back</button>
            : <button type="button" className="v3-sd-btn is-ghost" onClick={onClose}>Skip</button>}
          {last
            ? <button type="button" className="v3-sd-btn is-solid" onClick={onClose}>Let’s begin <ArrowRight size={16} /></button>
            : <button type="button" className="v3-sd-btn is-solid" onClick={() => setIndex(i => i + 1)}>Next <ArrowRight size={16} /></button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
