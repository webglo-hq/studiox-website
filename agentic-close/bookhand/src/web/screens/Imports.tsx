import { CheckCircle2, FileUp, PlugZap, Upload } from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';
import { api } from '../lib/api';
import { ago, date, label } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { Badge, Empty, ErrorBox, Skeleton, StatusBadge, Term } from '../components/ui';

interface ImportsData {
  batches: Array<{ id: string; filename: string; sha256: string; format: string; target: string; status: string; startedAt: string; total: number; created: number; duplicates: number; failed: number; errors: Array<{ locator: string; message: string }>; importedBy: string | null }>;
  connectors: Array<{ id: string; kind: string; adapter: string; name: string; status: string; lastSyncAt: string | null; lastSyncStatus: string | null }>;
  adapters: Array<{ key: string; label: string; format: string; kind: string; description: string }>;
  canImport: boolean;
}

interface ImportResult {
  batchId: string;
  adapterKey: string;
  status: 'completed' | 'partial' | 'failed';
  total: number;
  created: number;
  duplicates: number;
  failed: number;
  errors: Array<{ locator: string; message: string }>;
  alreadyImported: boolean;
  summary: string;
}

const MAX_BYTES = 5_000_000;

export function ImportsScreen() {
  const { data, error, reload } = useApi<ImportsData>('/api/imports');
  const { run, busy } = useAction();
  const [adapter, setAdapter] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setFileError(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setFileError('Files up to 5 MB can be imported here; use a connector for larger feeds.');
      return;
    }
    const content = await file.text();
    const r = await run(() => api.post<ImportResult>('/api/imports', { filename: file.name, content, ...(adapter ? { adapterKey: adapter } : {}) }), (x) => x.summary);
    if (r) setResult(r);
  };
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={10} />;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Imports and connectors</h1>
          <div className="sub" style={{ maxWidth: 820 }}>
            Bank statements (BAI2, CAMT.053, OFX, CSV), card feeds, ERP journal exports, payroll and AP files. Every import is idempotent: the same file or the same transaction never lands twice, and each record keeps its <Term id="bh:Provenance">provenance</Term>.
          </div>
        </div>
      </div>
      {data.canImport && (
        <section className="card card-pad stack" aria-labelledby="upload-h">
          <h2 id="upload-h" style={{ fontSize: 15 }}>
            <FileUp size={16} aria-hidden="true" /> Import a file
          </h2>
          <div className="row-wrap" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ minWidth: 260 }}>
              <label htmlFor="imp-adapter">Format</label>
              <select id="imp-adapter" className="select" value={adapter} onChange={(e) => setAdapter(e.target.value)}>
                <option value="">Detect from the file</option>
                {data.adapters.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            <input ref={input} type="file" className="sr-only" id="imp-file" aria-label="Statement or data file to import" tabIndex={-1} accept=".csv,.txt,.bai,.bai2,.xml,.ofx,.qfx,.json" onChange={(e) => void onFile(e)} />
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>
              <Upload size={15} aria-hidden="true" /> {busy ? 'Importing...' : 'Choose file'}
            </button>
          </div>
          {fileError && <div className="error-text">{fileError}</div>}
          {result && (
            <div className={`callout ${result.status === 'completed' ? 'success' : result.status === 'partial' ? 'attention' : 'danger'} small`} role="status">
              <strong>{result.alreadyImported ? 'Already imported: nothing changed.' : result.summary}</strong>
              <div>
                {result.created} created · {result.duplicates} duplicates skipped · {result.failed} failed of {result.total}
              </div>
              {result.errors.slice(0, 5).map((er, i) => (
                <div key={i} className="tiny">
                  {er.locator}: {er.message}
                </div>
              ))}
            </div>
          )}
          <p className="hint">Imported text (memos, vendor names) is stored as untrusted data: agents read it as evidence and never follow instructions inside it.</p>
        </section>
      )}
      <div className="split">
        <section className="card" aria-labelledby="batches-h">
          <div className="card-head">
            <h2 id="batches-h">
              <Term id="bh:ImportBatch">Import batches</Term> ({data.batches.length})
            </h2>
          </div>
          {data.batches.length === 0 ? (
            <Empty title="Nothing imported yet" icon={<Upload size={26} aria-hidden="true" />} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Status</th>
                    <th className="num">Created</th>
                    <th className="num hide-sm">Duplicates</th>
                    <th className="num hide-sm">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.batches.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <div className="clamp-2" style={{ fontWeight: 550 }}>
                          {b.filename}
                        </div>
                        <div className="tiny muted">
                          {b.format.toUpperCase()} → {label(b.target)} · {b.importedBy ?? 'Connector'} · {ago(b.startedAt)}
                        </div>
                        <div className="tiny muted mono" title={b.sha256}>
                          sha256 {b.sha256.slice(0, 16)}
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={b.status} />
                      </td>
                      <td className="num">{b.created}</td>
                      <td className="num hide-sm">{b.duplicates}</td>
                      <td className={`num hide-sm${b.failed ? ' neg' : ''}`}>{b.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <div className="stack" style={{ gap: 16 }}>
          <section className="card" aria-labelledby="conn-h">
            <div className="card-head">
              <h2 id="conn-h">
                <PlugZap size={15} aria-hidden="true" /> <Term id="bh:Connector">Connectors</Term>
              </h2>
            </div>
            {data.connectors.length === 0 ? (
              <p className="card-pad small muted">No connectors configured.</p>
            ) : (
              <ul className="list small">
                {data.connectors.map((c) => (
                  <li key={c.id}>
                    <div className="row">
                      <strong className="grow">{c.name}</strong>
                      <Badge tone={c.status === 'active' ? 'success' : ''}>{label(c.status)}</Badge>
                    </div>
                    <div className="tiny muted">
                      {label(c.kind)} · {c.adapter} · last sync {c.lastSyncAt ? date(c.lastSyncAt, 'time') : 'never'}
                      {c.lastSyncStatus ? ` (${c.lastSyncStatus})` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card" aria-labelledby="fmt-h">
            <div className="card-head">
              <h2 id="fmt-h">Supported formats</h2>
            </div>
            <ul className="list small">
              {data.adapters.map((a) => (
                <li key={a.key}>
                  <div className="row">
                    <CheckCircle2 size={14} className="pos" aria-hidden="true" />
                    <strong className="grow">{a.label}</strong>
                    <Badge>{a.format.toUpperCase()}</Badge>
                  </div>
                  <div className="tiny muted">{a.description}</div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
