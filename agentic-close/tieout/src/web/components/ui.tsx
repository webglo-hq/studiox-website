/** UI primitives: accessible buttons, badges, overlays with focus management, popovers, states. */
import { CircleAlert, CircleCheck, Clock, Flag, Info, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, type Explanation } from '../api';
import { money } from '../lib/format';

export function Money({ minor, currency = 'USD', signed, compact, className }: { minor: number | null | undefined; currency?: string | null; signed?: boolean; compact?: boolean; className?: string }) {
  return <span className={`num ${className ?? ''}`}>{money(minor, currency, { signed, compact })}</span>;
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';
const TONE_ICON: Record<Tone, ReactNode> = {
  neutral: null,
  good: <CircleCheck className="icon" aria-hidden="true" />,
  warn: <TriangleAlert className="icon" aria-hidden="true" />,
  bad: <CircleAlert className="icon" aria-hidden="true" />,
  info: <Info className="icon" aria-hidden="true" />,
};

/** Status always ships with an icon and a label, never color alone. */
export function Badge({ tone = 'neutral', children, icon, title }: { tone?: Tone; children: ReactNode; icon?: ReactNode | false; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {icon === false ? null : (icon ?? TONE_ICON[tone])}
      {children}
    </span>
  );
}

export function ProposalStatus({ status, route, reviewStatus }: { status: string; route?: string; reviewStatus?: string }) {
  if (status === 'applied' && (route === 'auto_post' || route === 'auto_post_sampled'))
    return (
      <Badge tone="good" title="Applied automatically within the Controller's policy">
        Auto-applied{reviewStatus === 'pending' ? ' · review' : ''}
      </Badge>
    );
  if (status === 'applied') return <Badge tone="good">Approved</Badge>;
  if (status === 'pending_approval') return <Badge tone="warn" icon={<Clock className="icon" aria-hidden="true" />}>Needs approval</Badge>;
  if (status === 'suggested') return <Badge tone="info">Suggestion</Badge>;
  if (status === 'rejected') return <Badge tone="bad">Rejected</Badge>;
  return <Badge>{status.replace(/_/g, ' ')}</Badge>;
}

export function FlagBadges({ flags }: { flags: readonly string[] }) {
  if (!flags.length) return null;
  const label: Record<string, string> = { injection_suspected: 'Instruction-like text', control_account: 'Control account', requires_capitalization: 'Capitalize', unexplained: 'Unexplained', depends_on_pending: 'Waits on another item', policy_never_auto: 'Policy: always a person', sod_conflict: 'SoD' };
  return (
    <>
      {flags.map((f) => (
        <Badge key={f} tone={f === 'injection_suspected' ? 'bad' : 'warn'} icon={<Flag className="icon" aria-hidden="true" />}>
          {label[f] ?? f.replace(/_/g, ' ')}
        </Badge>
      ))}
    </>
  );
}

export function Confidence({ value }: { value: number }) {
  const pctv = Math.round(value * 100);
  return (
    <span className="confidence" title="Calibrated confidence the proposal is correct">
      <span className="bar" aria-hidden="true">
        <span style={{ width: `${pctv}%` }} />
      </span>
      <span className="num">{pctv}%</span>
      <span className="sr-only">confidence</span>
    </span>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const p = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span style={{ width: `${p}%` }} />
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="empty" role="status" aria-live="polite">
      {label}…
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="callout bad" role="alert">
      <CircleAlert className="icon" aria-hidden="true" />
      <div>
        <strong>Something went wrong.</strong> <span>{error.message}</span>
        {onRetry ? (
          <div style={{ marginTop: 8 }}>
            <button className="btn small" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  const parts = name.split(/\s+/);
  return (
    <span className="avatar" aria-hidden="true">
      {(parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')}
    </span>
  );
}

// ------------------------------------------------------------------ overlays
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const a = items[0]!;
        const b = items[items.length - 1]!;
        const at = document.activeElement as HTMLElement | null;
        // focus may also rest on something outside the tab order, such as the panel's heading
        // (focused on open): Tab and Shift+Tab still wrap inside the panel instead of leaving it
        const inside = !!at && el.contains(at);
        const listed = !!at && items.includes(at);
        const follows = (x: HTMLElement) => !!at && (at.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        if (e.shiftKey && (!inside || at === a || (!listed && follows(a)))) {
          e.preventDefault();
          b.focus();
        } else if (!e.shiftKey && (!inside || at === b || (!listed && !follows(b)))) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);
  return ref;
}

export function Drawer({ open, onClose, title, children, footer, subtitle }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const ref = useFocusTrap(open, onClose);
  const id = useId();
  if (!open) return null;
  return (
    <>
      <div className="backdrop" onClick={onClose} aria-hidden="true" />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} ref={ref}>
        <div className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* focus starts on the title, so a screen reader announces what opened and the key that
                opened the panel cannot press a button in it */}
            <h2 id={`${id}-t`} style={{ fontSize: 19 }} tabIndex={-1} data-autofocus>
              {title}
            </h2>
            {subtitle ? <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>{subtitle}</div> : null}
          </div>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">
            <X className="icon" aria-hidden="true" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </div>
    </>
  );
}

export function Dialog({ open, onClose, title, children, actions }: { open: boolean; onClose: () => void; title: string; children: ReactNode; actions: ReactNode }) {
  const ref = useFocusTrap(open, onClose);
  const id = useId();
  if (!open) return null;
  return (
    <>
      <div className="backdrop" onClick={onClose} aria-hidden="true" />
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} ref={ref}>
        <h2 id={`${id}-t`} style={{ marginBottom: 10 }}>
          {title}
        </h2>
        <div className="stack" style={{ gap: 12 }}>
          {children}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
          {actions}
        </div>
      </div>
    </>
  );
}

/** Ask for a reason (rejections, reversals, unlocking): required text with live validation. */
export function ReasonDialog({ open, title, label, min = 5, confirm, tone = 'danger', onCancel, onConfirm }: { open: boolean; title: string; label: string; min?: number; confirm: string; tone?: 'danger' | 'primary'; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [text, setText] = useState('');
  const id = useId();
  const tooShort = text.trim().length < min;
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      actions={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn ${tone === 'danger' ? 'danger' : 'primary'}`} aria-disabled={tooShort} onClick={() => !tooShort && onConfirm(text.trim())}>
            {confirm}
          </button>
        </>
      }
    >
      <label className="field" htmlFor={id}>
        {label}
        <textarea id={id} data-autofocus value={text} onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-h`} />
        <span id={`${id}-h`} className="hint">
          At least {min} characters. It is recorded in the audit log.
        </span>
      </label>
    </Dialog>
  );
}

// ------------------------------------------------------------------ ontology terms
const termCache = new Map<string, Promise<Explanation>>();
function explain(term: string): Promise<Explanation> {
  if (!termCache.has(term)) termCache.set(term, api<Explanation>(`/ontology/explain/${encodeURIComponent(term)}`));
  return termCache.get(term)!;
}

/**
 * An accounting term with its ontology definition on hover, focus or tap (WCAG 1.4.13:
 * dismissible with Escape, hoverable, persistent until dismissed).
 */
export function Term({ id, children }: { id: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Explanation | null>(null);
  const [failed, setFailed] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const closeTimer = useRef<number | null>(null);
  const popId = useId();
  const show = useCallback(() => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    setOpen(true);
    explain(id)
      .then(setData)
      .catch(() => setFailed(true));
  }, [id]);
  const hideSoon = () => {
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  };
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = Math.min(360, window.innerWidth - 32);
    setPos({ top: Math.min(r.bottom + 8, window.innerHeight - 220), left: Math.max(16, Math.min(r.left, window.innerWidth - w - 16)) });
  }, [open, data]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDoc = (e: MouseEvent) => !pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDoc);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [open]);
  return (
    <>
      <button ref={btn} type="button" className="term" aria-expanded={open} aria-controls={open ? popId : undefined} onClick={() => (open ? setOpen(false) : show())} onMouseEnter={show} onMouseLeave={hideSoon} onFocus={show} onBlur={hideSoon}>
        {children}
      </button>
      {open ? (
        <div ref={pop} id={popId} className="popover" role="dialog" aria-label={`Definition: ${typeof children === 'string' ? children : id}`} style={{ top: pos.top, left: pos.left }} onMouseEnter={() => closeTimer.current && window.clearTimeout(closeTimer.current)} onMouseLeave={hideSoon}>
          {data ? (
            <>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{data.label}</strong>
                {data.classId ? <code className="muted">{data.classId}</code> : null}
              </div>
              <p className="def">{data.definition}</p>
              <p className="why">
                <strong>Why it matters: </strong>
                {data.whyItMatters}
              </p>
              {data.axioms.length ? (
                <p className="why" style={{ fontSize: 13 }}>
                  Rules: {data.axioms.slice(0, 3).map((a) => `${a.id} ${a.title}`).join(' · ')}
                </p>
              ) : null}
              <a href={data.classId ? `#/ontology?class=${encodeURIComponent(data.classId)}` : '#/ontology?view=glossary'} style={{ fontSize: 13 }}>
                Open in ontology
              </a>
            </>
          ) : failed ? (
            <p>No definition found.</p>
          ) : (
            <p role="status">Loading definition…</p>
          )}
        </div>
      ) : null}
    </>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
