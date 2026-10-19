import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App';
import { Logo } from './components/ui';
import { setTransport } from './lib/api';
import './styles/tokens.css';
import './styles/app.css';
import './styles/screens.css';

function DemoLoading({ message, failed }: { message: string; failed?: boolean }) {
  return (
    <main className="demo-loading">
      <div className="demo-loading-card" role="status" aria-live="polite">
        <Logo size={40} />
        <h1>Bookhand</h1>
        <p className="text-2">The month-end close, run by agents under your controls.</p>
        <div className={`demo-loading-msg${failed ? ' neg' : ''}`}>{message}</div>
        {!failed && (
          <div className="progress indeterminate" aria-hidden="true">
            <span />
          </div>
        )}
        <p className="tiny muted">
          Zero-install demo: a fictional company and the full application run inside this tab. Nothing is sent anywhere; reloading starts over.
        </p>
      </div>
    </main>
  );
}

async function startDemo(root: Root): Promise<void> {
  root.render(<DemoLoading message="Starting the in-browser ledger..." />);
  try {
    const { startDemoBackend } = await import('./lib/demo-backend');
    const transport = await startDemoBackend((m) => root.render(<DemoLoading message={m} />));
    setTransport(transport);
  } catch (e) {
    root.render(<DemoLoading failed message={`The demo could not start: ${e instanceof Error ? e.message : String(e)}`} />);
    throw e;
  }
}

async function boot(): Promise<void> {
  const el = document.getElementById('root');
  if (!el) return;
  const root = createRoot(el);
  if (__BOOKHAND_MODE__ === 'demo') await startDemo(root);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
