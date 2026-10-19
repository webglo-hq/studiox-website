import './styles/tokens.css';
import './styles/app.css';
import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BACKEND_MODE, createBackend } from '@ek/backend';
import type { Backend } from './backend/types';
import { applyTheme, storedTheme } from './lib/theme';
import { BrandMark } from './ui/brand';

applyTheme(storedTheme());

/** Boot progress for the in-browser demo (seeding thirteen months of books takes a moment). */
let stage = 'Starting';
const listeners = new Set<() => void>();
const setStage = (s: string) => {
  stage = s;
  for (const l of listeners) l();
};
function DemoBoot({ error }: { error?: string }) {
  const s = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => stage,
  );
  return (
    <div className="boot" role="status" aria-live="polite">
      <div className="boot-card">
        <BrandMark size={44} />
        <h1>Evenkeel</h1>
        {error ? (
          <p className="diff-bad">The demo could not start: {error}</p>
        ) : (
          <>
            <p className="ink2">Building a year of books for the fictional Kitewell Labs, right here in your browser. Nothing is sent anywhere.</p>
            <p className="small muted row" style={{ justifyContent: 'center' }}>
              <span className="spinner" aria-hidden /> {s}…
            </p>
          </>
        )}
      </div>
    </div>
  );
}

async function start(): Promise<void> {
  const el = document.getElementById('root');
  if (!el) return;
  const root = createRoot(el);
  let backend: Backend;
  if (BACKEND_MODE === 'demo') root.render(<DemoBoot />);
  try {
    backend = await createBackend(setStage);
    document.documentElement.dataset.backend = (backend as { transport?: { kind: string } }).transport?.kind ?? BACKEND_MODE;
  } catch (e) {
    root.render(<DemoBoot error={e instanceof Error ? e.message : String(e)} />);
    return;
  }
  root.render(
    <StrictMode>
      <App backend={backend} />
    </StrictMode>,
  );
}

void start();
