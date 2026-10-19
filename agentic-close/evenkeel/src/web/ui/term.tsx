import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useApi } from '../lib/api';
import { href } from '../lib/router';

/**
 * Inline definition of an accounting term, straight from the ontology. Hover or focus shows
 * the plain-English definition and why it matters (dismiss with Escape, hoverable, persistent:
 * WCAG 1.4.13); activating the term opens it in the ontology explorer.
 */
export function Term({ id, children }: { id: string; children?: ReactNode }) {
  const g = useApi('ontology.glossary', {}, { staleTime: Infinity });
  const t = g.data?.terms[id];
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLAnchorElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const tipId = useId();

  const show = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 120);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 160);
  };

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const w = Math.min(340, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12));
    const below = r.bottom + 8;
    const h = pop.current?.offsetHeight ?? 160;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 8) : below;
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  return (
    <>
      <a
        ref={ref}
        href={href(`/ontology/${encodeURIComponent(id)}`)}
        className="term"
        aria-describedby={open && t ? tipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children ?? t?.label ?? id}
      </a>
      {open && t && (
        <div ref={pop} id={tipId} role="tooltip" className="popover" style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }} onMouseEnter={show} onMouseLeave={hide}>
          <div className="t">
            <span>{t.label}</span>
            <span className="id">{id}</span>
          </div>
          <div>{t.plain}</div>
          {t.why && <div className="why">Why it matters: {t.why}</div>}
          {t.example && <div className="why">Example: {t.example}</div>}
        </div>
      )}
    </>
  );
}
