/** Source document viewer: the exact imported file behind a record, with provenance. */
import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { api } from '../api';
import { Badge, ErrorBox, Loading } from '../components/ui';
import { useData } from '../lib/app-state';
import { dateTime } from '../lib/format';
import { useRoute } from '../lib/router';

interface Doc {
  id: string;
  filename: string;
  mime: string;
  kind: string;
  size: number;
  contentHash: string;
  receivedAt: string;
  content: string;
}

export function Documents() {
  const route = useRoute();
  const id = route.path[1] ?? '';
  const line = Number(route.query.get('line') ?? 0);
  const { data, error, reload } = useData(() => api<Doc>(`/documents/${encodeURIComponent(id)}`), [id]);
  const hl = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (line && data) hl.current?.scrollIntoView({ block: 'center' });
  }, [line, data]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const lines = data.content.split(/\r?\n/);
  return (
    <div>
      <button className="btn ghost small" onClick={() => window.history.back()} style={{ marginBottom: 10 }}>
        <ArrowLeft className="icon" aria-hidden="true" /> Back
      </button>
      <div className="page-head">
        <div>
          <h1 className="mono" style={{ fontSize: 26 }}>
            {data.filename}
          </h1>
          <p className="lede">The original file as received. Records created from it point back to this file and line, and the content hash proves it has not changed since import.</p>
        </div>
      </div>
      <div className="grid main-side">
        <section className="card card-pad">
          <pre className="doc" tabIndex={0} aria-label={`Contents of ${data.filename}`} style={{ maxHeight: '70vh' }}>
            {lines.map((l, i) => (
              <span key={i} ref={i + 1 === line ? hl : undefined} style={i + 1 === line ? { background: 'var(--accent-wash)', display: 'block' } : { display: 'block' }}>
                <span className="muted" aria-hidden="true" style={{ display: 'inline-block', width: 40, userSelect: 'none' }}>
                  {i + 1}
                </span>
                {l}
              </span>
            ))}
          </pre>
          {data.content.length >= 200_000 ? <p className="muted">Showing the first 200 KB.</p> : null}
        </section>
        <aside className="card card-pad">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Provenance</h2>
          <dl className="kv" style={{ fontSize: 13 }}>
            <dt>Kind</dt>
            <dd>
              <Badge icon={false}>{data.kind.replace(/_/g, ' ')}</Badge>
            </dd>
            <dt>Type</dt>
            <dd className="mono">{data.mime}</dd>
            <dt>Size</dt>
            <dd className="num">{data.size.toLocaleString()} bytes</dd>
            <dt>Received</dt>
            <dd>{dateTime(data.receivedAt)}</dd>
            <dt>SHA-256</dt>
            <dd className="mono" style={{ wordBreak: 'break-all' }}>
              {data.contentHash}
            </dd>
          </dl>
        </aside>
      </div>
    </div>
  );
}
