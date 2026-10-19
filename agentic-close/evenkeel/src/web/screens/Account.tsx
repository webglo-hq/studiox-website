import { Copy, KeyRound, Plug, ShieldCheck, Smartphone } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { errorMessage, useAction, useApi, useBackend } from '../lib/api';
import { date, ROLE_LABEL, when } from '../lib/format';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';
import { useToast } from '../lib/toast';
import { Badge, Button, Card, Field, Kv, Notice, PageHead, Query, Seg } from '../ui/kit';

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

/** Personal API tokens for the MCP server and scripts: shown once, stored as a hash, revocable. */
function ApiTokens() {
  const q = useApi('account.tokens', {});
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState('90');
  const [created, setCreated] = useState<string | null>(null);
  const toast = useToast();
  const create = useAction('account.createToken', {
    success: 'Token created. Copy it now; it will not be shown again.',
    onSuccess: (o) => {
      setCreated(o.token);
      setName('');
    },
  });
  const revoke = useAction('account.revokeToken', { success: 'Token revoked.' });
  const config = created ? JSON.stringify({ mcpServers: { evenkeel: { command: 'node', args: ['<path-to-evenkeel>/scripts/mcp.mjs'], env: { EVENKEEL_URL: window.location.origin, EVENKEEL_TOKEN: created } } } }, null, 2) : '';
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => toast.push({ tone: 'good', text: 'Copied.' }),
      () => toast.push({ tone: 'bad', text: 'Copy failed; select the text instead.' }),
    );
  };
  return (
    <Card title="API tokens" hint="For the MCP server (Claude and other AI assistants) and scripts. A token acts as you, with your role and the same approval rules.">
      <div className="stack">
        {created && (
          <Notice tone="good" title="Your new token">
            <div className="stack" style={{ gap: 8 }}>
              <code className="xs" style={{ wordBreak: 'break-all' }} data-testid="new-token">
                {created}
              </code>
              <div className="row-wrap">
                <Button size="s" icon={<Copy size={14} aria-hidden />} onClick={() => copy(created)}>
                  Copy token
                </Button>
                <Button size="s" variant="quiet" icon={<Plug size={14} aria-hidden />} onClick={() => copy(config)}>
                  Copy MCP client config
                </Button>
                <Button size="s" variant="quiet" onClick={() => setCreated(null)}>
                  Done
                </Button>
              </div>
              <span className="xs ink2">It is shown only now. Evenkeel stores a hash, never the token.</span>
            </div>
          </Notice>
        )}
        <Query q={q} rows={2}>
          {(tokens) =>
            tokens.length ? (
              <ul className="stack small" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 8 }}>
                {tokens.map((t) => (
                  <li key={t.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <span>
                      <strong>{t.name}</strong> {t.scopes.includes('write') ? <Badge tone="warn">can make changes</Badge> : <Badge>read only</Badge>} {!t.active && <Badge tone="bad">{t.revokedAt ? 'revoked' : 'expired'}</Badge>}
                      <div className="xs muted">
                        Created {date(t.createdAt, 'short')} · {t.lastUsedAt ? `last used ${when(t.lastUsedAt)}` : 'never used'} · {t.expiresAt ? `expires ${date(t.expiresAt, 'short')}` : 'no expiry'}
                      </div>
                    </span>
                    {t.active && (
                      <Button size="s" variant="quiet" busy={revoke.isPending} onClick={() => revoke.mutate({ id: t.id })}>
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">No tokens yet.</p>
            )
          }
        </Query>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name, write, days: Number(days) });
          }}
        >
          <div className="grid grid-2">
            <Field label="Name" htmlFor="tok-name" help="Where you will use it, e.g. Claude Desktop.">
              <input id="tok-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            </Field>
            <Field label="Expires after" htmlFor="tok-days">
              <select id="tok-days" className="select" value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
              </select>
            </Field>
          </div>
          <label className="check small">
            <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> Allow changes (approve, reject, run agents). Without this the token can only read.
          </label>
          <div>
            <Button type="submit" variant="primary" icon={<KeyRound size={16} aria-hidden />} busy={create.isPending} disabled={name.trim().length < 3}>
              Create token
            </Button>
          </div>
        </form>
      </div>
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
            <ApiTokens />
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
