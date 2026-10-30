import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import './arabic-fonts.css';
import { LanguageProvider } from './language';
import { installErrorCapture } from './errorCapture';

installErrorCapture();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider><App /></LanguageProvider>
  </StrictMode>
);
