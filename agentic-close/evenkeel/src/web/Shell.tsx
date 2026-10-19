import {
  BookOpen,
  Bot,
  CalendarCheck2,
  FileCheck2,
  FileText,
  GitCompareArrows,
  Home,
  Inbox,
  Landmark,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Network,
  ScrollText,
  Search,
  ShieldAlert,
  Sparkles,
  Sun,
  TrendingUp,
  UserCog,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentsProvider, useAgents } from './lib/agents';
import { useApi } from './lib/api';
import { period } from './lib/format';
import { href, navigate, useRoute, type Route } from './lib/router';
import { useSession } from './lib/session';
import { useTheme, type ThemeChoice } from './lib/theme';
import { Account } from './screens/Account';
import { Admin } from './screens/Admin';
import { AuditLog } from './screens/Audit';
import { Cockpit } from './screens/Cockpit';
import { FluxReview } from './screens/Flux';
import { AgentInbox } from './screens/Inbox';
import { Issues } from './screens/Issues';
import { Journals } from './screens/Journals';
import { MyClose } from './screens/MyClose';
import { OntologyExplorer } from './screens/Ontology';
import { ClosePackage } from './screens/Package';
import { Reconciliations } from './screens/Recs';
import { Reports, SourceDocumentPage, SourceRecordPage } from './screens/Reports';
import { Runs } from './screens/Runs';
import { Skills } from './screens/Skills';
import { BrandMark } from './ui/brand';
import { Avatar, Button, Dialog, Empty, Kbd } from './ui/kit';

interface NavItem {
  key: string;
  label: string;
  path: string;
  icon: ReactNode;
  shortcut: string;
  permission?: string;
  group: 'Close' | 'Ledger' | 'Agents' | 'Govern';
}

const NAV: NavItem[] = [
  { key: '', label: 'My close', path: '/', icon: <Home size={18} aria-hidden />, shortcut: 'h', group: 'Close' },
  { key: 'cockpit', label: 'Close cockpit', path: '/cockpit', icon: <CalendarCheck2 size={18} aria-hidden />, shortcut: 'c', group: 'Close' },
  { key: 'inbox', label: 'Agent inbox', path: '/inbox', icon: <Inbox size={18} aria-hidden />, shortcut: 'i', group: 'Close' },
  { key: 'recs', label: 'Reconciliations', path: '/recs', icon: <GitCompareArrows size={18} aria-hidden />, shortcut: 'r', group: 'Close' },
  { key: 'flux', label: 'Flux review', path: '/flux', icon: <TrendingUp size={18} aria-hidden />, shortcut: 'f', group: 'Close', permission: 'report.view' },
  { key: 'issues', label: 'Exceptions', path: '/issues', icon: <ShieldAlert size={18} aria-hidden />, shortcut: 'e', group: 'Close' },
  { key: 'package', label: 'Close package', path: '/package', icon: <FileCheck2 size={18} aria-hidden />, shortcut: 'p', group: 'Close', permission: 'report.view' },
  { key: 'journals', label: 'Journal entries', path: '/journals', icon: <FileText size={18} aria-hidden />, shortcut: 'j', group: 'Ledger', permission: 'report.view' },
  { key: 'reports', label: 'Statements & TB', path: '/reports', icon: <Landmark size={18} aria-hidden />, shortcut: 't', group: 'Ledger', permission: 'report.view' },
  { key: 'runs', label: 'Agent runs', path: '/runs', icon: <Bot size={18} aria-hidden />, shortcut: 'a', group: 'Agents' },
  { key: 'skills', label: 'Skills & policies', path: '/skills', icon: <Sparkles size={18} aria-hidden />, shortcut: 's', group: 'Agents' },
  { key: 'ontology', label: 'Ontology', path: '/ontology', icon: <Network size={18} aria-hidden />, shortcut: 'o', group: 'Govern', permission: 'ontology.view' },
  { key: 'audit', label: 'Audit log', path: '/audit', icon: <ScrollText size={18} aria-hidden />, shortcut: 'l', group: 'Govern', permission: 'audit.view' },
  { key: 'admin', label: 'Admin', path: '/admin', icon: <Users size={18} aria-hidden />, shortcut: 'd', group: 'Govern' },
];

function screenFor(route: Route): ReactNode {
  const [first = '', ...rest] = route.path;
  switch (first) {
    case '':
      return <MyClose />;
    case 'cockpit':
      return <Cockpit />;
    case 'inbox':
      return <AgentInbox route={route} openId={rest[0] ?? null} />;
    case 'recs':
      return <Reconciliations route={route} openId={rest[0] ?? null} />;
    case 'flux':
      return <FluxReview route={route} />;
    case 'issues':
      return <Issues />;
    case 'package':
      return <ClosePackage />;
    case 'journals':
      return <Journals route={route} openId={rest[0] ?? null} />;
    case 'reports':
      return <Reports route={route} />;
    case 'records':
      return <SourceRecordPage type={rest[0] ?? ''} id={rest[1] ?? ''} />;
    case 'documents':
      return <SourceDocumentPage id={rest[0] ?? ''} />;
    case 'runs':
      return <Runs route={route} openId={rest[0] ?? null} />;
    case 'skills':
      return <Skills openId={rest[0] ?? null} />;
    case 'ontology':
      return <OntologyExplorer route={route} termId={rest[0] ?? null} />;
    case 'audit':
      return <AuditLog route={route} />;
    case 'admin':
      return <Admin route={route} />;
    case 'account':
      return <Account />;
    default:
      return (
        <div className="page">
          <Empty title="Page not found" action={<a href="#/">Go to My close</a>}>
            The link may be out of date.
          </Empty>
        </div>
      );
  }
}

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const next: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
  const icon = theme === 'dark' ? <Moon size={16} aria-hidden /> : theme === 'light' ? <Sun size={16} aria-hidden /> : <Monitor size={16} aria-hidden />;
  return (
    <Button variant="quiet" size="s" icon={icon} onClick={() => setTheme(next[theme])} aria-label={`Theme: ${theme}. Switch to ${next[theme]}`} title={`Theme: ${theme === 'system' ? 'match device' : theme}`} />
  );
}

function Palette({ onClose, items }: { onClose: () => void; items: NavItem[] }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const terms = useApi('ontology.search', { q }, { enabled: q.trim().length >= 2, keepPrevious: true });
  const ql = q.trim().toLowerCase();
  const results: { label: string; hint: string; go: string; icon: ReactNode }[] = [
    ...items.filter((i) => !ql || i.label.toLowerCase().includes(ql)).map((i) => ({ label: i.label, hint: `g ${i.shortcut}`, go: href(i.path), icon: i.icon })),
    ...(ql.length >= 2 ? (terms.data ?? []).slice(0, 8).map((t) => ({ label: t.label, hint: `${t.kind} · ${t.id}`, go: href(`/ontology/${encodeURIComponent(t.id)}`), icon: <BookOpen size={18} aria-hidden /> })) : []),
    { label: 'Account & security', hint: '', go: href('/account'), icon: <UserCog size={18} aria-hidden /> },
  ].filter((r, i, all) => all.findIndex((x) => x.go === r.go) === i);
  const pick = (i: number) => {
    const r = results[i];
    if (!r) return;
    navigate(r.go);
    onClose();
  };
  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog palette" role="dialog" aria-modal="true" aria-label="Go to">
        <input
          autoFocus
          placeholder="Go to a page or look up a term (accrual, materiality…)"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(results.length - 1, s + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === 'Enter') pick(sel);
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={`pal-${sel}`}
          aria-label="Search pages and terms"
        />
        <ul id="palette-list" role="listbox">
          {results.map((r, i) => (
            <li key={r.go} role="presentation">
              <button id={`pal-${i}`} type="button" role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
                {r.icon}
                <span className="grow">{r.label}</span>
                <span className="xs muted mono">{r.hint}</span>
              </button>
            </li>
          ))}
          {!results.length && <li className="small muted" style={{ padding: 12 }}>No matches.</li>}
        </ul>
      </div>
    </div>
  );
}

function ShortcutsHelp({ onClose, items }: { onClose: () => void; items: NavItem[] }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <table className="table">
        <tbody>
          <tr>
            <td>
              <Kbd>/</Kbd> or <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>
            </td>
            <td>Go to a page or look up a term</td>
          </tr>
          <tr>
            <td>
              <Kbd>?</Kbd>
            </td>
            <td>This help</td>
          </tr>
          {items.map((i) => (
            <tr key={i.key}>
              <td>
                <Kbd>g</Kbd> <Kbd>{i.shortcut}</Kbd>
              </td>
              <td>{i.label}</td>
            </tr>
          ))}
          <tr>
            <td>
              <Kbd>j</Kbd> <Kbd>k</Kbd>
            </td>
            <td>Agent inbox: move between proposals</td>
          </tr>
          <tr>
            <td>
              <Kbd>x</Kbd>
            </td>
            <td>Agent inbox: select the current proposal</td>
          </tr>
          <tr>
            <td>
              <Kbd>a</Kbd> / <Kbd>r</Kbd>
            </td>
            <td>Agent inbox: approve / reject the selection</td>
          </tr>
          <tr>
            <td>
              <Kbd>Enter</Kbd>
            </td>
            <td>Agent inbox: open the current proposal</td>
          </tr>
        </tbody>
      </table>
    </Dialog>
  );
}

export function Shell() {
  return (
    <AgentsProvider>
      <ShellInner />
    </AgentsProvider>
  );
}

function ShellInner() {
  const route = useRoute();
  const { info, can, signOut } = useSession();
  const user = info.user;
  const [navOpen, setNavOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const activity = useAgents();
  const inbox = useApi('inbox.list', { tab: 'mine', limit: 1 }, { staleTime: 10_000 });
  const items = useMemo(() => NAV.filter((n) => !n.permission || can(n.permission)).filter((n) => n.key !== 'admin' || can('admin.users') || can('period.lock') || can('audit.view')), [can]);
  const main = useRef<HTMLElement>(null);
  const first = route.path[0] ?? '';
  const current = items.find((i) => i.key === first);

  useEffect(() => {
    setNavOpen(false);
    // Move focus to the page for screen-reader and keyboard users after navigation.
    main.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [first]);

  useEffect(() => {
    let pendingG = false;
    let timer: number | undefined;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === '/') {
        e.preventDefault();
        setPalette(true);
      } else if (e.key === '?') setHelp(true);
      else if (e.key === 'g') {
        pendingG = true;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => (pendingG = false), 1200);
      } else if (pendingG) {
        pendingG = false;
        const target = items.find((i) => i.shortcut === e.key);
        if (target) navigate(href(target.path));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items]);

  const groups = ['Close', 'Ledger', 'Agents', 'Govern'] as const;
  const pendingMine = inbox.data?.counts.mine ?? 0;

  return (
    <>
      {info.mode === 'demo' && (
        <div className="banner-demo">
          Demo · runs entirely in your browser on invented data for the fictional Kitewell Labs · nothing is sent anywhere
        </div>
      )}
      <a href="#main" className="skip-link" onClick={(e) => (e.preventDefault(), main.current?.focus())}>
        Skip to content
      </a>
      <div className="shell" data-nav-open={navOpen}>
        {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden />}
        <aside className="sidebar" aria-label="Main navigation">
          <a className="brand" href="#/" aria-label="Evenkeel home">
            <BrandMark />
            <span className="brand-name">Evenkeel</span>
          </a>
          <div className="company">
            <div className="name">{user.tenant.name.replace(/\s*\(fictional demo company\)/i, '')}</div>
            <div className="meta">Fictional demo company · {user.tenant.reportingCurrency}</div>
          </div>
          <nav className="nav">
            {groups.map((g) => {
              const list = items.filter((i) => i.group === g);
              if (!list.length) return null;
              return (
                <div key={g}>
                  <div className="nav-group-label">{g}</div>
                  {list.map((i) => (
                    <a key={i.key} className="nav-item" href={href(i.path)} aria-current={i.key === first ? 'page' : undefined}>
                      {i.icon}
                      <span>{i.label}</span>
                      {i.key === 'inbox' && pendingMine > 0 && (
                        <span className="count" aria-label={`${pendingMine} waiting for you`}>
                          {pendingMine}
                        </span>
                      )}
                    </a>
                  ))}
                </div>
              );
            })}
          </nav>
          <div className="sidebar-foot">
            <div className="engine-chip" title={info.engine === 'live' ? 'Agents reason with Claude through the Anthropic API' : 'Deterministic offline engine: same tools, verification and approvals, no model calls'}>
              <span className={`dot ${activity?.running ? 'accent pulse' : info.engine === 'live' ? 'good' : ''}`} aria-hidden />
              {activity?.running ? 'Agents are working…' : info.engine === 'live' ? 'Live agents (Claude)' : 'Offline agent engine'}
            </div>
            <div className="row" style={{ gap: 2 }}>
              <a className="nav-item grow" href={href('/account')} aria-current={first === 'account' ? 'page' : undefined} title="Account and security">
                <Avatar name={user.name} size="s" />
                <span className="grow stack" style={{ gap: 0, minWidth: 0 }}>
                  <span className="small strong ellipsis">{user.name}</span>
                  <span className="xs muted ellipsis">{user.title}</span>
                </span>
              </a>
              <ThemeSwitch />
              <Button variant="quiet" size="s" icon={<LogOut size={16} aria-hidden />} onClick={() => void signOut()} aria-label={info.mode === 'demo' ? 'Switch person' : 'Sign out'} title={info.mode === 'demo' ? 'Switch person' : 'Sign out'} data-testid="sign-out" />
            </div>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <Button variant="quiet" className="menu-btn" aria-label="Open navigation" aria-expanded={navOpen} onClick={() => setNavOpen(true)} icon={<Menu size={20} aria-hidden />} />
            <div className="crumb ellipsis">
              <strong>{current?.label ?? (first === 'account' ? 'Account' : first === 'records' || first === 'documents' ? 'Source' : 'Evenkeel')}</strong>
              {activity?.periodKey && <span className="period"> · {period(activity.periodKey)} close</span>}
            </div>
            {activity?.running && (
              <span className="badge t-accent" role="status">
                <span className="spinner" style={{ width: 12, height: 12 }} aria-hidden /> Agents working
              </span>
            )}
            <button type="button" className="search-btn" onClick={() => setPalette(true)} aria-label="Search pages and terms">
              <Search size={16} aria-hidden />
              <span className="label small">Go to or look up…</span>
              <Kbd>/</Kbd>
            </button>
          </header>
          <main id="main" ref={main} tabIndex={-1} style={{ outline: 'none' }}>
            {screenFor(route)}
          </main>
        </div>
      </div>
      {palette && <Palette onClose={() => setPalette(false)} items={items} />}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} items={items} />}
    </>
  );
}
