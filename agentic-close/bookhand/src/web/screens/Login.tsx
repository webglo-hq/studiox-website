import { ArrowRight, CheckCircle2, KeyRound, ShieldCheck, Sparkles } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { api, ApiError, transportKind } from '../lib/api';
import { Avatar, Logo } from '../components/ui';

interface DemoUsers {
  demo: boolean;
  company?: string;
  password: string | null;
  users: Array<{ email: string; name: string; title: string | null; hue: number; role: string }>;
}

const ROLE_HINTS: Record<string, string> = {
  'Staff Accountant': 'Runs the close agents and certifies reconciliations',
  'Senior Accountant': 'Approves most agent work and reviews reconciliations',
  Controller: 'Approves large items, flux and the close package; locks the period',
  CFO: 'Unlimited approval, reopens locked periods',
  'FP&A Analyst': 'Accepts or rewrites variance explanations',
  'Auditor (read-only)': 'Reads everything, verifies the audit chain',
  'AP Clerk': 'Codes spend, approves small items',
  Admin: 'Users, roles, SoD rules and sessions; no financial approvals',
};

export function LoginScreen({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<DemoUsers | null>(null);
  const emailId = useId();
  const pwId = useId();
  useEffect(() => {
    api.get<DemoUsers>('/api/auth/demo-users').then(setDemo).catch(() => setDemo(null));
  }, []);

  const signIn = async (e: string, p: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { email: e, password: p });
      await onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };
  // Without a published demo password (an operator set their own), picking a person fills in the email.
  const pick = (e: string) => {
    setEmail(e);
    document.getElementById(pwId)?.focus();
  };
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void signIn(email, password);
  };

  return (
    <div className="login-page">
      <main className="login-main" id="main">
        <div className="row" style={{ gap: 12, marginBottom: 28 }}>
          <Logo size={36} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>Bookhand</div>
            <div className="small muted">The agentic month-end close</div>
          </div>
        </div>
        <h1 className="display">Sign in to close the books</h1>
        <p className="text-2" style={{ marginTop: 8 }}>
          Agents prepare. Ontology checks verify. People approve.
        </p>
        <form onSubmit={submit} className="stack" style={{ marginTop: 24 }} aria-describedby={error ? 'login-error' : undefined}>
          <div className="field">
            <label htmlFor={emailId}>Work email</label>
            <input id={emailId} className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor={pwId}>Password</label>
            <input id={pwId} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && (
            <div id="login-error" className="callout danger" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy} style={{ minHeight: 42 }}>
            {busy ? 'Signing in...' : 'Sign in'}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
          <p className="tiny muted">
            <ShieldCheck size={12} aria-hidden="true" /> Passwords are hashed with scrypt; sessions are httpOnly cookies that rotate and expire; two-step sign-in is available in Settings.
          </p>
          {transportKind() === 'http' && (
            <p className="small">
              <a href="/landing.html">What is Bookhand? Product and pricing</a>
            </p>
          )}
        </form>
      </main>
      <aside className="login-aside" aria-label="Demo accounts">
        {demo?.demo ? (
          <>
            <div className="badge badge-attention" style={{ marginBottom: 12 }}>
              <Sparkles size={12} aria-hidden="true" /> Demo company
            </div>
            <h2 style={{ fontSize: 20 }}>{demo.company}</h2>
            <p className="text-2 small" style={{ marginTop: 6 }}>
              A fictional SaaS company with a US parent and a UK subsidiary, twelve closed months and an open September with planted issues for the agents to find.
              {demo.password && (
                <>
                  {' '}
                  Every demo user's password is <code>{demo.password}</code> (development only).
                </>
              )}
            </p>
            <ol className="tiny muted" style={{ margin: '12px 0 16px', paddingLeft: 18 }}>
              <li>Sign in as Maya and run the close agents.</li>
              <li>Approve exceptions as Daniel (and large ones as Hannah).</li>
              <li>Certify recs, accept flux as Priya, approve the package and lock as Hannah.</li>
            </ol>
            <ul className="list demo-users">
              {demo.users.map((u) => (
                <li key={u.email}>
                  <button type="button" className="demo-user" disabled={busy} onClick={() => (demo.password ? void signIn(u.email, demo.password) : pick(u.email))}>
                    <Avatar name={u.name} hue={u.hue} size={34} />
                    <span className="grow" style={{ textAlign: 'left' }}>
                      <span style={{ display: 'block', fontWeight: 600 }}>
                        {u.name} <span className="muted small">· {u.role}</span>
                      </span>
                      <span className="tiny muted">{ROLE_HINTS[u.role] ?? u.title}</span>
                    </span>
                    <KeyRound size={16} aria-hidden="true" />
                    <span className="sr-only">{demo.password ? `Sign in as ${u.name}` : `Use ${u.name}'s email`}</span>
                  </button>
                </li>
              ))}
            </ul>
            {transportKind() === 'demo' && <p className="tiny muted" style={{ marginTop: 12 }}>Running entirely in your browser: the database, the agents and the API are all in this tab.</p>}
          </>
        ) : (
          <div className="stack">
            <h2 style={{ fontSize: 20 }}>Close faster without losing control</h2>
            {['Agents code spend, match bank lines, find unrecorded liabilities and draft variance commentary.', 'Every proposal is verified against an accounting ontology before anyone can approve it.', 'Maker-checker, approval limits and a tamper-evident audit log on everything.'].map((t) => (
              <div key={t} className="row" style={{ alignItems: 'flex-start' }}>
                <CheckCircle2 size={18} className="pos" aria-hidden="true" />
                <span className="text-2">{t}</span>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

export function MfaScreen({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/mfa', { code });
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify the code.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <main className="login-main" id="main">
        <Logo size={36} />
        <h1 className="display" style={{ marginTop: 20 }}>
          Two-step sign-in
        </h1>
        <p className="text-2" style={{ marginTop: 8 }}>
          Enter the 6-digit code from your authenticator app.
        </p>
        <form onSubmit={submit} className="stack" style={{ marginTop: 20 }}>
          <div className="field">
            <label htmlFor={id}>Authenticator code</label>
            <input id={id} className="input mono" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
          </div>
          {error && (
            <div className="callout danger" role="alert">
              {error}
            </div>
          )}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>
              Verify
            </button>
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Use a different account
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
