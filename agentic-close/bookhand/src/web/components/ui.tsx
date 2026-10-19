import { AlertTriangle, Loader2, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { closeOntology } from '../../packs/accounting/ontology';
import { money as fmtMoney, initials, label, STATUS_TONE } from '../lib/format';
import type { ApiError } from '../lib/api';

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#1f6b52" />
      <path d="M9 10.5h10M9 15.5h7" stroke="#e8f5ef" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M9 21.5h5" stroke="#e8f5ef" strokeWidth="2.2" strokeLinecap="round" opacity="0.55" />
      <path d="M17.5 21l2.8 2.8 5.2-6.3" stroke="#e8b04b" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Badge({ tone = '', children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge${tone ? ` badge-${tone}` : ''}`} title={title}>
      {children}
    </span>
  );
}

export function StatusBadge({ status, text }: { status: string; text?: string }) {
  return <Badge tone={STATUS_TONE[status] ?? ''}>{text ?? label(status)}</Badge>;
}

export function Money({ minor, currency = 'USD', signed, className, cents }: { minor: number | null | undefined; currency?: string; signed?: boolean; className?: string; cents?: boolean }) {
  const neg = (minor ?? 0) < 0;
  return <span className={`num${className ? ` ${className}` : ''}${signed && neg ? ' neg' : ''}`}>{fmtMoney(minor, currency, { signed, cents })}</span>;
}

export function Avatar({ name, hue = 200, size = 28 }: { name: string; hue?: number; size?: number }) {
  return (
    <span className="avatar" style={{ background: `hsl(${hue} 45% 30%)`, width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function Spinner({ label: text = 'Loading' }: { label?: string }) {
  return (
    <span className="row muted" role="status">
      <Loader2 size={16} className="spin" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - ((i * 13) % 35)}%` }} />
      ))}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="callout danger row" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <span className="grow">{error.message}</span>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <p className="small">{children}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export function Progress({ value, label: text }: { value: number; label: string }) {
  return (
    <div className="progress" role="progressbar" aria-label={text} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <span style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label: text }: { tabs: Array<{ id: T; label: string; count?: number }>; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={text}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" className="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="badge">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Focus-trapping side drawer (Esc closes, focus returns to the opener). */
export function Drawer({ title, subtitle, onClose, children, footer }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div className="drawer-head">
          <div className="grow">
            <h2 id={titleId} style={{ fontSize: 17 }}>
              {title}
            </h2>
            {subtitle && <div className="small muted" style={{ marginTop: 4 }}>{subtitle}</div>}
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </>
  );
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('textarea, input, select, button');
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div className="card-head">
          <h2 id={titleId} style={{ fontSize: 16 }}>
            {title}
          </h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="card-pad stack">{children}</div>
        {footer && <div className="drawer-foot" style={{ borderRadius: '0 0 16px 16px', justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </>
  );
}

/** Ask for a reason (reject, reverse, reopen) before running an action. */
export function ReasonDialog({ title, prompt, confirmLabel, danger, minLength = 3, onSubmit, onClose }: { title: string; prompt: string; confirmLabel: string; danger?: boolean; minLength?: number; onSubmit: (reason: string) => Promise<unknown>; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const ok = reason.trim().length >= minLength;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={!ok || busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(reason.trim());
              setBusy(false);
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor={id}>{prompt}</label>
        <textarea id={id} className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
        <span className="hint">Saved to the audit log{minLength > 3 ? ` (at least ${minLength} characters)` : ''}.</span>
      </div>
    </Modal>
  );
}

/** Inline ontology definition: hover or focus a dotted term to see what it means and why it matters. */
export function Term({ id, children }: { id: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const popId = useId();
  const t = closeOntology.term(id);
  if (!t) return <>{children}</>;
  return (
    <span className="term" tabIndex={0} aria-describedby={open ? popId : undefined} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
      {children}
      {open && (
        <span className="term-pop" role="tooltip" id={popId}>
          <span className="t" style={{ display: 'block' }}>
            {t.label}
          </span>
          <span style={{ display: 'block' }}>{t.definition}</span>
          {t.whyItMatters && (
            <span className="why" style={{ display: 'block' }}>
              {t.whyItMatters}
            </span>
          )}
          <span className="tiny muted" style={{ display: 'block', marginTop: 6 }}>
            {t.id} · ontology v{closeOntology.spec.version}
          </span>
        </span>
      )}
    </span>
  );
}

export function Stat({ label: text, value, sub, term }: { label: string; value: ReactNode; sub?: ReactNode; term?: string }) {
  return (
    <div className="card stat">
      <div className="label">{term ? <Term id={term}>{text}</Term> : text}</div>
      <div className="value">{value}</div>
      {sub && <div className="delta">{sub}</div>}
    </div>
  );
}

export function Confidence({ value }: { value: number }) {
  const tone = value >= 0.9 ? 'success' : value >= 0.75 ? 'info' : 'attention';
  return (
    <Badge tone={tone} title="Calibrated confidence reported by the agent">
      {(value * 100).toFixed(0)}% confident
    </Badge>
  );
}

export function fmtMoneyShort(minor: number, currency = 'USD'): string {
  return fmtMoney(minor, currency, { compact: Math.abs(minor) >= 10_000_000 });
}
