/**
 * `npm run ontology:export`: write the close ontology as OWL in JSON-LD and Turtle to
 * docs/ontology/ (for Protégé, triple stores, or diffing between versions).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toJsonLd, toTurtle } from '../src/core/ontology/export';
import { closeOntology } from '../src/packs/accounting/ontology';

const o = closeOntology();
const dir = resolve(process.cwd(), 'docs/ontology');
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'tieout-ontology.jsonld'), `${JSON.stringify(toJsonLd(o), null, 2)}\n`);
writeFileSync(resolve(dir, 'tieout-ontology.ttl'), toTurtle(o));
const s = o.stats();
console.log(`ontology v${s.version} (${s.hash.slice(0, 12)}): ${s.classes} classes, ${s.relations} relations, ${s.axioms} axioms (${s.executableAxioms} executable), ${s.terms} terms → docs/ontology/tieout-ontology.{jsonld,ttl}`);
