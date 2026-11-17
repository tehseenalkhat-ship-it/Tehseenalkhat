// owner: insights — standalone mount for UI tests: ?page=insights|team|community&mode=staff|student&theme=sky&role=admin
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { LanguageProvider } from '@/language';
import { V2InsightsPage } from '@/v2/insights/InsightsPage';
import { V2TeamReportPage } from '@/v2/insights/TeamReportPage';
import { V2CommunityPage } from '@/v2/community/CommunityPage';

const params = new URLSearchParams(window.location.search);
const page = params.get('page') ?? 'insights';
const mode = (params.get('mode') ?? 'staff') as 'staff' | 'student';
const role = params.get('role') ?? (mode === 'student' ? 'student' : 'teacher');
document.documentElement.dataset.theme = params.get('theme') ?? 'sky';
localStorage.setItem('khat_token', 'test-token');
localStorage.setItem('khat_user', JSON.stringify({
  id: role === 'student' ? 'stu-1' : 'staff-1', name: role === 'student' ? 'Mustafa Kausar' : 'Ustadha Amina Noor',
  email: 'x@demo.org', role, branchId: 'b-nbo', isCoordinator: false,
}));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      {page === 'team' ? <V2TeamReportPage /> : page === 'community' ? <V2CommunityPage mode={mode} /> : <V2InsightsPage />}
    </LanguageProvider>
  </StrictMode>,
);
