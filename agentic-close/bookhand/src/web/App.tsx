import {
  BookOpen,
  Bot,
  Boxes,
  CalendarCheck,
  FileSpreadsheet,
  Home as HomeIcon,
  Inbox as InboxIcon,
  Keyboard,
  Landmark,
  LogOut,
  Menu,
  Moon,
  Network,
  ScrollText,
  ShieldCheck,
  Sun,
  TrendingUp,
  Upload,
  Users,
} from 'lucide-react';
import { type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, onUnauthorized, setCsrfToken, transportKind } from './lib/api';
import { invalidate, type Me, navigate, SessionContext, storage, ToastContext, useApi, useHotkeys, useRoute, useToastState } from './lib/hooks';
import { Avatar, Badge, Logo, Modal, Skeleton } from './components/ui';
import { LoginScreen, MfaScreen } from './screens/Login';
import { HomeScreen } from './screens/Home';
import { CockpitScreen } from './screens/Cockpit';
import { InboxScreen } from './screens/Inbox';
import { RecsScreen, RecWorkbench } from './screens/Recs';
import { FluxScreen } from './screens/Flux';
import { LedgerScreen } from './screens/Ledger';
import { ReportsScreen } from './screens/Reports';
import { RunsScreen, RunTrace } from './screens/Runs';
import { SkillDetail, SkillsScreen } from './screens/Skills';
import { OntologyScreen } from './screens/Ontology';
import { AuditScreen } from './screens/Audit';
import { AdminScreen } from './screens/Admin';
import { ImportsScreen } from './screens/Imports';
import { SettingsScreen } from './screens/Settings';
import { PackageScreen } from './screens/Package';

type Phase = { kind: 'loading' } | { kind: 'login' } | { kind: 'mfa' } | { kind: 'ready'; me: Me };

function applyTheme(theme: string | null) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}

export function App() {
  const toasts = useToastState();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const refresh = useCallback(async () => {
    try {
      const s = await api.get<Me | { mfaRequired: true; csrfToken: string }>('/api/session');
      if ('mfaRequired' in s) {
        setCsrfToken(s.csrfToken);
        setPhase({ kind: 'mfa' });
        return;
      }
      setCsrfToken(s.csrfToken);
      setPhase({ kind: 'ready', me: s });
    } catch (e) {
      setPhase(e instanceof ApiError && e.code === 'MFA_REQUIRED' ? { kind: 'mfa' } : { kind: 'login' });
    }
  }, []);
  useEffect(() => {
    applyTheme(storage.get('bh-theme'));
    void refresh();
    return onUnauthorized(() => setPhase({ kind: 'login' }));
  }, [refresh]);
  const signOut = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    setPhase({ kind: 'login' });
    navigate('/');
    invalidate();
  }, []);
  const session = useMemo(() => ({ me: phase.kind === 'ready' ? phase.me : null, refresh, signOut }), [phase, refresh, signOut]);
  return (
    <ToastContext.Provider value={toasts}>
      <SessionContext.Provider value={session}>
        {phase.kind === 'loading' && (
          <div className="content" style={{ maxWidth: 480, margin: '15vh auto' }}>
            <Skeleton rows={3} />
          </div>
        )}
        {phase.kind === 'login' && <LoginScreen onSignedIn={refresh} />}
        {phase.kind === 'mfa' && <MfaScreen onDone={refresh} onCancel={signOut} />}
        {phase.kind === 'ready' && <Shell me={phase.me} />}
        <div className="toasts" aria-live="polite" aria-atomic="false">
          {toasts.toasts.map((t) => (
            <div key={t.id} className={`toast${t.tone === 'error' ? ' error' : ''}`} role={t.tone === 'error' ? 'alert' : 'status'}>
              <span className="grow">{t.message}</span>
              <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'inherit', minHeight: 24 }} onClick={() => toasts.dismiss(t.id)} aria-label="Dismiss">
                ×
              </button>
            </div>
          ))}
        </div>
      </SessionContext.Provider>
    </ToastContext.Provider>
  );
}

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  permission?: string;
  count?: number;
  match: (p: string) => boolean;
}

const SHORTCUTS: Array<[string, string]> = [
  ['g h', 'Home'],
  ['g c', 'Close cockpit'],
  ['g i', 'Inbox'],
  ['g r', 'Reconciliations'],
  ['g f', 'Flux review'],
  ['g l', 'Ledger'],
  ['g p', 'Reports'],
  ['g s', 'Skills'],
  ['g o', 'Ontology'],
  ['g a', 'Audit log'],
  ['j / k', 'Next / previous item (inbox)'],
  ['a / r', 'Approve / reject (inbox)'],
  ['x', 'Select item (inbox)'],
  ['?', 'This help'],
];

function Shell({ me }: { me: Me }) {
  const route = useRoute();
  const { signOut } = useContext(SessionContext);
  const { data: home } = useApi<{ inbox: { pendingForMe: number }; close: { id: string } | null }>(me.permissions.includes('close.view') ? '/api/home' : null, { pollMs: 20_000 });
  const [navOpen, setNavOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [theme, setTheme] = useState<string | null>(storage.get('bh-theme'));
  const can = (p?: string) => !p || me.permissions.includes(p);
  const closeId = home?.close?.id;
  const items: Array<{ section: string; items: NavItem[] }> = [
    {
      section: 'Close',
      items: [
        { href: '#/', label: 'My close', icon: <HomeIcon size={17} />, match: (p) => p === '/', permission: 'close.view' },
        { href: closeId ? `#/close/${closeId}` : '#/close', label: 'Close cockpit', icon: <CalendarCheck size={17} />, match: (p) => p.startsWith('/close'), permission: 'close.view' },
        { href: '#/inbox', label: 'Inbox', icon: <InboxIcon size={17} />, match: (p) => p.startsWith('/inbox'), permission: 'proposal.view', count: home?.inbox.pendingForMe },
        { href: '#/recs', label: 'Reconciliations', icon: <Landmark size={17} />, match: (p) => p.startsWith('/recs'), permission: 'rec.view' },
        { href: '#/flux', label: 'Flux review', icon: <TrendingUp size={17} />, match: (p) => p.startsWith('/flux'), permission: 'flux.view' },
      ],
    },
    {
      section: 'Books',
      items: [
        { href: '#/ledger', label: 'Journal entries', icon: <BookOpen size={17} />, match: (p) => p.startsWith('/ledger'), permission: 'je.view' },
        { href: '#/reports', label: 'Statements & TB', icon: <FileSpreadsheet size={17} />, match: (p) => p.startsWith('/reports'), permission: 'reports.view' },
        { href: '#/imports', label: 'Imports', icon: <Upload size={17} />, match: (p) => p.startsWith('/imports'), permission: 'close.view' },
      ],
    },
    {
      section: 'Agents & controls',
      items: [
        { href: '#/runs', label: 'Agent runs', icon: <Bot size={17} />, match: (p) => p.startsWith('/runs'), permission: 'skill.view' },
        { href: '#/skills', label: 'Skills & policies', icon: <Boxes size={17} />, match: (p) => p.startsWith('/skills'), permission: 'skill.view' },
        { href: '#/ontology', label: 'Ontology', icon: <Network size={17} />, match: (p) => p.startsWith('/ontology'), permission: 'ontology.view' },
        { href: '#/audit', label: 'Audit log', icon: <ScrollText size={17} />, match: (p) => p.startsWith('/audit'), permission: 'audit.view' },
        { href: '#/admin', label: 'Admin', icon: <Users size={17} />, match: (p) => p.startsWith('/admin'), permission: 'admin.users' },
      ],
    },
  ];
  useHotkeys({
    'g h': () => navigate('/'),
    'g c': () => navigate(closeId ? `/close/${closeId}` : '/'),
    'g i': () => navigate('/inbox'),
    'g r': () => navigate('/recs'),
    'g f': () => navigate('/flux'),
    'g l': () => navigate('/ledger'),
    'g p': () => navigate('/reports'),
    'g s': () => navigate('/skills'),
    'g o': () => navigate('/ontology'),
    'g a': () => navigate('/audit'),
    '?': () => setHelp(true),
  });
  useEffect(() => setNavOpen(false), [route.path]);
  const toggleTheme = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    const next = dark ? 'light' : 'dark';
    storage.set('bh-theme', next);
    setTheme(next);
    applyTheme(next);
  };
  const crumb = items.flatMap((sec) => sec.items).find((i) => i.match(route.path))?.label ?? (route.path.startsWith('/settings') ? 'Settings' : 'Bookhand');
  const s = route.segments;
  let page: ReactNode;
  if (route.path === '/') page = <HomeScreen />;
  else if (s[0] === 'close' && s[1] && s[2] === 'package') page = <PackageScreen closeId={s[1]} />;
  else if (s[0] === 'close') page = <CockpitScreen closeId={s[1] ?? closeId ?? null} />;
  else if (s[0] === 'inbox') page = <InboxScreen initialId={s[1] ?? null} view={route.query.get('view')} />;
  else if (s[0] === 'recs' && s[1]) page = <RecWorkbench id={s[1]} />;
  else if (s[0] === 'recs') page = <RecsScreen />;
  else if (s[0] === 'flux') page = <FluxScreen />;
  else if (s[0] === 'ledger') page = <LedgerScreen entryId={s[1] ?? null} query={route.query} />;
  else if (s[0] === 'reports') page = <ReportsScreen query={route.query} />;
  else if (s[0] === 'runs' && s[1]) page = <RunTrace id={s[1]} />;
  else if (s[0] === 'runs') page = <RunsScreen />;
  else if (s[0] === 'skills' && s[1]) page = <SkillDetail skillKey={s[1]} />;
  else if (s[0] === 'skills') page = <SkillsScreen />;
  else if (s[0] === 'ontology') page = <OntologyScreen termId={s[1] ? decodeURIComponent(s[1]) : null} />;
  else if (s[0] === 'audit') page = <AuditScreen />;
  else if (s[0] === 'admin') page = <AdminScreen />;
  else if (s[0] === 'imports') page = <ImportsScreen />;
  else if (s[0] === 'settings') page = <SettingsScreen />;
  else page = <div className="empty"><h3>Page not found</h3><a href="#/">Go home</a></div>;
  return (
    <div className="shell">
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>
        Skip to content
      </a>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <aside className="sidebar" data-open={navOpen} aria-label="Primary">
        <div className="brand">
          <Logo />
          <div>
            Bookhand
            <small>{me.tenant?.name ?? ''}</small>
          </div>
        </div>
        <nav className="nav">
          {items.map((sec) => {
            const visible = sec.items.filter((i) => can(i.permission));
            if (!visible.length) return null;
            return (
              <div key={sec.section}>
                <div className="nav-section">{sec.section}</div>
                {visible.map((i) => (
                  <a key={i.label} href={i.href} aria-current={i.match(route.path) ? 'page' : undefined}>
                    {i.icon}
                    <span>{i.label}</span>
                    {!!i.count && <span className="count" aria-label={`${i.count} waiting`}>{i.count}</span>}
                  </a>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="row" style={{ gap: 6 }}>
            <ShieldCheck size={14} aria-hidden="true" />
            <span>{me.mode.live ? `Live agents: ${me.mode.model}` : 'Offline agents (deterministic)'}</span>
          </div>
          <div style={{ marginTop: 6 }}>Business date {me.tenant?.businessDate}</div>
        </div>
      </aside>
      <div className="main">
        {transportKind() === 'demo' && (
          <div className="demo-banner" role="note">
            <strong>Zero-install demo.</strong>
            <span>Everything runs in this browser tab against a fictional company; nothing is sent anywhere and reloading starts over.</span>
          </div>
        )}
        <header className="topbar">
          <button type="button" className="btn btn-ghost btn-icon mobile-nav-toggle" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <Menu size={18} />
          </button>
          <span className="crumb">{crumb}</span>
          <span className="spacer" />
          {/* On a phone the sidebar footer states the agent mode, and keyboard shortcuts do not apply. */}
          <span className="hide-sm">
            <Badge tone={me.mode.live ? 'violet' : ''} title={me.mode.live ? 'Agents call Claude; deterministic checks still verify every proposal' : 'No API key configured: agents use the deterministic offline engine'}>
              {me.mode.live ? 'Live' : 'Offline'} agents
            </Badge>
          </span>
          <button type="button" className="btn btn-ghost btn-icon hide-sm" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts">
            <Keyboard size={18} />
          </button>
          <button type="button" className="btn btn-ghost btn-icon" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <a href="#/settings" className="row" style={{ color: 'inherit' }}>
            <Avatar name={me.user.name} hue={me.user.hue} />
            <span className="small user-meta" style={{ lineHeight: 1.2 }}>
              <span style={{ display: 'block', fontWeight: 600 }}>{me.user.name}</span>
              <span className="muted">{me.roles.map((r) => r.name).join(', ')}</span>
            </span>
            <span className="sr-only">Your settings</span>
          </a>
          <button type="button" className="btn btn-ghost btn-icon" onClick={() => void signOut()} aria-label="Sign out">
            <LogOut size={18} />
          </button>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {page}
        </main>
      </div>
      {help && (
        <Modal title="Keyboard shortcuts" onClose={() => setHelp(false)}>
          <table className="table">
            <tbody>
              {SHORTCUTS.map(([k, d]) => (
                <tr key={k}>
                  <td>
                    <span className="kbd">{k}</span>
                  </td>
                  <td>{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}

