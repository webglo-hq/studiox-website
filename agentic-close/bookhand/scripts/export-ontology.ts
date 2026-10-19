/**
 * Exports the close ontology in machine-readable form: docs/ontology/bookhand-close.ttl (Turtle, OWL/RDFS)
 * and docs/ontology/bookhand-close.jsonld (JSON-LD). Usage: npm run ontology:export
 * (--check exits 1 when the committed exports are stale; tests/unit/docs.test.ts runs the same check).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toJsonLd, toTurtle } from '../src/ontology/export';
import { closeOntology } from '../src/packs/accounting/ontology';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'docs', 'ontology');

export function renderOntologyExports(): Record<string, string> {
  return {
    'bookhand-close.ttl': toTurtle(closeOntology),
    'bookhand-close.jsonld': `${JSON.stringify(toJsonLd(closeOntology), null, 2)}\n`,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = renderOntologyExports();
  if (process.argv.includes('--check')) {
    const stale = Object.entries(files).filter(([name, text]) => !existsSync(join(dir, name)) || readFileSync(join(dir, name), 'utf8') !== text);
    if (stale.length) {
      console.error(`stale ontology exports: ${stale.map(([n]) => n).join(', ')} (run npm run ontology:export)`);
      process.exit(1);
    }
    console.log('ontology exports are current');
  } else {
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    console.log(`wrote ${Object.keys(files).map((n) => `docs/ontology/${n}`).join(', ')} (ontology v${closeOntology.spec.version}, ${closeOntology.classes().length} classes)`);
  }
}
