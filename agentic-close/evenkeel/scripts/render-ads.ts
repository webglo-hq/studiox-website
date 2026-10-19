/*
 * `npm run ads`: render the social ad creatives (1080×1350, 4:5) into docs/ads/ with Playwright.
 * Original copy and artwork in Evenkeel's own brand; the product details shown are the
 * fictional Kitewell Labs demo, as it behaves (figures from the demo's September close).
 * Uses the Playwright Chromium already installed.
 */
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { fromRoot } from '../src/server/paths';

const OUT = fromRoot('docs', 'ads');
const font = (p: string) => `data:font/woff2;base64,${readFileSync(fromRoot('node_modules', p)).toString('base64')}`;
const INTER = font('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2');
const NEWS = font('@fontsource-variable/newsreader/files/newsreader-latin-wght-normal.woff2');
const MONO = font('@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2');

const MARK = `<svg width="56" height="56" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#2a49c4"/><path d="M16 6.5v8.5M7.5 15h17" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><path d="M10.5 18.6c1.6 3.1 3.6 4.7 5.5 4.7s3.9-1.6 5.5-4.7" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>`;

const BASE_CSS = `
@font-face { font-family: Inter; src: url(${INTER}) format('woff2'); font-weight: 100 900; }
@font-face { font-family: News; src: url(${NEWS}) format('woff2'); font-weight: 200 800; }
@font-face { font-family: Mono; src: url(${MONO}) format('woff2'); font-weight: 100 800; }
* { box-sizing: border-box; margin: 0; }
html, body { width: 1080px; height: 1350px; }
body { font-family: Inter, sans-serif; color: #1b1a17; background: #f4f2eb; overflow: hidden; position: relative; -webkit-font-smoothing: antialiased; }
.pad { position: absolute; inset: 0; padding: 84px 84px 72px; display: flex; flex-direction: column; }
.eyebrow { font: 700 22px/1 Inter; letter-spacing: .12em; text-transform: uppercase; color: #2a49c4; }
h1 { font: 500 92px/1.02 News; letter-spacing: -.02em; margin-top: 22px; }
.sub { font: 400 30px/1.4 Inter; color: #45433d; margin-top: 26px; max-width: 860px; }
.card { background: #fcfbf8; border: 1.5px solid #dedad0; border-radius: 28px; box-shadow: 0 2px 4px rgb(27 26 23 / 6%), 0 30px 60px rgb(27 26 23 / 12%); padding: 40px 44px; }
.foot { margin-top: auto; display: flex; align-items: center; justify-content: space-between; }
.brand { display: flex; align-items: center; gap: 16px; font: 600 40px/1 News; }
.fine { font: 400 19px/1.3 Inter; color: #6a675f; text-align: right; }
.cta-wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 12px; }
.cta { background: #2a49c4; color: #fff; font: 600 28px/1 Inter; padding: 20px 30px; border-radius: 14px; }
.badge { display: inline-block; font: 600 20px/1 Inter; padding: 9px 16px; border-radius: 99px; }
.b-warn { background: #fbefd6; color: #8a5300; } .b-good { background: #e2f0e8; color: #1c6a4a; } .b-acc { background: #e6eafa; color: #2a49c4; } .b-bad { background: #fae8e6; color: #b3261e; } .b-mute { background: #efece3; color: #45433d; }
.mono { font-family: Mono, monospace; }
`;

const page = (body: string, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${BASE_CSS}${extra}</style></head><body>${body}</body></html>`;

/** Brand, call to action and fine print. */
const FOOT = (fine: string) => `<div class="foot"><div class="brand">${MARK}<span>Evenkeel</span></div><div class="cta-wrap"><span class="cta">Try the demo →</span><div class="fine">${fine}</div></div></div>`;

const ADS: { file: string; html: string }[] = [
  {
    file: 'ad-1-agents-prepare-you-decide.png',
    html: page(
      `<div class="pad">
        <div class="eyebrow">Agentic month-end close</div>
        <h1>Your agents did the close.<br/>You signed it.</h1>
        <p class="sub">Every entry arrives with the reason, the evidence and a confidence. You approve; the database enforces the rest.</p>
        <div class="card" style="margin-top:56px">
          <div style="display:flex;gap:12px;margin-bottom:22px"><span class="badge b-mute">Journal entry</span><span class="badge b-warn">Waiting for you</span></div>
          <div style="font:500 44px/1.15 News">Accrue Northgate Consulting · $24,000.00</div>
          <div style="font:600 22px/1 Inter;margin-top:30px;color:#45433d">Why the agent proposes this</div>
          <p style="font:400 26px/1.45 Inter;margin-top:12px;color:#1b1a17">PO-1042 was received on Sep 30 and no bill references it. Accrued to 2100; it reverses automatically on Oct 1.</p>
          <div style="display:flex;align-items:center;gap:16px;margin-top:26px;font:500 22px/1 Inter;color:#45433d">Confidence <span style="width:180px;height:10px;border-radius:9px;background:#efece3;display:inline-block;overflow:hidden"><span style="display:block;width:92%;height:100%;background:#2a49c4"></span></span> 92% <span class="badge b-mute" style="margin-left:12px">Below materiality</span></div>
          <div style="display:flex;gap:16px;margin-top:34px">
            <span style="background:#1c6a4a;color:#fff;font:600 26px/1 Inter;padding:20px 30px;border-radius:14px">✓ Approve and post</span>
            <span style="border:1.5px solid #dedad0;color:#b3261e;font:600 26px/1 Inter;padding:20px 30px;border-radius:14px">Reject with a reason</span>
          </div>
        </div>
        ${FOOT('Runs in your browser; nothing to install.<br/>Demo data: fictional company.')}
      </div>`,
      'body{background: radial-gradient(120% 90% at 100% 0%, #e6eafa 0%, #f4f2eb 55%);}',
    ),
  },
  {
    file: 'ad-2-every-number-has-a-why.png',
    html: page(
      `<div class="pad">
        <div class="eyebrow" style="color:#a9bbff">Flux review</div>
        <h1 style="color:#f0eee8">Every number<br/>has a why.</h1>
        <p class="sub" style="color:#d0cdc4">Material variances get an explanation that someone other than its author approves, before the month can lock.</p>
        <div class="card" style="margin-top:56px;background:#1a1b18;border-color:#2f302b;color:#f0eee8;padding:16px 0">
          ${[
            ['6400 Marketing', '+230.5%', 'Approved', 'b-good', 'Brightstage Events sponsorship ($95,000, one-time) and an ads accrual explain 99% of the $116,706 rise.'],
            ['5000 Cloud hosting', '+9.4%', 'Not required', 'b-mute', 'The September bill had not arrived; the agent accrued $161,402 first.'],
            ['6000 Salaries &amp; wages', '+0.5%', 'Not required', 'b-mute', 'Payroll earned but unpaid at month end was accrued ($620,727).'],
            ['4000 Subscription revenue', '+0.8%', 'Not required', 'b-mute', 'Below the $25,000 and 10% threshold.'],
          ]
            .map(
              ([acct, pct, status, tone, why], i) => `<div style="padding:26px 44px;${i ? 'border-top:1.5px solid #2f302b;' : ''}">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:20px"><span style="font:600 28px/1.2 Inter">${acct}</span><span style="display:flex;align-items:center;gap:18px"><span class="mono" style="font-size:26px;color:#d0cdc4">${pct}</span><span class="badge ${tone}" style="${tone === 'b-good' ? 'background:#16302a;color:#66c79b' : tone === 'b-warn' ? 'background:#33290f;color:#e9b44f' : 'background:#262722;color:#d0cdc4'}">${status}</span></span></div>
                <div style="font:400 23px/1.4 Inter;color:#a19e94;margin-top:8px">${why}</div>
              </div>`,
            )
            .join('')}
        </div>
        ${FOOT('<span style="color:#a19e94">Variance explanations drafted by agents,<br/>approved by your team. Fictional demo data.</span>').replace('<span>Evenkeel</span>', '<span style="color:#f0eee8">Evenkeel</span>')}
      </div>`,
      'body{background:#121311;}',
    ),
  },
  {
    file: 'ad-3-your-policy-your-ceiling.png',
    html: page(
      `<div class="pad">
        <div class="eyebrow">Autonomy with ceilings</div>
        <h1>Nothing posts above your policy without a person.</h1>
        <p class="sub">Set each skill from “suggest only” to “post and review after”. Your rules and materiality still hold items for a person.</p>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:40px">
          ${[
            ['L0', 'Suggest only', false],
            ['L1', 'Approve each', false],
            ['L2', 'Auto under $2,500', true],
            ['L3', 'Auto, review after', false],
          ]
            .map(([lvl, label, on]) => `<div class="card" style="padding:26px 24px;${on ? 'border:3px solid #2a49c4;background:#fcfbf8' : 'box-shadow:none'}"><div style="font:500 44px/1 News;color:${on ? '#2a49c4' : '#6a675f'}">${lvl}</div><div style="font:600 22px/1.3 Inter;margin-top:12px;color:${on ? '#1b1a17' : '#45433d'}">${label}</div></div>`)
            .join('')}
        </div>
        <div class="card" style="margin-top:24px;display:flex;flex-direction:column;gap:13px;padding:32px 44px">
          <div style="display:flex;justify-content:space-between;align-items:center"><span style="font:600 27px/1.2 Inter">Coding · Office supplies $167.83</span><span class="badge b-good">Posted automatically</span></div>
          <div style="height:1.5px;background:#dedad0"></div>
          <div style="display:flex;justify-content:space-between;align-items:center"><span style="font:600 27px/1.2 Inter">Coding · Gift cards $450.00</span><span class="badge b-warn">Held: your rule</span></div>
          <div style="font:400 23px/1.4 Inter;color:#45433d">Your policy, in plain English: “Never auto-post when memo contains ‘gift’.”</div>
          <div style="height:1.5px;background:#dedad0"></div>
          <div style="display:flex;justify-content:space-between;align-items:center"><span style="font:600 27px/1.2 Inter">Payroll accrual · $620,727.20</span><span class="badge b-bad">Held: material</span></div>
          <div style="font:400 23px/1.4 Inter;color:#45433d">At or above performance materiality: needs a controller or CFO, whatever the autonomy level.</div>
        </div>
        ${FOOT('Every decision in a hash-chained audit trail.<br/>Demo data: fictional company.')}
      </div>`,
    ),
  },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  for (const ad of ADS) {
    await p.setContent(ad.html, { waitUntil: 'load' });
    await p.evaluate(() => document.fonts.ready);
    const file = join(OUT, ad.file);
    await p.screenshot({ path: file, clip: { x: 0, y: 0, width: 1080, height: 1350 } });
    console.log(`  ${ad.file} (${Math.round(statSync(file).size / 1024)} KB)`);
  }
} finally {
  await browser.close();
}
