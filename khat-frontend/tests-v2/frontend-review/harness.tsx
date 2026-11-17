import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { ThreadPanel } from '@/v2/chat/ThreadPanel';
import { V2ReviewInboxPage } from '@/v2/review/ReviewInboxPage';
import { V2ScanReturnPage } from '@/v2/review/ScanReturnPage';
import { Annotator } from '@/v2/annotate/Annotator';

const qs = new URLSearchParams(location.search);
const view = qs.get('view') ?? 'inbox';
const role = view === 'thread-student' ? 'student' : 'teacher';
document.documentElement.dataset.theme = qs.get('theme') ?? 'sky';
localStorage.setItem('khat_token', 'test-token');
localStorage.setItem('khat_user', JSON.stringify(role === 'student'
  ? { id: 'stu-1', name: 'Fatema Saifuddin', email: 'f@example.com', role: 'student', branchId: 'nbo' }
  : { id: 't-1', name: 'Husain Teacher', email: 't@example.com', role: 'teacher', branchId: 'nbo' }));

function App() {
  if (view === 'thread-student') {
    return <main className="page" style={{ padding: 12, maxWidth: 720 }}>
      <ThreadPanel stepId="st-5" mode="student" compact submission={{ required: true, priorSteps: [{ id: 'st-1', code: 'S01', title: 'Alif and baa' }, { id: 'st-2', code: 'S02', title: 'Jeem family' }] }} />
    </main>;
  }
  if (view === 'thread-staff') {
    return <main className="page" style={{ padding: 12, maxWidth: 760, height: '100dvh' }}>
      <ThreadPanel stepId="st-5" studentId="stu-1" mode="staff" />
    </main>;
  }
  if (view === 'annotator') {
    return <main style={{ padding: 8, height: '100dvh', display: 'grid' }}>
      <Annotator submissionId="sub-1" files={[{ storageKey: 'sub/assess.png', originalFilename: 'assess.png', contentType: 'image/png' }]} />
    </main>;
  }
  if (view === 'scan') return <V2ScanReturnPage />;
  return <V2ReviewInboxPage />;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
