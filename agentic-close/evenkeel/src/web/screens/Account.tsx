import { KeyRound, ShieldCheck, Smartphone } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { errorMessage, useBackend } from '../lib/api';
import { ROLE_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';
import { useToast } from '../lib/toast';
import { Badge, Button, Card, Field, Kv, Notice, PageHead, Seg } from '../ui/kit';

function TwoStep() {
  const backend = useBackend();
  const { info, refresh } = useSession();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sec = backend.security;
  if (!sec) return null;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const enabled = info.user.mfaEnabled;
  return (
    <Card title="Two-step sign-in" hint="Time-based one-time codes (RFC 6238) from an authenticator app">
      <div className="stack">
        <div className="row">
          <Smartphone size={18} aria-hidden />
          <span>{enabled ? <Badge tone="good">On</Badge> : <Badge>Off</Badge>}</span>
        </div>
        {!enabled && !setup && (
          <div>
            <Button variant="primary" busy={busy} onClick={() => void run(async () => setSetup(await sec.setupMfa()))} data-testid="mfa-setup">
              Set up two-step sign-in
            </Button>
          </div>
        )}
        {!enabled && setup && (
          <>
            <Notice tone="info">Add a new account in your authenticator app with this setup key, then enter the 6-digit code it shows.</Notice>
            <Kv items={[['Setup key', <code key="k" data-testid="mfa-secret" style={{ wordBreak: 'break-all' }}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>], ['Link', <code key="u" className="xs" style={{ wordBreak: 'break-all' }}>{setup.otpauthUri}</code>]]} />
          </>
        )}
        {(setup || enabled) && (
          <form
            className="stack"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run(async () => {
                if (enabled) await sec.disableMfa(code);
                else await sec.enableMfa(code);
                toast.push({ tone: 'good', text: enabled ? 'Two-step sign-in is off.' : 'Two-step sign-in is on. You will be asked for a code when you sign in.' });
                setSetup(null);
                setCode('');
                await refresh();
              });
            }}
          >
            <Field label={enabled ? 'Enter a current code to turn it off' : 'Code from your app'} htmlFor="mfa-code" error={error}>
              <input id="mfa-code" className="input mono" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={8} style={{ maxWidth: 200 }} />
            </Field>
            <div>
              <Button type="submit" variant={enabled ? 'danger' : 'primary'} busy={busy} disabled={code.replace(/\s/g, '').length < 6}>
                {enabled ? 'Turn off' : 'Turn on'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

function PasswordForm() {
  const backend = useBackend();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sec = backend.security;
  if (!sec) return null;
  return (
    <Card title="Password" hint="At least 12 characters. Changing it signs out your other sessions.">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          sec
            .changePassword(current, next)
            .then(() => {
              toast.push({ tone: 'good', text: 'Password changed. Other sessions were signed out.' });
              setCurrent('');
              setNext('');
            })
            .catch((err: unknown) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        <Field label="Current password" htmlFor="pw-cur">
          <input id="pw-cur" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" htmlFor="pw-new" error={error} help="A long passphrase is better than a short complex password.">
          <input id="pw-new" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <div>
          <Button type="submit" variant="primary" icon={<KeyRound size={16} aria-hidden />} busy={busy} disabled={!current || next.length < 12}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function Account() {
  const { info } = useSession();
  const [theme, setTheme] = useTheme();
  const u = info.user;
  return (
    <div className="page">
      <PageHead eyebrow="Account" title={u.name} sub={`${u.title ?? ''} · ${u.email}`} />
      <div className="grid grid-2">
        <Card title="Your access">
          <div className="stack small">
            <div className="row-wrap">
              {u.roles.map((r) => (
                <Badge key={r} tone="accent">
                  {ROLE_LABEL[r] ?? r}
                </Badge>
              ))}
            </div>
            <div className="chip-list">
              {u.permissions.map((p) => (
                <span key={p} className="chip">
                  {p}
                </span>
              ))}
            </div>
          </div>
        </Card>
        <Card title="Appearance">
          <Seg
            label="Theme"
            value={theme}
            onChange={setTheme}
            items={[
              { value: 'system', label: 'Match device' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Card>
        {info.mode === 'server' ? (
          <>
            <TwoStep />
            <PasswordForm />
          </>
        ) : (
          <Card title="Security">
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <ShieldCheck size={18} aria-hidden color="var(--good)" />
              <p className="small ink2">The demo signs you in as a persona. The full product uses scrypt-hashed passwords, optional TOTP two-step codes, HttpOnly session cookies that expire and rotate, CSRF tokens and rate-limited sign-in.</p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
