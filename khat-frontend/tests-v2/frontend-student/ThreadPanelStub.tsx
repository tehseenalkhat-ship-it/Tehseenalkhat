import { Camera, FileText, Image as ImageIcon, Mic, Send } from 'lucide-react';
import type { ThreadPanelProps } from '../../src/v2/chat/ThreadPanel';

/** Harness-only stand-in for the real ThreadPanel (built by another agent). */
export function ThreadPanel({ stepId, compact, submission }: ThreadPanelProps) {
  return (
    <section data-testid={`thread-${stepId}`} style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--surface-tint)', padding: 12, display: 'grid', gap: 10, marginTop: 6 }}>
      <div style={{ justifySelf: 'start', maxWidth: '82%', background: 'var(--card)', borderRadius: '12px 12px 12px 4px', padding: '8px 12px', fontSize: 14 }}>
        <small style={{ color: 'var(--muted)', display: 'block', fontWeight: 700 }}>Course team</small>
        Lovely baseline! Look at the nuqta on the baa — keep it one rhombus wide.
      </div>
      {submission?.priorSteps?.length ? <small style={{ color: 'var(--muted)' }}>Upload together: {submission.priorSteps.map(s => s.code).join(', ')} + assessment sheet</small> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" style={{ flex: '1 1 auto', minHeight: 44 }}><Camera size={16} /> Upload {compact ? '' : 'work'}</button>
        <button type="button" className="btn btn-outline" style={{ minHeight: 44 }} aria-label="Photos"><ImageIcon size={16} /></button>
        <button type="button" className="btn btn-outline" style={{ minHeight: 44 }} aria-label="PDF"><FileText size={16} /></button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="field" placeholder="Type a message" style={{ flex: 1, minHeight: 42, borderRadius: 99 }} />
        <button type="button" className="btn btn-outline" style={{ minHeight: 42, borderRadius: 99 }} aria-label="Voice"><Mic size={16} /></button>
        <button type="button" className="btn btn-primary" style={{ minHeight: 42, borderRadius: 99 }} aria-label="Send"><Send size={16} /></button>
      </div>
    </section>
  );
}
