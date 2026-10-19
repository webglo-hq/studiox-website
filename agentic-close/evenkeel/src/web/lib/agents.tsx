import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApi } from './api';
import { useToast } from './toast';

/**
 * Agent activity for the whole app. On the server the close agents run in the background;
 * actions that start them call `expect()`, and this provider polls until they finish,
 * refreshing screens as tasks complete and announcing the outcome. In the demo agents run
 * inside the request, so nothing needs polling.
 */
interface AgentsApi {
  running: boolean;
  periodKey: string | null;
  expect(): void;
}

const AgentsContext = createContext<AgentsApi>({ running: false, periodKey: null, expect: () => undefined });

export function useAgents(): AgentsApi {
  return useContext(AgentsContext);
}

export function AgentsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [expecting, setExpecting] = useState(false);
  const act = useApi('close.activity', {}, { refetchInterval: (d) => (d?.running || expecting ? 1200 : false), staleTime: 0 });
  const running = !!act.data?.running;
  const finished = act.data?.runs.filter((r) => r.finishedAt).length ?? 0;
  const seen = useRef(finished);
  const wasBusy = useRef(false);
  const pollsSinceExpect = useRef(0);

  const expect = useCallback(() => {
    pollsSinceExpect.current = 0;
    setExpecting(true);
    void qc.invalidateQueries({ queryKey: ['close.activity'] });
  }, [qc]);

  useEffect(() => {
    if (!act.data) return;
    if (expecting) pollsSinceExpect.current += 1;
    const busy = running || expecting;
    if (running && finished !== seen.current) {
      for (const k of ['close.calendar', 'home.myClose', 'inbox.list', 'recs.list', 'runs.list']) void qc.invalidateQueries({ queryKey: [k] });
    }
    seen.current = finished;
    // An expected background run is over once the server reports idle after our request.
    if (expecting && !running && pollsSinceExpect.current >= 1) {
      setExpecting(false);
      void qc.invalidateQueries();
      const last = act.data.last;
      if (last) toast.push({ tone: last.error ? 'bad' : 'good', text: last.error ? `The agents stopped: ${last.error}` : (last.summary ?? 'The agents finished.') });
    } else if (wasBusy.current && !busy) {
      void qc.invalidateQueries();
    }
    wasBusy.current = busy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act.dataUpdatedAt]);

  const value = useMemo(() => ({ running: running || expecting, periodKey: act.data?.periodKey ?? null, expect }), [running, expecting, act.data?.periodKey, expect]);
  return (
    <AgentsContext.Provider value={value}>
      {children}
      <div data-testid="agents-state" data-state={running || expecting ? 'running' : 'idle'} hidden />
    </AgentsContext.Provider>
  );
}
