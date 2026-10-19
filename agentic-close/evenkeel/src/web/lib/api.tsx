import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import type { MethodInput, MethodName, MethodOutput } from '../../app/methods';
import { ApiError, type Backend } from '../backend/types';
import { useToast } from './toast';

const BackendContext = createContext<Backend | null>(null);

export function BackendProvider({ backend, children }: { backend: Backend; children: ReactNode }) {
  return <BackendContext.Provider value={backend}>{children}</BackendContext.Provider>;
}

export function useBackend(): Backend {
  const b = useContext(BackendContext);
  if (!b) throw new Error('BackendProvider missing');
  return b;
}

/** Typed query for one application method. The cache key is the method plus its input. */
export function useApi<K extends MethodName>(
  method: K,
  input: MethodInput<K>,
  opts: { enabled?: boolean; refetchInterval?: number | false | ((data: MethodOutput<K> | undefined) => number | false); staleTime?: number; keepPrevious?: boolean } = {},
) {
  const backend = useBackend();
  const every = opts.refetchInterval;
  return useQuery<MethodOutput<K>, ApiError>({
    queryKey: [method, input],
    queryFn: () => backend.call(method, input),
    enabled: opts.enabled ?? true,
    refetchInterval: typeof every === 'function' ? (q) => every(q.state.data) : (every ?? false),
    staleTime: opts.staleTime ?? 5_000,
    placeholderData: opts.keepPrevious ? keepPreviousData : undefined,
  });
}

/**
 * A mutation for one application method. On success every cached query is refreshed
 * (a decision ripples through the whole close), and an optional message is shown.
 */
export function useAction<K extends MethodName>(method: K, opts: { success?: string | ((out: MethodOutput<K>, input: MethodInput<K>) => string | null); onSuccess?: (out: MethodOutput<K>, input: MethodInput<K>) => void; quietErrors?: boolean } = {}) {
  const backend = useBackend();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<MethodOutput<K>, ApiError, MethodInput<K>>({
    mutationFn: (input) => backend.call(method, input),
    onSuccess: async (out, input) => {
      await qc.invalidateQueries();
      const msg = typeof opts.success === 'function' ? opts.success(out, input) : opts.success;
      if (msg) toast.push({ tone: 'good', text: msg });
      opts.onSuccess?.(out, input);
    },
    onError: (e) => {
      if (!opts.quietErrors) toast.push({ tone: 'bad', text: e.message });
    },
  });
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
