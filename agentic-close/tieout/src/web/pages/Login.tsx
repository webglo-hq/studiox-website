/**
 * Sign-in with password, then TOTP (verify, a one-time recovery code, or first-time enrolment,
 * which shows recovery codes once). Demo mode lists personas.
 */
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api, ApiError, setCsrf, type AuthOptions } from '../api';
import { RecoveryCodes } from '../components/RecoveryCodes';
import { Avatar } from '../components/ui';
import { useApp } from '../lib/app-state';
import { ROLE_LABEL } from '../lib/format';

export function Login() {
  const { refresh, mfaPending, passwordChange } = useApp();
  const [opts, setOpts] = useState<AuthOptions | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'password' | 'mfa' | 'enroll' | 'newpw'>(mfaPending ? 'mfa' : passwordChange ? 'newpw' : 'password');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [code, setCode] = useState('');
  const [enrol, setEnrol] = useState<{ secret: string; otpauth: string } | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const id = useId();

  // after two-factor, a temporary password still has to be replaced
  useEffect(() => {
    if (passwordChange) setStage('newpw');
  }, [passwordChange]);

  useEffect(() => {
    api<AuthOptions>('/auth/options')
      .then(setOpts)
      .catch(() => setOpts({ demo: false, personas: [], demoPassword: null, demoPasswordHint: null, oidc: { enabled: false, issuer: null, note: '' }, scenarioDate: null }));
  }, []);

  async function signIn(e?: React.FormEvent, as?: { email: string; password: string }) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ csrfToken: string; mfa: 'not_required' | 'pending' | 'enroll'; passwordChange: boolean }>('/auth/login', { body: as ?? { email, password } });
      setCsrf(r.csrfToken);
      if (r.passwordChange) setPw({ current: (as ?? { password }).password, next: '', confirm: '' });
      if (r.mfa === 'pending') setStage('mfa');
      else if (r.mfa === 'enroll') {
        setStage('enroll');
        setEnrol(await api<{ secret: string; otpauth: string }>('/auth/mfa/enroll', { body: {} }));
      } else if (r.passwordChange) setStage('newpw');
      else await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  async function choosePassword(e: React.FormEvent) {
    e.preventDefault();
    if (pw.next !== pw.confirm) {
      setError('The two new passwords are not the same.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password', { body: { current: pw.current, next: pw.next } });
      setPw({ current: '', next: '', confirm: '' });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  }

  /** Leave a half-finished two-factor sign-in (ends the pending session). */
  async function startOver() {
    try {
      await api('/auth/logout', { body: {} });
    } catch {
      /* the pending session may already have expired */
    }
    setStage('password');
    setCode('');
    setUseRecovery(false);
    setEnrol(null);
    setError(null);
    await refresh();
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ csrfToken: string; recoveryCodes: string[] | null }>('/auth/mfa/verify', { body: { code } });
      setCsrf(r.csrfToken);
      if (r.recoveryCodes?.length) setCodes(r.recoveryCodes); // first-time set-up: show them once
      else await refresh(); // a temporary password then moves the page to "Choose a new password"
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <section className="login-art" aria-label="About Tieout">
        <div>
          <div className="row" style={{ gap: 12 }}>
            <span className="brand-mark" style={{ background: 'var(--accent-ink)', color: 'var(--accent)' }} aria-hidden="true">
              t
            </span>
            <span className="brand-name">Tieout</span>
          </div>
        </div>
        <div>
          <h1>
            Close the month with agents.
            <br />
            <em>Sign off like an accountant.</em>
          </h1>
          <ul style={{ marginTop: 22, paddingLeft: 18, lineHeight: 1.8, fontSize: 16, maxWidth: 520 }}>
            <li>Agents reconcile, accrue, code and explain — every item with a why, a confidence and evidence.</li>
            <li>You choose the autonomy, per skill. Small, certain items post themselves; everything else waits for you.</li>
            <li>Segregation of duties, approval limits and a tamper-evident audit trail are enforced, not suggested.</li>
          </ul>
        </div>
        <p style={{ fontSize: 13, opacity: 0.9 }}>Bramblewood Labs is a fictional company. All data in the demo is made up.</p>
      </section>
      <section className="login-form">
        <div style={{ width: 'min(420px, 100%)' }} className="stack">
          {stage === 'password' ? (
            <>
              <div>
                <h2 style={{ fontSize: 24, fontFamily: 'var(--font-display)', fontWeight: 400 }}>Sign in</h2>
                <p className="muted" style={{ marginTop: 4 }}>
                  {opts?.demo ? 'Pick a person to see the close from their seat, or use the form.' : 'Use your work email.'}
                </p>
              </div>
              {opts?.demo && opts.personas.length ? (
                <div className="stack" style={{ gap: 8 }} role="group" aria-label="Demo personas">
                  {opts.personas.map((p) => (
                    <button key={p.email} type="button" className="persona" disabled={busy || !opts.demoPassword} onClick={() => void signIn(undefined, { email: p.email, password: opts.demoPassword ?? '' })}>
                      <Avatar name={p.name} />
                      <span>
                        <span style={{ fontWeight: 600 }}>{p.name}</span>
                        <br />
                        <span className="muted" style={{ fontSize: 13 }}>
                          {p.title}
                        </span>
                      </span>
                      <span className="badge neutral">{ROLE_LABEL[p.role] ?? p.role}</span>
                    </button>
                  ))}
                  {opts.demoPassword ? (
                    <p className="muted" style={{ fontSize: 13 }}>
                      Dev-only demo password for every persona: <code>{opts.demoPassword}</code>
                    </p>
                  ) : (
                    <p className="muted" style={{ fontSize: 13 }}>
                      {opts.demoPasswordHint}
                    </p>
                  )}
                </div>
              ) : null}
              <form className="stack" style={{ gap: 12 }} onSubmit={(e) => void signIn(e)} noValidate>
                <label className="field" htmlFor={`${id}-e`}>
                  Email
                  <input id={`${id}-e`} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </label>
                <label className="field" htmlFor={`${id}-p`}>
                  Password
                  <input id={`${id}-p`} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </label>
                {error ? (
                  <p className="error-text" role="alert">
                    {error}
                  </p>
                ) : null}
                <button className="btn primary big" type="submit" disabled={busy}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
                {opts?.oidc.enabled ? (
                  <a className="btn" href="api/auth/oidc/start">
                    Sign in with single sign-on
                  </a>
                ) : null}
              </form>
            </>
          ) : stage === 'newpw' ? (
            <form className="stack" style={{ gap: 12 }} onSubmit={(e) => void choosePassword(e)}>
              <div className="row">
                <KeyRound className="icon" aria-hidden="true" />
                <h2 style={{ fontSize: 22 }}>Choose a new password</h2>
              </div>
              <p className="muted">You signed in with a temporary password from your administrator. Replace it before you continue; it then stops working.</p>
              <label className="field" htmlFor={`${id}-cur`}>
                Temporary password
                <input id={`${id}-cur`} type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
              </label>
              <label className="field" htmlFor={`${id}-new`}>
                New password
                <input id={`${id}-new`} type="password" autoComplete="new-password" aria-describedby={`${id}-new-h`} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
                <span id={`${id}-new-h`} className="hint">
                  At least 12 characters. A long passphrase is best.
                </span>
              </label>
              <label className="field" htmlFor={`${id}-rep`}>
                Repeat the new password
                <input id={`${id}-rep`} type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
              </label>
              {error ? (
                <p className="error-text" role="alert">
                  {error}
                </p>
              ) : null}
              <button className="btn primary big" type="submit" disabled={busy || !pw.current || pw.next.length < 12 || !pw.confirm}>
                Save and continue
              </button>
              <button className="linklike" type="button" onClick={() => void startOver()}>
                Sign in as someone else
              </button>
            </form>
          ) : codes ? (
            <div className="stack" style={{ gap: 12 }}>
              <div className="row">
                <ShieldCheck className="icon" aria-hidden="true" />
                <h2 style={{ fontSize: 22 }}>Two-factor authentication is on</h2>
              </div>
              <RecoveryCodes codes={codes} account={email || 'your account'} />
              <button className="btn primary big" type="button" onClick={() => void refresh()}>
                I saved them, continue
              </button>
            </div>
          ) : (
            <form className="stack" style={{ gap: 12 }} onSubmit={(e) => void verify(e)}>
              <div className="row">
                <ShieldCheck className="icon" aria-hidden="true" />
                <h2 style={{ fontSize: 22 }}>Two-factor authentication</h2>
              </div>
              {stage === 'enroll' ? (
                <div className="callout info">
                  <div>
                    <p>Your role requires two-factor authentication. Add this key to an authenticator app (time-based, 6 digits), then enter the current code.</p>
                    <p style={{ marginTop: 8 }}>
                      <code style={{ wordBreak: 'break-all' }}>{enrol?.secret ?? '…'}</code>
                    </p>
                  </div>
                </div>
              ) : (
                <p className="muted">{useRecovery ? 'Enter one of the recovery codes you saved when you set up two-factor authentication. Each works once.' : 'Enter the 6-digit code from your authenticator app.'}</p>
              )}
              {useRecovery ? (
                <label className="field" htmlFor={`${id}-r`}>
                  Recovery code
                  <input id={`${id}-r`} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={11} placeholder="xxxxx-xxxxx" value={code} onChange={(e) => setCode(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
                </label>
              ) : (
                <label className="field" htmlFor={`${id}-c`}>
                  Code
                  <input id={`${id}-c`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
                </label>
              )}
              {error ? (
                <p className="error-text" role="alert">
                  {error}
                </p>
              ) : null}
              <button className="btn primary big" type="submit" disabled={busy || (useRecovery ? code.replace(/-/g, '').length !== 10 : code.length !== 6)}>
                Verify
              </button>
              {stage === 'mfa' ? (
                <button
                  className="linklike"
                  type="button"
                  onClick={() => {
                    setUseRecovery((x) => !x);
                    setCode('');
                    setError(null);
                  }}
                >
                  {useRecovery ? 'Use my authenticator app instead' : 'Lost your authenticator? Use a recovery code'}
                </button>
              ) : null}
              <button className="linklike" type="button" onClick={() => void startOver()}>
                Sign in as someone else
              </button>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
