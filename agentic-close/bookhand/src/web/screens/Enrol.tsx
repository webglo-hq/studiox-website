import { ArrowLeft, CheckCircle2, KeyRound, Mail } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { date } from '../lib/format';
import { navigate } from '../lib/hooks';
import { Badge, Logo } from '../components/ui';

/**
 * Signed-out screens for the single-use links Bookhand sends people: choosing a password with an enrolment or
 * reset link, and (in a demo organization) reading one's own messages in the delivery log. A link works only for
 * the person it was sent to; nobody else, an administrator included, is ever shown it.
 */

interface LinkInfo {
  purpose: 'enrolment' | 'password_reset';
  name: string;
  email: string;
  expiresAt: string;
}

function Frame({ children }: { children: ReactNode }) {
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
        {children}
      </main>
    </div>
  );
}

export function CredentialLinkScreen({ token, signedInAs, onSignOut, onFinished }: { token: string; signedInAs: string | null; onSignOut: () => Promise<void>; onFinished: () => Promise<void> }) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [problem, setProblem] = useState<{ message: string; forbidden: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pwId = useId();
  const pw2Id = useId();
  useEffect(() => {
    let live = true;
    setInfo(null);
    setProblem(null);
    api
      .post<LinkInfo>('/api/auth/credential-link/check', { token })
      .then((r) => live && setInfo(r))
      .catch((e) => live && setProblem({ message: e instanceof ApiError ? e.message : 'This link could not be checked.', forbidden: e instanceof ApiError && e.status === 403 }));
    return () => {
      live = false;
    };
  }, [token, signedInAs]);
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (pw !== pw2) {
      setError('The two passwords are different.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ email: string }>('/api/auth/credential-link', { token, password: pw });
      setDone(r.email);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not set the password.');
    } finally {
      setBusy(false);
    }
  };
  if (done) {
    return (
      <Frame>
        <h1 className="display">
          <CheckCircle2 size={26} className="pos" aria-hidden="true" /> Your password is set
        </h1>
        <p className="text-2" style={{ marginTop: 8 }} role="status">
          The link is used up. Sign in as {done} with the password you just chose.
        </p>
        <button type="button" className="btn btn-primary" style={{ marginTop: 20 }} onClick={() => void onFinished()}>
          Go to sign in
        </button>
      </Frame>
    );
  }
  return (
    <Frame>
      <h1 className="display">{info?.purpose === 'password_reset' ? 'Choose a new password' : 'Set your password'}</h1>
      {!info && !problem && <p className="text-2" style={{ marginTop: 8 }}>Checking your link...</p>}
      {problem && (
        <div className="stack" style={{ marginTop: 16 }}>
          <div className="callout danger" role="alert">
            {problem.message}
          </div>
          <div className="row-wrap">
            {problem.forbidden && signedInAs && (
              <button type="button" className="btn btn-primary" onClick={() => void onSignOut()}>
                Sign out {signedInAs}
              </button>
            )}
            <a className="btn" href="#/">
              <ArrowLeft size={14} aria-hidden="true" /> Back to sign in
            </a>
          </div>
        </div>
      )}
      {info && (
        <form onSubmit={submit} className="stack" style={{ marginTop: 16 }} aria-describedby={error ? 'link-error' : undefined}>
          <p className="text-2">
            {info.purpose === 'password_reset' ? 'This single-use link resets the password of' : 'Welcome. This single-use link sets the password of'} <strong>{info.name}</strong> ({info.email}). It works until {date(info.expiresAt, 'time')}.
          </p>
          <input type="email" autoComplete="username" value={info.email} readOnly hidden />
          <div className="field">
            <label htmlFor={pwId}>New password</label>
            <input id={pwId} className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={12} />
            <span className="hint">At least 12 characters; a passphrase works well. Not your name or email.</span>
          </div>
          <div className="field">
            <label htmlFor={pw2Id}>Repeat the password</label>
            <input id={pw2Id} className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
          </div>
          {error && (
            <div id="link-error" className="callout danger" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy || !pw || !pw2} style={{ minHeight: 42 }}>
            <KeyRound size={16} aria-hidden="true" /> {busy ? 'Saving...' : 'Save password'}
          </button>
        </form>
      )}
    </Frame>
  );
}

interface Mailbox {
  to: string;
  messages: Array<{ id: string; kind: string; subject: string; body: string; link: string | null; linkStatus: string | null; sentAt: string }>;
}

const LINK_STATUS: Record<string, [string, string]> = {
  usable: ['success', 'Link ready to use'],
  used: ['', 'Link already used'],
  replaced: ['', 'Replaced by a newer link'],
  expired: ['', 'Link expired'],
  invalid: ['', 'Link not valid'],
};

/** A demo organization's delivery log: the messages sent to one address (real organizations email them). */
export function MailboxScreen({ signedInAs }: { signedInAs: string | null }) {
  const [to, setTo] = useState('');
  const [data, setData] = useState<Mailbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setData(await api.post<Mailbox>('/api/auth/delivery-log', { to }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not open the delivery log.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame>
      <h1 className="display">
        <Mail size={24} aria-hidden="true" /> Demo delivery log
      </h1>
      <p className="text-2" style={{ marginTop: 8 }}>
        In a real organization Bookhand emails enrolment and reset links to the person they are for. In this demo company they land here instead. Open only your own messages: each opening is recorded in the audit log, with the time and address, and shown to whoever approves the person's access.
      </p>
      {signedInAs && <p className="callout" style={{ marginTop: 12 }}>You are signed in as {signedInAs}; only that person's messages open here.</p>}
      <form onSubmit={submit} className="row-wrap" style={{ marginTop: 16, alignItems: 'flex-end' }}>
        <div className="field grow" style={{ minWidth: 220 }}>
          <label htmlFor={id}>Your email address</label>
          <input id={id} className="input" type="email" autoComplete="email" value={to} onChange={(e) => setTo(e.target.value)} required />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || !to.includes('@')}>
          Open my messages
        </button>
      </form>
      {error && (
        <div className="callout danger" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      {data && (
        <section aria-label={`Messages to ${data.to}`} style={{ marginTop: 20 }}>
          {data.messages.length === 0 ? (
            <p className="text-2">No messages to {data.to}.</p>
          ) : (
            <ul className="list">
              {data.messages.map((m) => (
                <li key={m.id} className="stack" style={{ gap: 6 }}>
                  <div className="row-wrap">
                    <strong className="grow">{m.subject}</strong>
                    <span className="tiny muted">{date(m.sentAt, 'time')}</span>
                  </div>
                  <p className="small text-2">{m.body}</p>
                  {m.link && (
                    <div className="row-wrap">
                      {m.linkStatus && <Badge tone={LINK_STATUS[m.linkStatus]?.[0] ?? ''}>{LINK_STATUS[m.linkStatus]?.[1] ?? m.linkStatus}</Badge>}
                      {m.linkStatus === 'usable' && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(m.link!)}>
                          <KeyRound size={14} aria-hidden="true" /> {m.kind === 'password_reset' ? 'Choose a new password' : 'Set my password'}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <p className="small" style={{ marginTop: 20 }}>
        <a href="#/">
          <ArrowLeft size={13} aria-hidden="true" /> Back to sign in
        </a>
      </p>
    </Frame>
  );
}
