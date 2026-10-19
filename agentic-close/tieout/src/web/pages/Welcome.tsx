/**
 * Pages that work without signing in: choosing a password with an invitation or password-reset
 * link (#/welcome?token=…), and, in the demo, the demo mailbox (#/mailbox) where those links
 * arrive instead of email. The mailbox opens a message only in a signed-out browser, and every
 * opening is written to the audit log: an administrator cannot quietly use someone else's link.
 */
import { KeyRound, Mail } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { api, ApiError, type LinkInfo, type Mailbox, type MailMessage } from '../api';
import { Badge, Loading } from '../components/ui';
import { useApp } from '../lib/app-state';
import { dateTime } from '../lib/format';
import { useRoute } from '../lib/router';

function Shell({ icon, title, children, wide }: { icon: ReactNode; title: string; children: ReactNode; wide?: boolean }) {
  return (
    <main className="public-page" id="main">
      <div className="public-card stack" style={{ maxWidth: wide ? 760 : 460 }}>
        <div className="row" style={{ gap: 10 }}>
          <span className="brand-mark" aria-hidden="true">
            t
          </span>
          <span className="brand-name">Tieout</span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {icon}
          <h1 style={{ fontSize: 24, margin: 0 }}>{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

const LINK = /(?:[a-z]+:\/\/[^\s/]+)?\/?#\/welcome\?token=(tkl_[0-9a-f]{64})/;

/** Choose a password with a link from an invitation or a password reset. */
export function Welcome() {
  const route = useRoute();
  const token = route.query.get('token') ?? '';
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pw, setPw] = useState({ next: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    setInfo(null);
    setProblem(null);
    api<LinkInfo>(`/auth/link?token=${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e: unknown) => setProblem(e instanceof ApiError ? e.message : 'This link could not be checked.'));
  }, [token]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pw.next !== pw.confirm) {
      setError('The two passwords are not the same.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ email: string }>('/auth/link', { body: { token, password: pw.next } });
      setDone(r.email);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the password.');
    } finally {
      setBusy(false);
    }
  }

  const icon = <KeyRound className="icon" aria-hidden="true" />;
  if (done)
    return (
      <Shell icon={icon} title="Your password is set">
        <p style={{ margin: 0 }} role="status">
          Sign in with <strong>{done}</strong> and the password you just chose. The link has stopped working.
        </p>
        <div>
          <a className="btn primary big" href="#/">
            Go to sign-in
          </a>
        </div>
      </Shell>
    );
  if (problem)
    return (
      <Shell icon={icon} title="This link does not work">
        <p className="error-text" role="alert" style={{ margin: 0 }}>
          {problem}
        </p>
        <div>
          <a className="btn" href="#/">
            Go to sign-in
          </a>
        </div>
      </Shell>
    );
  if (!info)
    return (
      <Shell icon={icon} title="Checking your link">
        <Loading label="Checking the link" />
      </Shell>
    );
  return (
    <Shell icon={icon} title={info.purpose === 'enrolment' ? `Welcome, ${info.name}` : 'Choose a new password'}>
      <p className="muted" style={{ margin: 0 }}>
        {info.purpose === 'enrolment' ? 'Choose the password you will sign in with.' : `Choose a new password for ${info.name}.`} You sign in as <strong>{info.email}</strong>. The link works once and expires on {dateTime(info.expiresAt)}.
      </p>
      <form className="stack" style={{ gap: 12 }} onSubmit={(e) => void save(e)}>
        {/* lets password managers file the new password under the right account */}
        <input type="text" name="username" autoComplete="username" value={info.email} readOnly hidden />
        <label className="field" htmlFor={`${id}-new`}>
          New password
          <input id={`${id}-new`} type="password" autoComplete="new-password" aria-describedby={`${id}-h`} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <span id={`${id}-h`} className="hint">
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
        <button className="btn primary big" type="submit" disabled={busy || pw.next.length < 12 || !pw.confirm}>
          Save password
        </button>
      </form>
    </Shell>
  );
}

/** The demo mailbox: invitations, reset links and access requests, for signed-out browsers only. */
export function DemoMailbox() {
  const { me, mfaPending, logout } = useApp();
  const signedIn = !!me || mfaPending;
  const [box, setBox] = useState<Mailbox | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<MailMessage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Mailbox>('/demo/mailbox')
      .then(setBox)
      .catch((e: unknown) => setProblem(e instanceof ApiError ? (e.status === 404 ? 'There is no demo mailbox here: outside the demo, messages go out by email.' : e.message) : 'The mailbox could not be loaded.'));
  }, []);

  async function read(id: string) {
    setError(null);
    try {
      setOpen(await api<MailMessage>(`/demo/mailbox/${id}/open`, { body: {} }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not open the message.');
    }
  }

  const icon = <Mail className="icon" aria-hidden="true" />;
  return (
    <Shell icon={icon} title="Demo mailbox" wide>
      <p className="muted" style={{ margin: 0 }}>
        In the demo, messages Tieout sends people (invitations, password-reset links, requests to approve access) arrive here instead of by email. A message opens only in a signed-out browser, and every opening is recorded in the audit log.
      </p>
      {signedIn ? (
        <div className="callout warn" role="status">
          <div>
            You are signed in{me ? ` as ${me.user.name}` : ''}. Mail here belongs to the person it is addressed to, so it does not open for a signed-in user.{' '}
            <button className="linklike" type="button" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </div>
      ) : null}
      {problem ? (
        <p className="error-text" role="alert">
          {problem}
        </p>
      ) : !box ? (
        <Loading label="Opening the mailbox" />
      ) : box.messages.length === 0 ? (
        <p>No messages yet. Invite someone or reset a password under Admin, then come back here signed out.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">To</th>
                <th scope="col">Subject</th>
                <th scope="col" className="hide-sm">
                  Sent
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {box.messages.map((m) => (
                <tr key={m.id}>
                  <td>{m.to}</td>
                  <td>
                    {m.subject} {m.openedAt ? <Badge icon={false}>Opened</Badge> : null}
                  </td>
                  <td className="hide-sm">{dateTime(m.sentAt)}</td>
                  <td className="r">
                    <button className="btn small" type="button" disabled={signedIn} onClick={() => void read(m.id)}>
                      Open<span className="sr-only"> the message to {m.to}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {open ? (
        <section className="card card-pad stack" aria-label={`Message to ${open.to}`}>
          <div>
            <strong>{open.subject}</strong>
            <div className="muted" style={{ fontSize: 13 }}>
              To {open.to} · {dateTime(open.sentAt)}
            </div>
          </div>
          <MailText text={open.text} />
        </section>
      ) : null}
      <div>
        <a href="#/">Back to sign-in</a>
      </div>
    </Shell>
  );
}

/** The message text, with its link to Tieout turned into a link that works wherever the demo runs. */
function MailText({ text }: { text: string }) {
  const m = LINK.exec(text);
  if (!m) return <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{text}</p>;
  const [before, after] = [text.slice(0, m.index), text.slice(m.index + m[0].length)];
  return (
    <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
      {before}
      <a href={`#/welcome?token=${m[1]}`}>Open the link</a>
      {after}
    </p>
  );
}
