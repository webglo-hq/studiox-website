import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/** Locate the project root (directory holding Evenkeel's package.json) from this module. */
export function projectRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'evenkeel') {
          cached = dir;
          return dir;
        }
      } catch {
        /* keep walking */
      }
    }
    dir = dirname(dir);
  }
  cached = resolve(process.cwd());
  return cached;
}

export function fromRoot(...parts: string[]): string {
  return join(projectRoot(), ...parts);
}
