// Test-only entry: renders the admin "Today" page (route v2-admin-home is wired by the integrator).
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { LanguageProvider } from '@/language';
import { V2AdminHomePage } from '@/v2/admin/AdminHomePage';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? '';
createRoot(document.getElementById('root')!).render(<LanguageProvider><V2AdminHomePage /></LanguageProvider>);
