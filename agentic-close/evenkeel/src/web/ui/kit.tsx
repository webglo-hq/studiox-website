import { AlertTriangle, ChevronRight, CircleAlert, Info, Inbox as InboxIcon, X } from 'lucide-react';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ApiError } from '../backend/types';
import { confidenceLabel, initials, money } from '../lib/format';

/** Small, accessible building blocks shared by every screen. */

type Tone = 'good' | 'bad' | 'warn' | 'info' | 'accent' | 'neutral' | 'outline';

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone === 'neutral' ? '' : `t-${tone}`}`} title={title}>
      {children}
    </span>
  );
}

export function Button({ variant = 'default', size, busy, icon, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'good' | 'danger' | 'quiet'; size?: 's' | 'l'; busy?: boolean; icon?: ReactNode }) {
  const cls = ['btn', variant !== 'default' ? `btn-${variant}` : '', size ? `btn-${size}` : '', !children ? 'btn-icon' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} aria-busy={busy || undefined} {...rest} disabled={rest.disabled || busy}>
      {busy ? <span className="spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function LinkButton({ href, variant = 'default', size, icon, children }: { href: string; variant?: 'default' | 'primary' | 'quiet'; size?: 's' | 'l'; icon?: ReactNode; children: ReactNode }) {
  return (
    <a href={href} className={['btn', variant !== 'default' ? `btn-${variant}` : '', size ? `btn-${size}` : ''].filter(Boolean).join(' ')}>
      {icon}
      {children}
    </a>
  );
}

export function Card({ title, hint, actions, children, flush, footer, id, className }: { title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; footer?: ReactNode; id?: string; className?: string }) {
  const hid = useId();
  return (
    <section className={`card ${className ?? ''}`} aria-labelledby={title ? hid : undefined} id={id}>
      {(title || actions) && (
        <div className="card-head">
          <div className="stack" style={{ gap: 2 }}>
            {title && <h2 id={hid}>{title}</h2>}
            {hint && <div className="hint">{hint}</div>}
          </div>
          {actions && <div className="row-wrap">{actions}</div>}
        </div>
      )}
      <div className={`card-body ${flush ? 'flush' : ''}`}>{children}</div>
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

export function PageHead({ eyebrow, title, sub, actions }: { eyebrow?: ReactNode; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Money({ cents, currency = 'USD', compact, signed, className, colored }: { cents: number | null | undefined; currency?: string; compact?: boolean; signed?: boolean; className?: string; colored?: boolean }) {
  const neg = (cents ?? 0) < 0;
  return <span className={`num ${colored && neg ? 'neg' : ''} ${className ?? ''}`}>{money(cents, currency, { compact, signed })}</span>;
}

export function Confidence({ value }: { value: number }) {
  const pctv = Math.round(value * 100);
  return (
    <span className={`conf ${value < 0.8 ? 'low' : ''}`} title={`${confidenceLabel(value)} confidence (${pctv}%)`}>
      <span className="conf-bar" aria-hidden>
        <span style={{ width: `${pctv}%` }} />
      </span>
      {pctv}%<span className="sr-only"> confidence</span>
    </span>
  );
}

export function Avatar({ name, size }: { name: string | null | undefined; size?: 's' }) {
  return (
    <span className={`avatar ${size ?? ''}`} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function Person({ name, title }: { name: string | null | undefined; title?: string | null }) {
  if (!name) return <span className="muted">—</span>;
  return (
    <span className="row" style={{ gap: 6 }} title={title ?? undefined}>
      <Avatar name={name} size="s" />
      <span className="ellipsis">{name}</span>
    </span>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon" aria-hidden>
        {icon ?? <InboxIcon size={22} />}
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof ApiError || error instanceof Error ? error.message : String(error);
  const forbidden = error instanceof ApiError && (error.code === 'FORBIDDEN' || error.status === 403);
  return (
    <div className="error-box" role="alert">
      <CircleAlert size={20} aria-hidden />
      <div className="stack" style={{ gap: 6 }}>
        <strong>{forbidden ? 'Not available for your role' : 'This did not load'}</strong>
        <span className="small">{msg}</span>
        {retry && !forbidden && (
          <div>
            <Button size="s" onClick={retry}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%', style }: { height?: number; width?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height, width, ...style }} aria-hidden />;
}

export function Loading({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="stack" role="status" aria-label={label} style={{ gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={i === 0 ? 22 : 16} width={i === 0 ? '40%' : `${90 - i * 8}%`} />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

/** Renders loading / error / data for a query without repeating the plumbing in every screen. */
export function Query<T>({ q, children, rows, empty }: { q: { data: T | undefined; isLoading: boolean; error: unknown; refetch: () => unknown; isError: boolean }; children: (data: T) => ReactNode; rows?: number; empty?: (data: T) => ReactNode | null }) {
  if (q.isLoading) return <Loading rows={rows} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (q.data === undefined) return <Loading rows={rows} />;
  const e = empty?.(q.data);
  if (e) return <>{e}</>;
  return <>{children(q.data)}</>;
}

export function Notice({ tone = 'info', children, title }: { tone?: 'info' | 'warn' | 'bad' | 'good'; children: ReactNode; title?: string }) {
  const Icon = tone === 'bad' || tone === 'warn' ? AlertTriangle : Info;
  return (
    <div className={`notice ${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      <Icon size={16} aria-hidden />
      <div className="stack" style={{ gap: 2 }}>
        {title && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps focus inside a dialog, closes on Escape and restores focus on close (WCAG 2.4.3). */
function useFocusTrap(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  // The trap is set up once per dialog; Escape always calls the latest onClose.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const a = items[0]!;
      const b = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        b.focus();
      } else if (!e.shiftKey && document.activeElement === b) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [ref]);
}

export function Dialog({ title, children, footer, onClose, wide, description }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean; description?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const hid = useId();
  const did = useId();
  useFocusTrap(ref, onClose);
  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={hid} aria-describedby={description ? did : undefined}>
        <div className="dialog-head">
          <div className="stack" style={{ gap: 4 }}>
            <h2 id={hid}>{title}</h2>
            {description && (
              <p id={did} className="small ink2">
                {description}
              </p>
            )}
          </div>
          <Button variant="quiet" aria-label="Close" onClick={onClose} icon={<X size={18} aria-hidden />} />
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, sub, children, footer, onClose, label }: { title: ReactNode; sub?: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden />
      <div ref={ref} className="drawer" role="dialog" aria-modal="true" aria-label={label}>
        <div className="drawer-head">
          <div className="stack grow" style={{ gap: 4 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-xl)', lineHeight: 1.25 }}>{title}</div>
            {sub && <div className="small ink2">{sub}</div>}
          </div>
          <Button variant="quiet" aria-label="Close panel" onClick={onClose} icon={<X size={18} aria-hidden />} />
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </>
  );
}

export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number }[]; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = items.findIndex((i) => i.value === value);
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((it, i) => (
        <button
          key={it.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          type="button"
          className="tab"
          aria-selected={it.value === value}
          tabIndex={i === idx ? 0 : -1}
          onClick={() => onChange(it.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const next = (idx + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length;
            onChange(items[next]!.value);
            refs.current[next]?.focus();
          }}
        >
          {it.label}
          {it.count !== undefined && <span className="n">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Seg<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.value} type="button" aria-pressed={it.value === value} onClick={() => onChange(it.value)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, help, error, children, htmlFor }: { label: ReactNode; help?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {help && <span className="help">{help}</span>}
      {error && (
        <span className="form-error" role="alert">
          <CircleAlert size={14} aria-hidden /> {error}
        </span>
      )}
    </div>
  );
}

export function Disclosure({ summary, children, open }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="disclosure" open={open}>
      <summary>
        <ChevronRight size={14} aria-hidden style={{ transition: 'transform .15s' }} />
        {summary}
      </summary>
      <div style={{ marginTop: 8 }}>{children}</div>
    </details>
  );
}

export function Kv({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  complete: 'good',
  completed: 'good',
  reviewed: 'good',
  approved: 'good',
  applied: 'good',
  auto_applied: 'info',
  posted: 'good',
  final: 'good',
  resolved: 'good',
  hard_close: 'good',
  ok: 'good',
  prepared: 'accent',
  ready_for_review: 'accent',
  submitted: 'accent',
  in_review: 'accent',
  explained: 'accent',
  awaiting_approval: 'warn',
  pending: 'warn',
  pending_approval: 'warn',
  suggested: 'warn',
  in_progress: 'info',
  running: 'info',
  draft: 'neutral',
  not_started: 'neutral',
  open: 'warn',
  acknowledged: 'info',
  unexplained: 'bad',
  blocked: 'bad',
  failed: 'bad',
  rejected: 'bad',
  budget_exceeded: 'bad',
  superseded: 'neutral',
  dismissed: 'neutral',
  soft_close: 'accent',
  critical: 'bad',
  high: 'bad',
  medium: 'warn',
  low: 'neutral',
  material: 'bad',
  near_material: 'warn',
  trivial: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  auto_applied: 'Auto-posted',
  ready_for_review: 'Ready for review',
  awaiting_approval: 'Waiting for approval',
  pending_approval: 'Waiting for approval',
  pending: 'Waiting for you',
  suggested: 'Suggested',
  not_started: 'Not started',
  in_progress: 'In progress',
  hard_close: 'Locked',
  soft_close: 'Soft-closed',
  open: 'Open',
  budget_exceeded: 'Stopped (budget)',
  near_material: 'Near materiality',
};

export function Status({ value, label }: { value: string; label?: string }) {
  const text = label ?? STATUS_LABEL[value] ?? value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return <Badge tone={STATUS_TONE[value] ?? 'neutral'}>{text}</Badge>;
}

/** A key cap. `decorative` hides it from assistive technology when the control announces the shortcut itself. */
export function Kbd({ children, decorative }: { children: ReactNode; decorative?: boolean }) {
  return <kbd aria-hidden={decorative || undefined}>{children}</kbd>;
}

export function Progress({ done, review, work, total, label }: { done: number; review?: number; work?: number; total: number; label: string }) {
  const p = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <div className="progress" role="img" aria-label={label}>
      <span className="p-done" style={{ width: p(done) }} />
      {review ? <span className="p-review" style={{ width: p(review) }} /> : null}
      {work ? <span className="p-work" style={{ width: p(work) }} /> : null}
    </div>
  );
}
