import { KeyRound, Monitor, Moon, ShieldCheck, Smartphone, Sun } from 'lucide-react';
import { useContext, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { SessionContext, storage, useAction, useMe } from '../lib/hooks';
import { Avatar, Badge, Term } from '../components/ui';

interface MfaSetup {
  secret: string;
  otpauthUrl: string;
  qr: boolean[][];
}

/** Renders a QR matrix as crisp SVG rectangles (dark modules on a white quiet zone, in any theme). */
function QrCode({ matrix, label: text }: { matrix: boolean[][]; label: string }) {
  const path = useMemo(() => {
    let d = '';
    matrix.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return d;
  }, [matrix]);
  const n = matrix.length;
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={196} height={196} role="img" aria-label={text} className="qr" shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

function applyTheme(theme: string | null) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}

export function SettingsScreen() {
  const me = useMe();
  const { refresh } = useContext(SessionContext);
  const { run, busy } = useAction();
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [code, setCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [theme, setTheme] = useState<string>(storage.get('bh-theme') ?? 'system');
  const pwMismatch = pw.confirm.length > 0 && pw.next !== pw.confirm;
  const chooseTheme = (t: string) => {
    setTheme(t);
    storage.set('bh-theme', t === 'system' ? '' : t);
    applyTheme(t === 'system' ? null : t);
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Your settings</h1>
          <div className="sub">Sign-in security, password and appearance.</div>
        </div>
      </div>
      <div className="grid grid-2">
        <section className="card card-pad stack" aria-labelledby="profile-h">
          <h2 id="profile-h" style={{ fontSize: 15 }}>
            Profile
          </h2>
          <div className="row">
            <Avatar name={me.user.name} hue={me.user.hue} size={44} />
            <div>
              <div style={{ fontWeight: 650, fontSize: 16 }}>{me.user.name}</div>
              <div className="small muted">
                {me.user.email}
                {me.user.title ? ` · ${me.user.title}` : ''}
              </div>
            </div>
          </div>
          <dl className="facts small">
            <dt>Roles</dt>
            <dd>
              <span className="row-wrap">
                {me.roles.map((r) => (
                  <Badge key={r.key}>{r.name}</Badge>
                ))}
              </span>
            </dd>
            <dt>
              <Term id="bh:ApprovalLimit">Approval limit</Term>
            </dt>
            <dd>{me.readOnly ? 'Read-only: no approvals' : me.approvalLimit === null ? 'Unlimited' : me.approvalLimit === 0 ? 'No approvals' : `Up to ${money(me.approvalLimit, 'USD', { cents: false })} per item`}</dd>
            <dt>Company</dt>
            <dd>
              {me.tenant?.name}
              {me.tenant?.isDemo && !/fictional/i.test(me.tenant.name) ? ' (fictional demo company)' : ''}
            </dd>
          </dl>
        </section>
        <section className="card card-pad stack" aria-labelledby="theme-h">
          <h2 id="theme-h" style={{ fontSize: 15 }}>
            Appearance
          </h2>
          <div className="segmented" role="radiogroup" aria-labelledby="theme-h">
            {[
              { id: 'system', label: 'System', icon: <Monitor size={15} aria-hidden="true" /> },
              { id: 'light', label: 'Light', icon: <Sun size={15} aria-hidden="true" /> },
              { id: 'dark', label: 'Dark', icon: <Moon size={15} aria-hidden="true" /> },
            ].map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={theme === t.id || (t.id === 'system' && !theme)} className="segment" onClick={() => chooseTheme(t.id)}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          <p className="hint">Saved in this browser only.</p>
        </section>
      </div>
      <section className="card card-pad stack" aria-labelledby="mfa-h">
        <div className="row">
          <h2 id="mfa-h" style={{ fontSize: 15 }} className="grow">
            <Smartphone size={16} aria-hidden="true" /> Two-step sign-in
          </h2>
          <Badge tone={me.user.mfaEnabled ? 'success' : 'attention'}>{me.user.mfaEnabled ? 'On' : 'Off'}</Badge>
        </div>
        {me.user.mfaEnabled ? (
          <div className="stack">
            <p className="small text-2">Each sign-in asks for a 6-digit code from your authenticator app. To turn it off, enter a current code.</p>
            <div className="row-wrap" style={{ alignItems: 'flex-end' }}>
              <div className="field" style={{ width: 180 }}>
                <label htmlFor="mfa-off">Current code</label>
                <input id="mfa-off" className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={disableCode} onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ''))} />
              </div>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy || disableCode.length !== 6}
                onClick={async () => {
                  const r = await run(() => api.post('/api/me/mfa/disable', { code: disableCode }), 'Two-step sign-in turned off.');
                  if (r) {
                    setDisableCode('');
                    await refresh();
                  }
                }}
              >
                Turn off
              </button>
            </div>
          </div>
        ) : !setup ? (
          <div className="stack">
            <p className="small text-2">Protect your account with a time-based code (TOTP) from an authenticator app such as 1Password, Google Authenticator or Authy.</p>
            <div>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(async () => setSetup(await api.post<MfaSetup>('/api/me/mfa/setup')))}>
                <ShieldCheck size={15} aria-hidden="true" /> Set up authenticator
              </button>
            </div>
          </div>
        ) : (
          <div className="mfa-setup">
            <QrCode matrix={setup.qr} label="QR code to add Bookhand to your authenticator app" />
            <div className="stack">
              <ol className="small steps">
                <li>Scan the code with your authenticator app.</li>
                <li>
                  Or enter this key by hand: <code className="secret">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
                </li>
                <li>Type the 6-digit code it shows to finish.</li>
              </ol>
              <div className="row-wrap" style={{ alignItems: 'flex-end' }}>
                <div className="field" style={{ width: 180 }}>
                  <label htmlFor="mfa-code">6-digit code</label>
                  <input id="mfa-code" className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || code.length !== 6}
                  onClick={async () => {
                    const r = await run(() => api.post('/api/me/mfa/enable', { code }), 'Two-step sign-in is on.');
                    if (r) {
                      setSetup(null);
                      setCode('');
                      await refresh();
                    }
                  }}
                >
                  Turn on
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setSetup(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
      <section className="card card-pad stack" aria-labelledby="pw-h">
        <h2 id="pw-h" style={{ fontSize: 15 }}>
          <KeyRound size={16} aria-hidden="true" /> Change password
        </h2>
        <form
          className="grid grid-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => api.post('/api/me/password', { current: pw.current, next: pw.next }), 'Password changed. Your other sessions were signed out.');
            if (r) setPw({ current: '', next: '', confirm: '' });
          }}
        >
          <div className="field">
            <label htmlFor="pw-current">Current password</label>
            <input id="pw-current" type="password" className="input" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pw-next">New password</label>
            <input id="pw-next" type="password" className="input" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} aria-describedby="pw-hint" />
          </div>
          <div className="field">
            <label htmlFor="pw-confirm">Repeat new password</label>
            <input id="pw-confirm" type="password" className="input" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} aria-invalid={pwMismatch} />
            {pwMismatch && <span className="error-text">Passwords do not match.</span>}
          </div>
          <div className="row-wrap" style={{ gridColumn: '1 / -1' }}>
            <span id="pw-hint" className="hint grow">
              At least 12 characters; not your name or email. Stored as a salted scrypt hash.
            </span>
            <button type="submit" className="btn btn-primary" disabled={busy || !pw.current || pw.next.length < 12 || pw.next !== pw.confirm}>
              Change password
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
