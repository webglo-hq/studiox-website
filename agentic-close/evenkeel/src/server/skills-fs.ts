import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadSkillPackages, type SkillPackage } from '../framework/skills/manifest';
import { fromRoot } from './paths';

/** Read skills/<id>/** from disk into the flat file map the skill loader expects. */
export function readSkillFiles(dir = fromRoot('skills')): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(md|json|txt|csv)$/i.test(name)) out[`skills/${relative(dir, p).replace(/\\/g, '/')}`] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

export function loadSkillsFromDisk(dir?: string): SkillPackage[] {
  return loadSkillPackages(readSkillFiles(dir));
}
