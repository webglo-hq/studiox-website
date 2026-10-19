/**
 * `npm run ads`: renders the launch ad creatives (1080×1350, 4:5 feed format) to docs/ads/.
 * Original copy and Tieout's own design system; the numbers come from the fictional demo
 * company. Fonts are embedded so rendering is deterministic and offline.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const font = (p: string) => `data:font/woff2;base64,${readFileSync(resolve('node_modules', p)).toString('base64')}`;
const FONTS = `
@font-face { font-family: 'Inter'; font-weight: 100 900; src: url(${font('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}) format('woff2'); }
@font-face { font-family: 'Instrument Serif'; font-style: normal; src: url(${font('@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2')}) format('woff2'); }
@font-face { font-family: 'Instrument Serif'; font-style: italic; src: url(${font('@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2')}) format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-weight: 100 900; src: url(${font('@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2')}) format('woff2'); }`;

const BASE = `
${FONTS}
* { box-sizing: border-box; margin: 0; }
html, body { width: 1080px; height: 1350px; }
body { font-family: 'Inter', sans-serif; color: #1c1b18; background: #f5f3ec; overflow: hidden; }
.frame { position: relative; width: 1080px; height: 1350px; padding: 84px 84px 72px; display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 16px; font-family: 'Instrument Serif', serif; font-size: 44px; }
.mark { width: 56px; height: 56px; border-radius: 14px; background: #1d6a4c; color: #fff; display: grid; place-items: center; font-size: 40px; padding-bottom: 6px; }
h1 { font-family: 'Instrument Serif', serif; font-weight: 400; font-size: 104px; line-height: 0.98; letter-spacing: -1px; margin-top: 64px; }
h1 em { color: #1d6a4c; }
.sub { font-size: 34px; line-height: 1.35; color: #4a4842; margin-top: 30px; max-width: 860px; }
.card { background: #fcfbf7; border: 2px solid #d9d5c9; border-radius: 22px; box-shadow: 0 2px 4px rgba(28,27,24,.06), 0 18px 48px rgba(28,27,24,.10); }
.mono { font-family: 'JetBrains Mono', monospace; }
.badge { display: inline-flex; align-items: center; gap: 10px; border-radius: 999px; padding: 6px 18px; font-weight: 650; font-size: 24px; }
.warn { background: #fdf0d5; color: #875500; }
.good { background: #e3f0e8; color: #1d6a4c; }
.bad { background: #fbe9e7; color: #b42318; }
.foot { margin-top: auto; display: flex; justify-content: space-between; align-items: flex-end; font-size: 26px; color: #4a4842; }
.cta { background: #1d6a4c; color: #fff; border-radius: 16px; padding: 22px 34px; font-weight: 650; font-size: 30px; }
.fine { font-size: 20px; color: #67645c; margin-top: 18px; }
`;

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE}</style></head><body><div class="frame">${body}</div></body></html>`;

const ADS: Record<string, string> = {
  '01-agents-prepare': page(`
    <div class="brand"><span class="mark">t</span>Tieout</div>
    <h1>Agents prepare.<br/><em>People sign off.</em></h1>
    <p class="sub">The month-end close where every entry arrives with a reason, a confidence and the evidence behind it.</p>
    <div class="card" style="margin-top:56px;padding:36px 40px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span class="mono" style="font-size:24px;color:#67645c;">P-0101 · Journal entry</span>
        <span class="badge warn">◷ Needs approval</span>
      </div>
      <div style="font-size:36px;font-weight:650;margin-top:16px;line-height:1.25;">Accrue Cumulus Hosting for September – $41,250.00</div>
      <div style="font-size:27px;color:#4a4842;margin-top:14px;line-height:1.4;border-left:6px solid #1d6a4c;padding-left:20px;">The invoice arrived on Oct 2 but covers September’s service, so the cost belongs in September.</div>
      <div style="display:flex;gap:28px;margin-top:24px;font-size:24px;color:#4a4842;align-items:center;">
        <span>Confidence <b class="mono">97%</b></span><span>Evidence <b>bill CH-2609-88213</b></span><span class="badge good">✓ 15/15 checks</span>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:22px;">
      <div class="card" style="padding:26px 30px;"><div class="mono" style="font-size:52px;font-weight:700;color:#1d6a4c;">76</div><div style="font-size:24px;color:#4a4842;margin-top:6px;">small, certain items applied within the Controller’s policy</div></div>
      <div class="card" style="padding:26px 30px;"><div class="mono" style="font-size:52px;font-weight:700;color:#875500;">37</div><div style="font-size:24px;color:#4a4842;margin-top:6px;">waiting for a person, each with its reason</div></div>
    </div>
    <div class="foot"><div>Reconciliations, accruals, flux, intercompany.<div class="fine">Demo data: a fictional company.</div></div><span class="cta">Try the live demo</span></div>`),

  '02-controls-enforced': page(`
    <div class="brand"><span class="mark">t</span>Tieout</div>
    <h1>Controls you can<br/><em>prove</em>, not promise.</h1>
    <p class="sub">Segregation of duties, approval limits and a tamper-evident audit trail are enforced by the app and by the database.</p>
    <div class="card" style="margin-top:52px;padding:34px 40px;">
      <div style="display:flex;gap:16px;align-items:center;"><span class="badge bad">⊘ Blocked · SOD-02</span><span style="font-size:26px;color:#4a4842;">Jordan Lee tried to approve</span></div>
      <div style="font-size:31px;margin-top:18px;line-height:1.35;">“You ran the agent that prepared this, so a different person has to approve it.”</div>
    </div>
    <div class="card" style="margin-top:22px;padding:30px 40px;display:flex;justify-content:space-between;align-items:center;">
      <div><div style="font-size:30px;font-weight:650;">Audit chain intact</div><div class="mono" style="font-size:22px;color:#67645c;margin-top:8px;">SHA-256 · 294 events re-hashed · 514cf08c16…</div></div>
      <span class="badge good">✓ Verified</span>
    </div>
    <div class="card" style="margin-top:22px;padding:30px 40px;display:flex;justify-content:space-between;align-items:center;">
      <div><div style="font-size:30px;font-weight:650;">Payroll accrual $413,182.00</div><div style="font-size:24px;color:#4a4842;margin-top:8px;">Above the Controller’s limit, so it routes to the CFO</div></div>
      <span class="badge warn">→ CFO</span>
    </div>
    <div class="foot"><div>Maker-checker · approval limits · row-level security<div class="fine">Demo data: a fictional company.</div></div><span class="cta">See it work</span></div>`),

  '03-every-number-explains-itself': page(`
    <div class="brand"><span class="mark">t</span>Tieout</div>
    <h1>Every variance<br/><em>explains itself.</em></h1>
    <p class="sub">Flux commentary drafted from the ledger, with drivers that add up to the change. To the cent.</p>
    <div class="card" style="margin-top:52px;padding:36px 40px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <span style="font-size:30px;font-weight:650;">6310 Events and conferences</span>
        <span class="mono" style="font-size:32px;font-weight:700;">+$102,141.31</span>
      </div>
      <div style="margin-top:30px;display:grid;grid-template-columns:330px 1fr;row-gap:22px;align-items:center;font-size:25px;">
        <span>ConfabCon Events</span><span style="display:flex;align-items:center;gap:14px;"><span style="display:inline-block;margin-left:120px;width:230px;height:26px;background:#2a78d6;border-radius:0 6px 6px 0;"></span><b class="mono" style="font-size:23px;">+$110,000</b></span>
        <span>Atrium Event Spaces</span><span style="display:flex;align-items:center;gap:14px;"><b class="mono" style="font-size:23px;width:106px;text-align:right;">−$7,751</b><span style="display:inline-block;width:21px;height:26px;background:#eb6834;border-radius:6px 0 0 6px;"></span></span>
        <span>Atrium (card)</span><span style="display:flex;align-items:center;gap:14px;"><b class="mono" style="font-size:23px;width:106px;text-align:right;">−$108</b><span style="display:inline-block;width:4px;height:26px;background:#eb6834;"></span></span>
      </div>
      <div style="display:flex;gap:26px;margin-top:26px;font-size:22px;color:#4a4842;"><span><span style="display:inline-block;width:16px;height:16px;background:#2a78d6;border-radius:3px;margin-right:8px;"></span>Increase</span><span><span style="display:inline-block;width:16px;height:16px;background:#eb6834;border-radius:3px;margin-right:8px;"></span>Decrease</span><span class="badge good" style="margin-left:auto;font-size:21px;">✓ Drivers sum exactly (AX-FLX-02)</span></div>
    </div>
    <div class="card" style="margin-top:22px;padding:30px 40px;font-size:26px;line-height:1.45;color:#4a4842;border-left:8px solid #1d6a4c;">
      “Events and conferences rose $102,141 from August. The main driver is ConfabCon Events, new this month (+$110,000). Against the $11,958 budget the month is $98,667 over.”
      <div style="font-size:21px;color:#67645c;margin-top:10px;">Drafted by the flux agent · approved by the Controller</div>
    </div>
    <div class="foot"><div>Draft in seconds. Approve with one click.<div class="fine">Demo data: a fictional company.</div></div><span class="cta">Open the demo</span></div>`),
};

const out = resolve('docs/ads');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const p = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
  for (const [name, html] of Object.entries(ADS)) {
    await p.setContent(html, { waitUntil: 'load' });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: resolve(out, `${name}.png`), clip: { x: 0, y: 0, width: 1080, height: 1350 } });
    console.log(`docs/ads/${name}.png`);
  }
} finally {
  await browser.close();
}
writeFileSync(resolve(out, 'README.md'), `# Launch creatives\n\nThree 1080×1350 (4:5) feed ads rendered by \`npm run ads\` from \`scripts/render-ads.ts\`. Original copy, Tieout's own design tokens and fonts; figures come from the fictional demo company (Bramblewood Labs), labelled as such on each creative.\n\n| File | Message |\n|---|---|\n| 01-agents-prepare.png | Agents prepare, people sign off: a proposal with why, confidence, evidence and checks |\n| 02-controls-enforced.png | Controls you can prove: SoD block and a verified audit chain |\n| 03-every-number-explains-itself.png | Flux drivers that add up to the variance |\n`);
