import { randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SkillPackage } from '../framework/skills/manifest';
import { recordEvalReport, runSkillEvals } from '../packs/accounting/evals/run';
import { loadScenario, type ScenarioInfo } from '../packs/accounting/seed/load';
import { SCENARIO, USERS, type UserKey } from '../packs/accounting/seed/scenario';
import type { EkDb } from '../packs/accounting/store';
import { hashPassword } from './auth/password';

/**
 * Seeding the fictional Kitewell Labs demo into a server database. Demo users get either the
 * development password from DEMO_PASSWORD or a strong random password each, generated now
 * and written to .data/demo-credentials.json (gitignored, mode 0600). Nothing is committed.
 */

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 16 random characters in four groups (about 79 bits), from a CSPRNG. */
export function generatePassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}

export interface DemoCredentialsFile {
  note: string;
  generatedAt: string;
  users: Array<{ email: string; name: string; title: string; password: string }>;
}

export async function seedDemo(
  db: EkDb,
  opts: { skills: SkillPackage[]; demoPassword: string | null; credentialsFile: string | null; progress?: (s: string) => void; runEvals?: boolean },
): Promise<{ info: ScenarioInfo; credentials: DemoCredentialsFile | null }> {
  const passwords = Object.fromEntries(USERS.map((u) => [u.key, opts.demoPassword ?? generatePassword()])) as Record<UserKey, string>;
  opts.progress?.('Hashing demo passwords (scrypt)');
  const hashes = Object.fromEntries(await Promise.all(USERS.map(async (u) => [u.key, await hashPassword(passwords[u.key])] as const))) as Record<UserKey, string>;
  const info = await loadScenario(db, { skills: opts.skills, passwordHashes: hashes, progress: opts.progress });
  if (opts.runEvals !== false) {
    // Each skill's evaluation cases, run on a separate in-memory close of the same scenario,
    // so the skill catalog shows real results from the first start.
    opts.progress?.('Running the skill evaluations');
    const report = await runSkillEvals(opts.skills);
    await recordEvalReport(db, report, SCENARIO.asOf);
    opts.progress?.(`Skill evals: ${report.passed}/${report.total} cases passed`);
  }
  let credentials: DemoCredentialsFile | null = null;
  if (!opts.demoPassword) {
    credentials = {
      note: 'Development-only demo accounts for the fictional Kitewell Labs company. Generated at seed time; not committed. Delete .data/ to re-seed.',
      generatedAt: new Date().toISOString(),
      users: USERS.map((u) => ({ email: u.email, name: u.name, title: u.title, password: passwords[u.key] })),
    };
    if (opts.credentialsFile) writeCredentials(opts.credentialsFile, credentials);
  }
  return { info, credentials };
}

export function writeCredentials(file: string, creds: DemoCredentialsFile): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

/** email → password, or null when the file is missing or unreadable. */
export function readCredentials(file: string): Record<string, string> | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as DemoCredentialsFile;
    return Object.fromEntries(parsed.users.map((u) => [u.email, u.password]));
  } catch {
    return null;
  }
}
