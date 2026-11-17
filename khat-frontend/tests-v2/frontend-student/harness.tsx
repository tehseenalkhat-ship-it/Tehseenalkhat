import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { LanguageProvider } from '@/language';
import { Header } from '@/components/ui';
import { V2StudentCoursePage } from '@/v2/student/StudentCoursePage';
import { V2StudentCatalogSection } from '@/v2/student/StudentCatalogSection';
import { V2StudentMeritPage } from '@/v2/student/StudentMeritPage';
import { V2CompetitionsPage } from '@/v2/competitions/CompetitionsPage';
import { V2DashboardHighlights } from '@/v2/competitions/DashboardHighlights';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'course';
const role = (params.get('role') ?? (view.startsWith('comp-') && view !== 'comp-student' ? 'admin' : 'student')) as 'student' | 'admin' | 'teacher';
document.documentElement.dataset.theme = params.get('theme') ?? 'sky';

localStorage.setItem('khat_token', 'test-token');
localStorage.setItem('khat_user', JSON.stringify({ id: role === 'student' ? 'stu-1' : 'adm-1', name: role === 'student' ? 'Fatema Hakimuddin' : 'Husain Admin', email: 'test@example.com', role, branchId: 'br-marol' }));
sessionStorage.setItem('khat.v2.param.courseId', params.get('courseId') ?? 'c1');
if (params.get('stepId')) sessionStorage.setItem('khat.v2.param.stepId', params.get('stepId')!); else sessionStorage.removeItem('khat.v2.param.stepId');
if (params.get('clearSize')) localStorage.removeItem('khat.v2.mistarSize');

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="app-layout">
      <Header role={role} />
      <div className="app-shell-content">{children}</div>
    </div>
  );
}

const views: Record<string, () => ReactNode> = {
  course: () => <V2StudentCoursePage />,
  merit: () => <V2StudentMeritPage />,
  'comp-student': () => <V2CompetitionsPage mode="student" />,
  'comp-staff': () => <V2CompetitionsPage mode="staff" />,
  'comp-admin': () => <V2CompetitionsPage mode="admin" />,
  catalog: () => <main className="page portal-page"><V2StudentCatalogSection /></main>,
  highlights: () => <main className="page portal-page"><p className="eyebrow">Dashboard</p><h2>Salaam, Fatema</h2><V2DashboardHighlights branchId="br-marol" /></main>,
};

createRoot(document.getElementById('root')!).render(
  <StrictMode><LanguageProvider><Shell>{(views[view] ?? views.course)()}</Shell></LanguageProvider></StrictMode>,
);
