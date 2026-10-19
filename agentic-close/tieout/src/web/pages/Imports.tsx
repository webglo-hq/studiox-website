/**
 * Imports: connectors (bank BAI2 / camt.053 / OFX / CSV, card feed, ERP journal, AP inbox,
 * payroll), idempotent uploads with provenance, and the batch history.
 */
import { FileUp, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, ApiError, type ImportsData } from '../api';
import { Badge, ErrorBox, Loading } from '../components/ui';
import { can, useApp, useData, useMe } from '../lib/app-state';
import { dateTime } from '../lib/format';

interface Outcome {
  batch: { id: string; status: string };
  duplicateOfBatchId: string | null;
  created: number;
  skipped: number;
  errors: { line: number | null; message: string }[];
}

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral' | 'info'> = { completed: 'good', failed: 'bad', duplicate: 'neutral', processing: 'info' };

export function Imports() {
  const me = useMe();
  const { toast, bump } = useApp();
  const { data, error, loading, reload } = useData(() => api<ImportsData>('/imports'), []);
  const [connector, setConnector] = useState('');
  const [filename, setFilename] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const selected = data.connectors.find((c) => c.key === (connector || data.connectors[0]?.key));
  const canRun = can(me, 'import.run');

  async function pick(f: File | undefined) {
    if (!f) return;
    if (f.size > 2_000_000) {
      toast('Files are limited to 2 MB.', 'bad');
      return;
    }
    setFilename(f.name);
    setContent(await f.text());
  }
  async function submit() {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await api<Outcome>('/imports', { body: { connectorKey: selected.key, filename: filename || `upload${selected.adapter?.extension ?? ''}`, content } });
      setOutcome(r);
      toast(r.duplicateOfBatchId || r.batch.status === 'duplicate' ? 'Already imported: nothing changed.' : `Imported ${r.created} records (${r.skipped} skipped as duplicates).`);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Import failed.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={loading ? 'skeleton' : undefined}>
      <div className="page-head">
        <div>
          <h1>Imports</h1>
          <p className="lede">
            Every file is stored once, by content hash, and every record keeps a link to the file and line it came from. Importing the same file twice changes nothing; records already seen (same external id) are skipped. Bank memos are scanned for instruction-like text on the way in.
          </p>
        </div>
      </div>
      <div className="grid main-side">
        <section className="card">
          <div className="card-head">
            <h2>Recent imports</h2>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Connector</th>
                  <th scope="col" className="r">
                    New
                  </th>
                  <th scope="col" className="r">
                    Skipped
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col" className="hide-sm">
                    By
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.batches.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <div className="mono" style={{ fontSize: 13 }}>
                        {b.filename}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {dateTime(b.at)} · sha256 {b.contentHash?.slice(0, 10)}
                      </div>
                      {b.errors.length ? (
                        <details>
                          <summary className="muted" style={{ fontSize: 12 }}>
                            {b.errors.length} message{b.errors.length === 1 ? '' : 's'}
                          </summary>
                          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                            {b.errors.map((e, i) => (
                              <li key={i}>
                                {e.line ? `Line ${e.line}: ` : ''}
                                {e.message}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </td>
                    <td>{b.connector}</td>
                    <td className="r num">{b.created}</td>
                    <td className="r num">{b.skipped}</td>
                    <td>
                      <Badge tone={STATUS_TONE[b.status] ?? 'neutral'}>{b.status}</Badge>
                    </td>
                    <td className="hide-sm">{b.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="stack">
          {canRun ? (
            <section className="card card-pad stack" aria-labelledby="up-h">
              <h2 id="up-h" style={{ margin: 0 }}>
                <Upload className="icon" aria-hidden="true" /> Import a file
              </h2>
              <label className="field">
                Connector
                <select value={selected?.key ?? ''} onChange={(e) => setConnector(e.target.value)}>
                  {data.connectors.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              {selected?.adapter ? (
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  {selected.adapter.description}
                </p>
              ) : null}
              <label className="field">
                <span>
                  <FileUp className="icon" aria-hidden="true" /> File
                </span>
                <input ref={fileRef} type="file" accept={selected?.adapter?.extension} onChange={(e) => void pick(e.target.files?.[0])} />
              </label>
              <div className="row">
                {selected?.adapter ? (
                  <button
                    className="btn ghost"
                    onClick={() => {
                      setFilename(`sample${selected.adapter!.extension}`);
                      setContent(selected.adapter!.sample);
                    }}
                  >
                    Use a sample
                  </button>
                ) : null}
              </div>
              <label className="field">
                File content {filename ? <span className="muted mono">({filename})</span> : null}
                <textarea rows={8} className="mono" style={{ fontSize: 12 }} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
              </label>
              <div>
                <button className="btn primary" disabled={!content || busy} onClick={() => void submit()}>
                  {busy ? 'Importing…' : 'Import'}
                </button>
              </div>
              {outcome ? (
                <div className={`callout ${outcome.batch.status === 'completed' ? 'good' : outcome.batch.status === 'duplicate' ? 'info' : 'warn'}`} role="status">
                  <div>
                    <strong>{outcome.batch.status === 'duplicate' ? 'Identical file already imported' : `Status: ${outcome.batch.status}`}</strong>
                    <div>
                      {outcome.created} new, {outcome.skipped} skipped{outcome.errors.length ? `, ${outcome.errors.length} message(s)` : ''}.
                    </div>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
          <section className="card card-pad stack">
            <h2 style={{ margin: 0 }}>Connectors</h2>
            <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }} className="stack">
              {data.connectors.map((c) => (
                <li key={c.key}>
                  <strong>{c.name}</strong> <Badge tone={c.status === 'active' ? 'good' : 'neutral'}>{c.status}</Badge>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {c.kind.replace(/_/g, ' ')} · {c.format}
                    {c.lastImportAt ? ` · last import ${dateTime(c.lastImportAt)}` : ''}
                  </div>
                </li>
              ))}
            </ul>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Live bank feeds and ERP APIs plug in as connectors behind the same import pipeline.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
