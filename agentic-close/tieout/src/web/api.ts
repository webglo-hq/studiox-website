/**
 * Typed API client. Response types come straight from the server's read models (type-only
 * imports, erased at build time), so the UI and the API cannot drift apart silently.
 * The transport is swappable: real fetch on the server, an in-page call in the static demo.
 */
import type * as Access from '../app/access';
import type * as Credentials from '../app/credentials';
import type * as Outbox from '../app/outbox';
import type * as Q from '../app/queries';
import type * as Close from '../packs/accounting/close/orchestrate';

type R<F extends (...a: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;
export type Me = R<typeof Q.me>;
export type HomeData = R<typeof Q.home>;
export type ProposalList = R<typeof Q.listProposals>;
export type ProposalItem = ProposalList['items'][number];
export type ProposalDetail = R<typeof Q.proposalDetail>;
export type CloseData = R<typeof Q.closeView>;
export type CloseTask = CloseData['tasks'][number];
export type RecsData = R<typeof Q.recsList>;
export type BankWorkbench = R<typeof Q.bankWorkbench>;
export type FluxData = R<typeof Q.fluxView>;
export type JournalList = R<typeof Q.journalList>;
export type JournalDetail = R<typeof Q.journalDetail>;
export type TrialBalance = R<typeof Q.trialBalance>;
export type Statements = R<typeof Q.statements>;
export type RunsList = R<typeof Q.runsList>;
export type RunDetail = R<typeof Q.runDetail>;
export type SkillsCatalog = R<typeof Q.skillsCatalog>;
export type SkillDetail = R<typeof Q.skillDetail>;
export type OntologyData = ReturnType<typeof Q.ontologyView>;
export type Explanation = ReturnType<typeof Q.ontologyExplain>;
export type AuditData = R<typeof Q.auditList>;
export type AuditVerify = R<typeof Q.auditVerify>;
export type AdminData = R<typeof Q.adminView>;
export type ImportsData = R<typeof Q.importsView>;
export type PackageData = R<typeof Q.closePackage>;
export type CloseRunResult = Close.CloseRunResult;
export type AccessRequests = R<typeof Access.listAccessRequests>;
export type AccessRequest = AccessRequests['items'][number];
export type LinkInfo = R<typeof Credentials.peekLink>;
export type LinkSent = Credentials.LinkSent;
export type Mailbox = R<typeof Outbox.mailbox>;
export type MailMessage = R<typeof Outbox.openMail>;

export interface AuthOptions {
  demo: boolean;
  personas: { email: string; name: string; title: string; role: string }[];
  demoPassword: string | null;
  demoPasswordHint: string | null;
  oidc: { enabled: boolean; issuer: string | null; note: string };
  scenarioDate: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Transport = (input: string, init?: RequestInit) => Promise<Response>;
let transport: Transport = (input, init) => fetch(input, { credentials: 'same-origin', ...init });
let csrfToken: string | null = null;

export function setTransport(t: Transport) {
  transport = t;
}
export function setCsrf(token: string | null) {
  csrfToken = token;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await transport(`/api${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: Record<string, unknown> } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Request failed (${res.status})`, err?.details ?? {});
  }
  return data as T;
}

export async function apiText(path: string): Promise<string> {
  const res = await transport(`/api${path}`, { method: 'GET' });
  if (!res.ok) throw new ApiError(res.status, 'error', `Request failed (${res.status})`);
  return res.text();
}

export const qs = (o: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
