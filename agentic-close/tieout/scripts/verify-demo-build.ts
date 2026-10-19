/**
 * Static checks on the zero-install demo build (dist/demo). Fails the build when the output
 * could not run as a static, offline, sandbox-safe page:
 *   - total size ≤ 15 MB, and a <title> of two to four words
 *   - every reference is relative (no root-absolute or external src/href/url())
 *   - no service worker, no network calls to other hosts
 *   - every Web Storage / IndexedDB access sits inside a try block
 * The behavioural check (boot, sign in, run agents, approve) is the Playwright suite in
 * tests/e2e-demo, run by `npm run e2e:demo`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(process.cwd(), 'dist/demo');
const LIMIT = 15 * 1024 * 1024;
const problems: string[] = [];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(root);
const total = files.reduce((s, f) => s + statSync(f).size, 0);
if (total > LIMIT) problems.push(`demo is ${(total / 1048576).toFixed(2)} MB (limit 15 MB)`);

const html = readFileSync(join(root, 'index.html'), 'utf8');
const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
const words = title.split(/\s+/).filter(Boolean).length;
if (words < 2 || words > 4) problems.push(`<title> "${title}" should be two to four words`);

const textFiles = files.filter((f) => /\.(html|js|css|svg|json)$/.test(f));
for (const f of textFiles) {
  const s = readFileSync(f, 'utf8');
  const rel = relative(root, f);
  // root-absolute or external references in markup
  for (const m of s.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const v = m[1]!;
    if (v.startsWith('#') || v.startsWith('./') || v.startsWith('data:') || v.startsWith('blob:') || /^[a-z0-9_-]+\.[a-z0-9]+$/i.test(v)) continue;
    if (/^(https?:)?\/\//i.test(v) || v.startsWith('/')) problems.push(`${rel}: non-relative reference ${v.slice(0, 80)}`);
  }
  for (const m of s.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    const v = m[1]!;
    if (v.startsWith('data:') || v.startsWith('./') || v.startsWith('#') || !/^(\/|https?:)/i.test(v)) continue;
    problems.push(`${rel}: non-relative url(${v.slice(0, 60)})`);
  }
  if (/navigator\.serviceWorker|serviceWorker\.register/.test(s)) problems.push(`${rel}: registers a service worker`);
  if (/\.(js|html)$/.test(f)) {
    for (const m of s.matchAll(/\b(localStorage|sessionStorage|indexedDB)\b/g)) {
      const before = s.slice(Math.max(0, m.index! - 400), m.index!);
      const lastTry = before.lastIndexOf('try{') >= 0 ? before.lastIndexOf('try{') : before.lastIndexOf('try {');
      const lastCatch = before.lastIndexOf('catch');
      if (lastTry < 0 || lastCatch > lastTry) problems.push(`${rel}: ${m[1]} access outside try/catch near offset ${m.index}`);
    }
    for (const m of s.matchAll(/fetch\(\s*["'`](https?:\/\/[^"'`]+)/g)) problems.push(`${rel}: network call to ${m[1]}`);
  }
}

const mb = (total / 1048576).toFixed(2);
if (problems.length) {
  console.error(`Demo build check FAILED (${files.length} files, ${mb} MB):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Demo build OK: dist/demo, ${files.length} files, ${mb} MB, title "${title}"; relative paths only, no service worker, guarded storage.`);
