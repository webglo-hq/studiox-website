/*
 * `npm run ontology:export`: write the close ontology as Turtle and JSON-LD (OWL, RDFS, SKOS,
 * SHACL and Dublin Core terms) to docs/ontology/, so it can be opened in Protégé or any RDF
 * tool. The files carry the ontology version; the app serves the same exports from the
 * ontology explorer.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { closeOntology, ONTOLOGY_VERSION } from '../src/packs/accounting/ontology';
import { fromRoot } from '../src/server/paths';

const model = closeOntology();
const dir = fromRoot('docs', 'ontology');
mkdirSync(dir, { recursive: true });
const ttl = fromRoot('docs', 'ontology', 'evenkeel-close.ttl');
const jsonld = fromRoot('docs', 'ontology', 'evenkeel-close.jsonld');
writeFileSync(ttl, model.toTurtle());
writeFileSync(jsonld, `${JSON.stringify(model.toJsonLd(), null, 2)}\n`);
console.log(`Ontology ${ONTOLOGY_VERSION}: ${model.allClasses().length} classes, ${model.allRelations().length} relations, ${model.allIndividuals().length} individuals, ${model.allAxioms().length} axioms`);
console.log(`  ${ttl}\n  ${jsonld}`);
