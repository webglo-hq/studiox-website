import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

/**
 * Renders the social ads (1080x1350, 4:5) into docs/ads/ from HTML with real product screenshots
 * (docs/screenshots, produced by `npm run screenshots`). Everything is inlined, so the page needs no network.
 * Run: npm run ads:render
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'ads');
mkdirSync(out, { recursive: true });

const dataUri = (path: string, type: string) => `data:${type};base64,${readFileSync(join(root, path)).toString('base64')}`;
const inter = dataUri('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', 'font/woff2');
const serif = dataUri('node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2', 'font/woff2');
const shot = (name: string) => dataUri(`docs/screenshots/${name}.png`, 'image/png');

/** The mark; on the green ad it is drawn inverted (white tile, green strokes) so it does not disappear. */
const logo = (inverted: boolean) => {
  const tile = inverted ? '#ffffff' : '#1f6b52';
  const ink = inverted ? '#1f6b52' : '#e8f5ef';
  return `<svg width="56" height="56" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="8" fill="${tile}"/><path d="M9 10.5h10M9 15.5h7" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/><path d="M9 21.5h5" stroke="${ink}" stroke-width="2.2" stroke-linecap="round" opacity="0.55"/><path d="M17.5 21l2.8 2.8 5.2-6.3" stroke="#e8b04b" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
};

interface Ad {
  file: string;
  theme: { bg: string; text: string; sub: string; accent: string; ctaBg: string; ctaText: string; frame: string; invertLogo?: boolean };
  eyebrow: string;
  headline: string;
  sub: string;
  /** Screenshot crop: source image, the region to show (in source pixels) and the frame height on the ad. */
  crop: { image: string; x: number; y: number; width: number; height: number };
}

const ADS: Ad[] = [
  {
    file: 'ad-01-twenty-six-needed-you.png',
    theme: { bg: '#f6f5f1', text: '#16181d', sub: '#4a4f5a', accent: '#1f6b52', ctaBg: '#1f6b52', ctaText: '#ffffff', frame: '#e3e0d8' },
    eyebrow: 'Month-end close',
    headline: '209 changes proposed.<br/><em>26 needed a person.</em>',
    sub: 'Agents prepare the close. Your policy applies the routine. People decide the rest.',
    crop: { image: 'desktop-06-agent-run-trace', x: 252, y: 70, width: 1176, height: 820 },
  },
  {
    file: 'ad-02-the-memo-said-approve.png',
    theme: { bg: '#0d0f13', text: '#eef0f3', sub: '#b9bec8', accent: '#e8b04b', ctaBg: '#e8b04b', ctaText: '#16181d', frame: '#262a33' },
    eyebrow: 'Prompt-injection hygiene',
    headline: 'The bank memo said<br/><em>&ldquo;approve everything.&rdquo;</em><br/>Bookhand didn&rsquo;t.',
    sub: 'Text from banks, vendors and documents is data, never instructions. Anything that reads like one is flagged and never auto-applied.',
    crop: { image: 'desktop-04-inbox-injection-flagged', x: 724, y: 0, width: 716, height: 410 },
  },
  {
    file: 'ad-03-the-ledger-remembers.png',
    theme: { bg: '#1f6b52', text: '#ffffff', sub: '#d7efe4', accent: '#e8b04b', ctaBg: '#ffffff', ctaText: '#1f6b52', frame: '#2c7d61', invertLogo: true },
    eyebrow: 'Controls an auditor can check',
    headline: 'Agents prepare.<br/>People approve.<br/><em>The ledger remembers.</em>',
    sub: 'Maker-checker, approval limits and a hash-chained audit log, enforced by the database itself.',
    crop: { image: 'desktop-12-audit-log', x: 252, y: 70, width: 1176, height: 760 },
  },
];

function html(ad: Ad): string {
  const t = ad.theme;
  const frameWidth = 960;
  const scale = frameWidth / ad.crop.width;
  const frameHeight = Math.round(ad.crop.height * scale);
  const source = ad.crop.image.startsWith('desktop') ? { w: 1440, h: 900 } : { w: 390, h: 844 };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: Inter; src: url(${inter}) format('woff2'); font-weight: 100 900; }
    @font-face { font-family: 'Instrument Serif'; src: url(${serif}) format('woff2'); }
    * { box-sizing: border-box; margin: 0; }
    html, body { width: 1080px; height: 1350px; }
    body { background: ${t.bg}; color: ${t.text}; font-family: Inter, sans-serif; padding: 72px 60px 56px; display: flex; flex-direction: column; }
    .eyebrow { font-size: 26px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: ${t.accent}; }
    h1 { font-family: 'Instrument Serif', Georgia, serif; font-weight: 400; font-size: 92px; line-height: 0.98; letter-spacing: -0.01em; margin-top: 22px; }
    h1 em { font-style: italic; color: ${t.accent}; }
    p.sub { font-size: 31px; line-height: 1.35; color: ${t.sub}; margin-top: 26px; max-width: 900px; }
    .frame-gap { flex: 1; min-height: 36px; }
    .frame { flex: none; width: ${frameWidth}px; height: ${frameHeight}px; border-radius: 22px; border: 2px solid ${t.frame}; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,0.25); background-image: url(${shot(ad.crop.image)}); background-repeat: no-repeat; background-size: ${Math.round(source.w * scale)}px ${Math.round(source.h * scale)}px; background-position: -${Math.round(ad.crop.x * scale)}px -${Math.round(ad.crop.y * scale)}px; }
    footer { display: flex; align-items: center; justify-content: space-between; margin-top: 40px; }
    .brand { display: flex; align-items: center; gap: 16px; font-size: 38px; font-weight: 700; }
    .cta { background: ${t.ctaBg}; color: ${t.ctaText}; font-size: 28px; font-weight: 700; padding: 18px 30px; border-radius: 999px; }
    .fine { font-size: 18px; color: ${t.sub}; margin-top: 18px; opacity: 0.85; }
  </style></head><body>
    <div class="eyebrow">${ad.eyebrow}</div>
    <h1>${ad.headline}</h1>
    <p class="sub">${ad.sub}</p>
    <div class="frame-gap"></div>
    <div class="frame" role="img" aria-label="Bookhand product screenshot"></div>
    <footer><div class="brand">${logo(!!t.invertLogo)}<span>Bookhand</span></div><div class="cta">Try the live demo &rarr;</div></footer>
    <div class="fine">Screens from the demo company, Brambleway Software (fictional).</div>
  </body></html>`;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
  for (const ad of ADS) {
    await page.setContent(html(ad), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(out, ad.file), type: 'png' });
    console.log(`wrote docs/ads/${ad.file}`);
  }
} finally {
  await browser.close();
}
