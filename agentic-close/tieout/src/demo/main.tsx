/**
 * Static demo entry: boots the real API in the page, points the web app's transport at it and
 * renders the same React app the server serves. Works from file://, any static host, or a
 * sandboxed iframe (no service worker, storage access guarded, hash routing, relative URLs).
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setTransport } from '../web/api';
import { App } from '../web/App';
import { AppProvider, applyTheme, readPref, type Theme } from '../web/lib/app-state';
import '../web/styles.css';
import { bootDemo } from './boot';

applyTheme((readPref('theme') as Theme | null) ?? 'system');

function Boot() {
  const [stage, setStage] = useState('starting');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    bootDemo((m) => alive && setStage(m))
      .then(({ fetch }) => {
        if (!alive) return;
        setTransport(fetch);
        setReady(true);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);
  if (error)
    return (
      <div className="boot">
        <div className="callout bad" role="alert">
          <div>
            <strong>The demo could not start.</strong> {error}
          </div>
        </div>
      </div>
    );
  if (!ready)
    return (
      <div className="boot" role="status" aria-live="polite">
        <div style={{ textAlign: 'center' }}>
          <div className="brand-mark" style={{ margin: '0 auto 14px', width: 44, height: 44, fontSize: 24 }} aria-hidden="true">
            t
          </div>
          <p style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }}>Opening the September close…</p>
          <p className="muted" style={{ marginTop: 6 }}>Building the fictional Bramblewood Labs books in your browser: {stage}.</p>
        </div>
      </div>
    );
  return (
    <AppProvider>
      <App />
    </AppProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
