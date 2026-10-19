import { ArrowRight, BadgeCheck, KeyRound, Scale, ShieldCheck, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { Persona, SessionInfo } from '../backend/types';
import { errorMessage, useBackend } from '../lib/api';
import { Brand } from '../ui/brand';
import { Avatar, Button, Field, Notice } from '../ui/kit';

const ORDER = ['casey@', 'priya@', 'sam@', 'jordan@', 'miguel@', 'dana@', 'alex@', 'taylor@'];
const rank = (p: Persona) => {
  const i = ORDER.findIndex((o) => p.email.startsWith(o));
  return i < 0 ? 99 : i;
};

const HINT: Record<string, string> = {
  'casey@': 'Runs the close, approves, locks the month',
  'priya@': 'Reviews recs and agent work',
  'sam@': 'Prepares and certifies reconciliations',
  'jordan@': 'Signs the close package',
  'miguel@': 'Explains variances (FP&A)',
  'dana@': 'Accounts payable',
  'alex@': 'Read-only external auditor',
  'taylor@': 'Users, roles and access',
};
const hintFor = (email: string) => Object.entries(HINT).find(([k]) => email.startsWith(k))?.[1] ?? '';

function ArtPanel() {
  return (
    <div className="auth-art">
      <Brand />
      <div className="stack" style={{ gap: 18 }}>
        <h1>Close the month on an even keel.</h1>
        <p>Agents prepare reconciliations, accruals, variance explanations and the close package. Your team reviews, approves and signs. Nothing posts above your policy without a person.</p>
      </div>
      <div className="points">
        <div>
          <Sparkles size={18} aria-hidden />
          <span>Twelve close skills that show their work: every proposal carries the why, the evidence and a confidence.</span>
        </div>
        <div>
          <ShieldCheck size={18} aria-hidden />
          <span>Maker-checker and segregation of duties enforced in the database, not just the screen.</span>
        </div>
        <div>
          <Scale size={18} aria-hidden />
          <span>Grounded in a formal close ontology: double entry, REA, US GAAP, COSO and audit assertions.</span>
        </div>
      </div>
      <p className="xs" style={{ color: '#aab1cc' }}>
        Kitewell Labs is a fictional company. Every name, number and document in this product is invented.
      </p>
    </div>
  );
}

export function SignIn({ info, onSignedIn }: { info: SessionInfo; onSignedIn: () => Promise<void> }) {
  const backend = useBackend();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const personas = [...info.personas].sort((a, b) => rank(a) - rank(b));

  const signIn = async (e: string, p: string) => {
    setBusy(e);
    setError(null);
    try {
      await backend.login(e, p);
      await onSignedIn();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void signIn(email, password);
  };

  return (
    <div className="auth">
      <ArtPanel />
      <main className="auth-form" id="main">
        {info.mode === 'demo' ? (
          <>
            <div className="stack" style={{ gap: 8 }}>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 500 }}>Choose who you are</h2>
              <p className="ink2">This demo runs the whole product in your browser on invented data. Pick a person to see the close through their eyes; you can switch at any time.</p>
            </div>
            {error && <Notice tone="bad">{error}</Notice>}
            <div className="stack" style={{ gap: 8 }} role="list" aria-label="Demo people">
              {personas.map((p) => (
                <button key={p.email} type="button" role="listitem" className="persona" onClick={() => void signIn(p.email, '')} disabled={!!busy} data-testid={`persona-${p.email.split('@')[0]}`}>
                  <Avatar name={p.name} />
                  <span className="grow stack" style={{ gap: 0 }}>
                    <strong>
                      {p.name} <span className="muted small">· {p.title}</span>
                    </strong>
                    <span className="small muted">{hintFor(p.email)}</span>
                  </span>
                  {busy === p.email ? <span className="spinner" aria-label="Signing in" /> : <ArrowRight size={16} aria-hidden />}
                </button>
              ))}
            </div>
            <Notice tone="info">In the full product people sign in with a password (scrypt-hashed) and an optional two-step code; sessions expire and rotate.</Notice>
          </>
        ) : (
          <>
            <div className="stack" style={{ gap: 8 }}>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 500 }}>Sign in</h2>
              <p className="ink2">Use your work email and password.</p>
            </div>
            <form className="stack" onSubmit={submit} noValidate>
              <Field label="Email" htmlFor="email">
                <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required aria-invalid={!!error || undefined} />
              </Field>
              <Field label="Password" htmlFor="password">
                <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required aria-invalid={!!error || undefined} />
              </Field>
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              <Button type="submit" variant="primary" size="l" busy={busy === email && !!email} disabled={!email || !password}>
                Sign in
              </Button>
              {info.providers.map((p) => (
                <Button key={p.id} disabled title="Configured by your administrator">
                  Continue with {p.label}
                </Button>
              ))}
            </form>
            {personas.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="spread">
                  <strong className="small">Demo accounts</strong>
                  <span className="badge t-warn">Development only</span>
                </div>
                <p className="xs muted">Shown only to this machine while DEMO_LOGIN_HELPER is on; never in production. Choosing one fills in the form and signs in with the real password check.</p>
                <div className="stack" style={{ gap: 6 }}>
                  {personas.map((p) => (
                    <button
                      key={p.email}
                      type="button"
                      className="persona"
                      disabled={!p.password || !!busy}
                      data-testid={`persona-${p.email.split('@')[0]}`}
                      onClick={() => {
                        setEmail(p.email);
                        setPassword(p.password ?? '');
                        void signIn(p.email, p.password ?? '');
                      }}
                    >
                      <Avatar name={p.name} />
                      <span className="grow stack" style={{ gap: 0 }}>
                        <strong className="small">
                          {p.name} <span className="muted">· {p.title}</span>
                        </strong>
                        <span className="xs muted mono">{p.email}</span>
                      </span>
                      {busy === p.email ? <span className="spinner" aria-label="Signing in" /> : <KeyRound size={15} aria-hidden />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export function MfaPrompt({ onDone }: { onDone: () => Promise<void> }) {
  const backend = useBackend();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await backend.verifyMfa(code);
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div className="auth">
      <ArtPanel />
      <main className="auth-form" id="main">
        <div className="stack" style={{ gap: 8 }}>
          <BadgeCheck size={28} aria-hidden color="var(--accent)" />
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 500 }}>Two-step sign-in</h2>
          <p className="ink2">Enter the 6-digit code from your authenticator app.</p>
        </div>
        <form className="stack" onSubmit={(e) => void submit(e)}>
          <Field label="Code" htmlFor="code" error={error}>
            <input id="code" className="input mono" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={!!error || undefined} data-autofocus />
          </Field>
          <Button type="submit" variant="primary" size="l" busy={busy} disabled={code.replace(/\s/g, '').length < 6}>
            Verify
          </Button>
          <Button variant="quiet" onClick={() => void backend.logout().then(onDone)}>
            Use a different account
          </Button>
        </form>
      </main>
    </div>
  );
}
