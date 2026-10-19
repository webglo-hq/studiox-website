import type { MethodInput, MethodName, MethodOutput } from '../../app/methods';

/**
 * The web app talks to a Backend. In the full product it is the HTTP server (sessions,
 * CSRF, rate limits); in the zero-install demo it is the same application API running in
 * the browser on an in-memory store. Screens never know which one they use.
 */

export type Me = MethodOutput<'session.me'>;

export interface Persona {
  email: string;
  name: string;
  title: string | null;
  /** Server development helper only: the generated demo password, shown on this machine. */
  password?: string | null;
}

export interface SessionInfo {
  mode: 'server' | 'demo';
  authenticated: boolean;
  mfaRequired?: boolean;
  user?: Me;
  personas: Persona[];
  providers: { id: string; label: string }[];
  engine: 'offline' | 'live';
  liveAvailable?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface SecurityApi {
  setupMfa(): Promise<{ secret: string; otpauthUri: string }>;
  enableMfa(code: string): Promise<void>;
  disableMfa(code: string): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
}

export interface Backend {
  readonly mode: 'server' | 'demo';
  session(): Promise<SessionInfo>;
  /** Password sign-in (server). The demo signs in as a persona and ignores the password. */
  login(email: string, password: string): Promise<{ mfaRequired: boolean }>;
  verifyMfa(code: string): Promise<void>;
  logout(): Promise<void>;
  call<K extends MethodName>(method: K, input: MethodInput<K>): Promise<MethodOutput<K>>;
  /** Account security endpoints (server only). */
  readonly security: SecurityApi | null;
  /** Called when the server says the session ended (expired, revoked, signed out elsewhere). */
  onSignedOut(cb: () => void): () => void;
}
