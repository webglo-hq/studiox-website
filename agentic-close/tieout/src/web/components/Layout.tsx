/** App shell: skip link, navigation, top bar (period, entity, theme, user), shortcuts, toasts. */
import { Activity, BookOpen, CalendarCheck, FileChartColumn, House, Inbox, Keyboard, LogOut, Menu, Moon, Network, Scale, Settings, ShieldCheck, Sparkles, Sun, TrendingUp, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { can, useApp, useMe, type Theme } from '../lib/app-state';
import { periodName, periodShort, ROLE_LABEL } from '../lib/format';
import { navigate, useRoute } from '../lib/router';
import { Avatar, Dialog } from './ui';

const NAV: { group: string; items: { to: string; label: string; icon: ReactNode; perm?: string; count?: 'inbox' }[] }[] = [
  {
    group: 'Close',
    items: [
      { to: 'home', label: 'My close', icon: <House className="icon" aria-hidden="true" /> },
      { to: 'close', label: 'Close cockpit', icon: <CalendarCheck className="icon" aria-hidden="true" />, perm: 'close.view' },
      { to: 'inbox', label: 'Inbox', icon: <Inbox className="icon" aria-hidden="true" />, perm: 'proposal.view', count: 'inbox' },
      { to: 'recs', label: 'Reconciliations', icon: <Scale className="icon" aria-hidden="true" />, perm: 'subledger.read' },
      { to: 'flux', label: 'Flux analysis', icon: <TrendingUp className="icon" aria-hidden="true" />, perm: 'report.view' },
    ],
  },
  {
    group: 'Books',
    items: [
      { to: 'journal', label: 'Journal entries', icon: <BookOpen className="icon" aria-hidden="true" />, perm: 'ledger.read' },
      { to: 'reports', label: 'Trial balance & statements', icon: <FileChartColumn className="icon" aria-hidden="true" />, perm: 'report.view' },
      { to: 'imports', label: 'Imports', icon: <Upload className="icon" aria-hidden="true" />, perm: 'import.view' },
    ],
  },
  {
    group: 'Agents',
    items: [
      { to: 'runs', label: 'Agent runs', icon: <Activity className="icon" aria-hidden="true" />, perm: 'agent.view' },
      { to: 'skills', label: 'Skills & policy', icon: <Sparkles className="icon" aria-hidden="true" />, perm: 'skill.view' },
      { to: 'ontology', label: 'Ontology', icon: <Network className="icon" aria-hidden="true" />, perm: 'ontology.view' },
    ],
  },
  {
    group: 'Govern',
    items: [
      { to: 'audit', label: 'Audit log', icon: <ShieldCheck className="icon" aria-hidden="true" />, perm: 'audit.view' },
      { to: 'admin', label: 'Admin', icon: <Settings className="icon" aria-hidden="true" /> },
    ],
  },
];

const SHORTCUTS: [string, string][] = [
  ['g h', 'My close'],
  ['g c', 'Close cockpit'],
  ['g i', 'Inbox'],
  ['g r', 'Reconciliations'],
  ['g f', 'Flux'],
  ['g j', 'Journal entries'],
  ['g a', 'Agent runs'],
  ['j / k', 'Next / previous item (Inbox)'],
  ['Enter', 'Open item'],
  ['a', 'Approve open item'],
  ['?', 'This help'],
];

export function Layout({ children }: { children: ReactNode }) {
  const me = useMe();
  const { period, logout, theme, setTheme, toasts, dismiss, version, refresh } = useApp();
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [inbox, setInbox] = useState<number | null>(null);
  const [resetting, setResetting] = useState(false);
  const current = route.path[0] ?? 'home';

  useEffect(() => {
    let alive = true;
    api<{ inbox: { awaitingMe: number } }>(`/home?period=${period}`)
      .then((h) => alive && setInbox(h.inbox.awaitingMe))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [period, version, current]);

  useEffect(() => setOpen(false), [current]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Route change: announce the new screen by moving focus to the main region (SPA a11y).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo(0, 0);
    document.getElementById('main')?.focus({ preventScroll: true });
  }, [current]);

  useEffect(() => {
    let g = false;
    let timer = 0;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?') {
        setHelp(true);
        return;
      }
      if (g) {
        const map: Record<string, string> = { h: 'home', c: 'close', i: 'inbox', r: 'recs', f: 'flux', j: 'journal', a: 'runs', s: 'skills', o: 'ontology' };
        g = false;
        if (map[e.key]) {
          e.preventDefault();
          navigate(map[e.key]!);
        }
        return;
      }
      if (e.key === 'g') {
        g = true;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => (g = false), 1200);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const nextTheme: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' };
  // the button's name starts with the word it shows (WCAG 2.5.3: a voice user says what they see)
  const themeLabel: Record<Theme, string> = { system: 'Auto', dark: 'Dark', light: 'Light' };
  return (
    <>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>
        Skip to content
      </a>
      <div className="shell">
        <aside id="app-sidebar" className={`sidebar${open ? ' open' : ''}`} aria-label="Main navigation">
          <button className="btn ghost small sidebar-close" aria-label="Close menu" onClick={() => setOpen(false)}>
            <X className="icon" aria-hidden="true" />
          </button>
          <a className="brand" href="#/home">
            <span className="brand-mark" aria-hidden="true">
              t
            </span>
            <span>
              <span className="brand-name">Tieout</span>
              <br />
              <span className="brand-tag">Agents prepare. People sign off.</span>
            </span>
          </a>
          <nav className="nav" aria-label="Sections">
            {NAV.map((g) => {
              const items = g.items.filter((i) => !i.perm || can(me, i.perm));
              if (!items.length) return null;
              return (
                <div key={g.group}>
                  <div className="nav-group">{g.group}</div>
                  {items.map((i) => (
                    <a key={i.to} href={`#/${i.to}`} aria-current={current === i.to ? 'page' : undefined}>
                      {i.icon}
                      {i.label}
                      {i.count === 'inbox' && inbox ? (
                        <span className="count" aria-label={`${inbox} waiting for you`}>
                          {inbox}
                        </span>
                      ) : null}
                    </a>
                  ))}
                </div>
              );
            })}
          </nav>
          <div className="sidebar-foot">
            {me.tenant.demo ? <p>Fictional demo company. Not real data.</p> : null}
            {me.canResetDemo ? (
              <button className="btn ghost small" style={{ marginTop: 6, paddingLeft: 0 }} onClick={() => setResetting(true)}>
                Reset demo data
              </button>
            ) : null}
            <p style={{ marginTop: 6 }}>Tieout v{me.version}</p>
          </div>
        </aside>
        {open ? <div className="backdrop" style={{ zIndex: 40 }} onClick={() => setOpen(false)} aria-hidden="true" /> : null}
        <div style={{ minWidth: 0 }}>
          <header className="topbar">
            <button className="btn ghost small menu-button" aria-label="Menu" aria-expanded={open} aria-controls="app-sidebar" onClick={() => setOpen((o) => !o)}>
              {open ? <X className="icon" aria-hidden="true" /> : <Menu className="icon" aria-hidden="true" />}
            </button>
            <span className="period-chip" title="The period being closed and today's close workday">
              <span className="hide-sm">{periodName(period)} close</span>
              <span className="show-sm">{periodShort(period)}</span>
              <span className="wd" title={`Business date ${me.tenant.businessDate}`}>
                {me.tenant.workday ?? me.tenant.businessDate}
              </span>
            </span>
            <span className="spacer" />
            <button className="btn ghost small hide-sm" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts">
              <Keyboard className="icon" aria-hidden="true" />
            </button>
            <button className="btn ghost small" onClick={() => setTheme(nextTheme[theme])} aria-label={`${themeLabel[theme]} theme: switch to ${themeLabel[nextTheme[theme]]}`} title={`${themeLabel[theme]} theme (follows your device when Auto)`}>
              {theme === 'dark' ? <Moon className="icon" aria-hidden="true" /> : <Sun className="icon" aria-hidden="true" />}
              <span className="hide-sm" style={{ fontWeight: 500 }}>
                {themeLabel[theme]}
              </span>
            </button>
            <span className="row" style={{ gap: 8 }}>
              <Avatar name={me.user.name} />
              <span className="hide-sm" style={{ lineHeight: 1.2 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{me.user.name}</span>
                <br />
                <span className="muted" style={{ fontSize: 12 }}>
                  {me.user.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}
                </span>
              </span>
            </span>
            <button className="btn ghost small" onClick={() => void logout()} aria-label="Sign out">
              <LogOut className="icon" aria-hidden="true" />
            </button>
          </header>
          <main id="main" className="main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'bad' ? 'bad' : ''}`}>
            <span style={{ flex: 1 }}>{t.text}</span>
            <button className="btn ghost small" style={{ color: 'inherit', minHeight: 24, padding: '0 6px' }} onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X className="icon" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <Dialog
        open={resetting}
        onClose={() => setResetting(false)}
        title="Reset the demo?"
        actions={
          <>
            <button className="btn" onClick={() => setResetting(false)}>
              Cancel
            </button>
            <button
              className="btn danger"
              onClick={() => {
                void api('/demo/reset', { body: {} })
                  .catch(() => undefined)
                  .finally(() => {
                    setResetting(false);
                    void refresh();
                  });
              }}
            >
              Reset and sign out
            </button>
          </>
        }
      >
        <p>This puts the fictional company back to the start of the September close: agent runs, approvals and edits made in this demo are discarded.</p>
      </Dialog>
      <Dialog open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts" actions={<button className="btn" onClick={() => setHelp(false)}>Close</button>}>
        <table className="data">
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k}>
                <td style={{ width: 110 }}>
                  {k.split(' ').map((x) => (
                    <span key={x} className="kbd" style={{ marginRight: 4 }}>
                      {x}
                    </span>
                  ))}
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Dialog>
    </>
  );
}
