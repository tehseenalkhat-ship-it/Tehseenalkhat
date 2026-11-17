// Test-only entry: renders one v2 admin page chosen by ?page=… (and ?theme=…).
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { LanguageProvider } from '@/language';
import { V2CourseBuilderPage } from '@/v2/admin/CourseBuilderPage';
import { V2PoliciesPage } from '@/v2/admin/PoliciesPage';
import { V2LogicSetsPage } from '@/v2/admin/LogicSetsPage';
import { V2MeritPage } from '@/v2/admin/MeritPage';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'sky';
const page = params.get('page') ?? 'builder';
const pages: Record<string, () => JSX.Element> = {
  builder: () => <V2CourseBuilderPage />,
  policies: () => <V2PoliciesPage />,
  logic: () => <V2LogicSetsPage />,
  merit: () => <V2MeritPage />,
};
const Page = pages[page] ?? pages.builder;
createRoot(document.getElementById('root')!).render(<LanguageProvider><Page /></LanguageProvider>);
