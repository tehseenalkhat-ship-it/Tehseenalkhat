// Test-only entry: ?page=my-progress (student) | insights (staff). Routes are wired by the integrator.
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { LanguageProvider } from '@/language';
import { V2MyProgressPage } from '@/v2/insights/MyProgressPage';
import { V2InsightsPage } from '@/v2/insights/InsightsPage';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? '';
const page = params.get('page') === 'insights' ? <V2InsightsPage /> : <V2MyProgressPage />;
createRoot(document.getElementById('root')!).render(<LanguageProvider>{page}</LanguageProvider>);
