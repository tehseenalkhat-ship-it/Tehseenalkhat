// Test harness (chat owner): renders the step chat alone. ?stepId=&studentId=&mode=student|staff&compact=1&submit=1
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { ThreadPanel } from '@/v2/chat/ThreadPanel';

const p = new URLSearchParams(location.search);
const mode = (p.get('mode') ?? 'student') as 'student' | 'staff';
createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100dvh', padding: p.get('pad') ? 16 : 0, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: 'minmax(0,1fr)' }}>
    <ThreadPanel
      stepId={p.get('stepId') ?? ''}
      studentId={p.get('studentId') ?? undefined}
      mode={mode}
      compact={p.get('compact') === '1'}
      submission={p.get('submit') === '1' ? { required: true, priorSteps: [] } : null}
    />
  </div>,
);
