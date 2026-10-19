/** One-time display of two-factor recovery codes, with copy and download. */
import { Copy, Download, LifeBuoy } from 'lucide-react';
import { useState } from 'react';

export function RecoveryCodes({ codes, account }: { codes: string[]; account: string }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const text = `Tieout two-factor recovery codes for ${account}\nEach code signs you in once if you lose your authenticator. Keep them somewhere safe.\n\n${codes.join('\n')}\n`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('yes');
    } catch {
      setCopied('no'); // clipboard blocked (e.g. a sandboxed frame): the codes stay on screen
    }
  }
  function download() {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tieout-recovery-codes.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* downloads blocked: the codes stay on screen */
    }
  }
  return (
    <div className="callout info" role="region" aria-labelledby="recovery-h">
      <LifeBuoy className="icon" aria-hidden="true" />
      <div className="stack" style={{ gap: 8 }}>
        <p id="recovery-h" style={{ margin: 0 }}>
          <strong>Save your recovery codes.</strong> If you lose your authenticator, each code signs you in once. They are shown only now.
        </p>
        <ul className="recovery-codes mono" aria-label="Recovery codes">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn small" type="button" onClick={() => void copy()}>
            <Copy className="icon" aria-hidden="true" /> Copy
          </button>
          <button className="btn small" type="button" onClick={download}>
            <Download className="icon" aria-hidden="true" /> Download
          </button>
          <span className="muted" role="status" style={{ fontSize: 13 }}>
            {copied === 'yes' ? 'Copied.' : copied === 'no' ? 'Copying is blocked here; write them down.' : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
