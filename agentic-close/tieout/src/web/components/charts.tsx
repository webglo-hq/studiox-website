/**
 * Diverging bar chart for variance drivers (polarity job → two hues + neutral baseline).
 * Built to the data-viz method: thin bars (≤ 18px) with a 4px rounded data end and a square
 * baseline end, a 2px surface gap between rows, values at the bar tips in text ink (never the
 * series color), a legend, per-bar hover/focus tooltips, and a table-view twin. The blue/orange
 * pair was validated (CVD ΔE 24.7 light / 26.8 dark, contrast ≥ 3:1) on both surfaces.
 */
import { useId, useState } from 'react';
import { money } from '../lib/format';

export interface DivergingItem {
  label: string;
  value: number;
  detail?: string;
}

export function DivergingBars({ items, currency, caption, totalLabel }: { items: DivergingItem[]; currency: string; caption: string; totalLabel?: string }) {
  const [table, setTable] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number; item: DivergingItem } | null>(null);
  const id = useId();
  const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
  const total = items.reduce((s, i) => s + i.value, 0);
  return (
    <figure className="viz" style={{ margin: 0 }} aria-labelledby={`${id}-cap`}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <figcaption id={`${id}-cap`} style={{ fontWeight: 600, fontSize: 14 }}>
          {caption}
        </figcaption>
        <div className="row" style={{ gap: 12 }}>
          <div className="legend" aria-hidden={table}>
            <span>
              <span className="sw" style={{ background: 'var(--chart-up)' }} />
              Increase
            </span>
            <span>
              <span className="sw" style={{ background: 'var(--chart-down)' }} />
              Decrease
            </span>
          </div>
          <button type="button" className="btn small ghost" aria-pressed={table} onClick={() => setTable((t) => !t)}>
            {table ? 'Show chart' : 'Show table'}
          </button>
        </div>
      </div>
      {table ? (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Driver</th>
              <th scope="col" className="r">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.label}>
                <td>
                  {i.label}
                  {i.detail ? <span className="muted"> · {i.detail}</span> : null}
                </td>
                <td className="r num">{money(i.value, currency, { signed: true })}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>{totalLabel ?? 'Total'}</td>
              <td className="r num">{money(total, currency, { signed: true })}</td>
            </tr>
          </tfoot>
        </table>
      ) : (
        <div role="list" aria-label={caption} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {items.map((i) => {
            // bars use at most 32% of the track per side so tip labels never overflow
            const w = (Math.abs(i.value) / max) * 32;
            const up = i.value >= 0;
            const desc = `${i.label}: ${money(i.value, currency, { signed: true })}${i.detail ? `, ${i.detail}` : ''}`;
            return (
              <div
                key={i.label}
                role="listitem"
                tabIndex={0}
                aria-label={desc}
                style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 34%) minmax(0, 1fr)', alignItems: 'center', gap: 10, minHeight: 28, outlineOffset: 0 }}
                onPointerMove={(e) => setTip({ x: e.clientX, y: e.clientY, item: i })}
                onPointerLeave={() => setTip(null)}
                onFocus={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTip({ x: r.left + r.width * 0.6, y: r.top, item: i });
                }}
                onBlur={() => setTip(null)}
              >
                <span style={{ fontSize: 13, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.label}>
                  {i.label}
                </span>
                <span style={{ position: 'relative', height: 24, display: 'block' }}>
                  <span aria-hidden="true" style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--line-strong)' }} />
                  <span
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      top: 3,
                      height: 18,
                      left: up ? '50%' : `${50 - w}%`,
                      width: `${Math.max(w, 0.6)}%`,
                      background: up ? 'var(--chart-up)' : 'var(--chart-down)',
                      borderRadius: up ? '0 4px 4px 0' : '4px 0 0 4px',
                    }}
                  />
                  <span
                    aria-hidden="true"
                    className="num"
                    style={{ position: 'absolute', top: 3, fontSize: 12, lineHeight: '18px', color: 'var(--ink)', ...(up ? { left: `calc(${50 + w}% + 6px)` } : { right: `calc(${50 + w}% + 6px)` }), whiteSpace: 'nowrap' }}
                  >
                    {money(i.value, currency, { signed: true, compact: true })}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {tip && !table ? (
        <div className="tip" role="presentation" style={{ left: Math.min(tip.x + 14, window.innerWidth - 260), top: tip.y + 14 }}>
          <strong className="num">{money(tip.item.value, currency, { signed: true })}</strong>
          <span>{tip.item.label}</span>
          {tip.item.detail ? <div className="muted">{tip.item.detail}</div> : null}
        </div>
      ) : null}
    </figure>
  );
}
