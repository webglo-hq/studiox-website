/** Web app entry (served by the Node server, or by Vite in development). */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppProvider, applyTheme, readPref, type Theme } from './lib/app-state';
import './styles.css';

applyTheme((readPref('theme') as Theme | null) ?? 'system');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
