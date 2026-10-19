import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Backend, SessionInfo } from './backend/types';
import { BackendProvider, errorMessage } from './lib/api';
import { makeCan, SessionProvider, type SessionApi } from './lib/session';
import { ToastProvider } from './lib/toast';
import { Shell } from './Shell';
import { MfaPrompt, SignIn } from './screens/SignIn';
import { BrandMark } from './ui/brand';
import { ErrorState } from './ui/kit';

type Phase = { kind: 'loading' } | { kind: 'error'; error: unknown } | { kind: 'signed-out'; info: SessionInfo } | { kind: 'mfa'; info: SessionInfo } | { kind: 'ready'; info: SessionInfo };

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, e) => n < 1 && !(e as { status?: number }).status, refetchOnWindowFocus: false },
  },
});

/** Root: resolves the session, then shows sign-in, the two-step prompt or the app. */
export function App({ backend }: { backend: Backend }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const info = await backend.session();
      if (!info.authenticated) {
        queryClient.clear();
        setPhase({ kind: 'signed-out', info });
      } else if (info.mfaRequired || !info.user) setPhase({ kind: 'mfa', info });
      else setPhase({ kind: 'ready', info });
    } catch (e) {
      setPhase({ kind: 'error', error: e });
    }
  }, [backend]);

  useEffect(() => {
    void load();
    return backend.onSignedOut(() => void load());
  }, [backend, load]);

  const session = useMemo<SessionApi | null>(() => {
    if (phase.kind !== 'ready' || !phase.info.user) return null;
    const user = phase.info.user;
    return {
      info: { ...phase.info, authenticated: true, user },
      can: makeCan(user.permissions),
      refresh: load,
      signOut: async () => {
        await backend.logout();
        queryClient.clear();
        await load();
      },
    };
  }, [phase, backend, load]);

  let body;
  if (phase.kind === 'loading') {
    body = (
      <div className="boot" role="status">
        <div className="boot-card">
          <BrandMark size={40} />
          <p className="muted">Opening Evenkeel…</p>
        </div>
      </div>
    );
  } else if (phase.kind === 'error') {
    body = (
      <div className="boot">
        <div className="boot-card" style={{ textAlign: 'left' }}>
          <ErrorState error={new Error(`Evenkeel could not start: ${errorMessage(phase.error)}`)} retry={() => void load()} />
        </div>
      </div>
    );
  } else if (phase.kind === 'signed-out') body = <SignIn info={phase.info} onSignedIn={load} />;
  else if (phase.kind === 'mfa') body = <MfaPrompt onDone={load} />;
  else if (session) {
    body = (
      <SessionProvider value={session}>
        <Shell />
      </SessionProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <BackendProvider backend={backend}>
        <ToastProvider>{body}</ToastProvider>
      </BackendProvider>
    </QueryClientProvider>
  );
}
