/** Evenkeel's mark: a mast, a level waterline and a keel. Original artwork. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <path d="M16 6.5v8.5" stroke="var(--accent-ink)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M7.5 15h17" stroke="var(--accent-ink)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M10.5 18.6c1.6 3.1 3.6 4.7 5.5 4.7s3.9-1.6 5.5-4.7" fill="none" stroke="var(--accent-ink)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Brand() {
  return (
    <span className="row" style={{ gap: 10 }}>
      <BrandMark />
      <span className="brand-name">Evenkeel</span>
    </span>
  );
}
