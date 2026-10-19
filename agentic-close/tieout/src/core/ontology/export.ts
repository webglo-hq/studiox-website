/**
 * Serialise an ontology as OWL in JSON-LD and Turtle (W3C RDF), using SKOS for human-facing
 * annotations (definition, example, scope note = why it matters) and Dublin Core for sources.
 */
import type { Ontology } from './registry';

const STD_PREFIX: Record<string, string> = {
  'US-GAAP': 'https://xbrl.fasb.org/us-gaap/2026/elts/us-gaap-2026.xsd#us-gaap_',
  'XBRL-GL': 'http://www.xbrl.org/int/gl/cor/2016-12-01#',
  FIBO: 'https://spec.edmcouncil.org/fibo/ontology/',
};

function iri(o: Ontology, id: string): string {
  const [prefix, local] = id.includes(':') ? id.split(':') : [o.module.prefix, id];
  return prefix === o.module.prefix ? `${o.module.iri}${local}` : id;
}

export function toJsonLd(o: Ontology): Record<string, unknown> {
  const m = o.module;
  const graph: Record<string, unknown>[] = [
    {
      '@id': m.iri.replace(/#$/, ''),
      '@type': 'owl:Ontology',
      'dcterms:title': m.title,
      'dcterms:description': m.description,
      'owl:versionInfo': m.version,
      'tie:contentHash': o.hash,
    },
  ];
  for (const c of o.allClasses()) {
    graph.push({
      '@id': iri(o, c.id),
      '@type': 'owl:Class',
      'rdfs:label': c.label,
      ...(c.parents.length ? { 'rdfs:subClassOf': c.parents.map((p) => ({ '@id': iri(o, p) })) } : {}),
      'skos:definition': c.definition,
      'skos:scopeNote': c.whyItMatters,
      'skos:example': c.example,
      ...(c.synonyms?.length ? { 'skos:altLabel': c.synonyms } : {}),
      ...(c.rea ? { 'tie:reaRole': c.rea } : {}),
      'tie:group': c.group,
      ...(c.abstract ? { 'tie:abstract': true } : {}),
      ...(c.mappings?.length
        ? {
            'skos:mappingRelation': c.mappings.map((mp) => ({
              'tie:scheme': mp.scheme,
              'tie:ref': mp.ref,
              ...(STD_PREFIX[mp.scheme] ? { '@id': STD_PREFIX[mp.scheme] + mp.ref.replace(/^[a-z-]+:/, '') } : {}),
              ...(mp.match ? { 'tie:match': mp.match } : {}),
            })),
          }
        : {}),
      ...(c.citations?.length ? { 'dcterms:source': c.citations.map((id) => ({ '@id': `${m.iri}cite_${id}` })) } : {}),
    });
    for (const p of c.properties ?? []) {
      graph.push({
        '@id': `${iri(o, c.id)}_${p.name}`,
        '@type': p.range === 'ref' ? 'owl:ObjectProperty' : 'owl:DatatypeProperty',
        'rdfs:label': p.label,
        'rdfs:domain': { '@id': iri(o, c.id) },
        'rdfs:range': p.range === 'ref' ? { '@id': iri(o, p.refClass ?? 'tie:Thing') } : { '@id': xsd(p.range) },
        'skos:definition': p.description,
        ...(p.required ? { 'tie:required': true } : {}),
        ...(p.enumValues ? { 'tie:allowedValues': p.enumValues } : {}),
      });
    }
  }
  for (const r of m.relations) {
    graph.push({
      '@id': iri(o, r.id),
      '@type': 'owl:ObjectProperty',
      'rdfs:label': r.label,
      'rdfs:domain': { '@id': iri(o, r.domain) },
      'rdfs:range': { '@id': iri(o, r.range) },
      'skos:definition': r.description,
      ...(r.inverse ? { 'owl:inverseOf': { '@id': iri(o, r.inverse) } } : {}),
      ...(r.cardinality ? { 'tie:cardinality': r.cardinality } : {}),
    });
  }
  for (const a of m.axioms) {
    graph.push({
      '@id': `${m.iri}${a.id}`,
      '@type': 'tie:Axiom',
      'rdfs:label': a.title,
      'tie:formal': a.formal,
      'skos:definition': a.plainEnglish,
      'tie:severity': a.severity,
      'tie:enforcedBy': a.enforcedBy,
      'tie:executable': !!a.check,
      'tie:appliesTo': a.appliesTo.map((id) => ({ '@id': iri(o, id) })),
      'dcterms:source': a.citations.map((id) => ({ '@id': `${m.iri}cite_${id}` })),
    });
  }
  for (const c of m.citations) {
    graph.push({
      '@id': `${m.iri}cite_${c.id}`,
      '@type': 'dcterms:BibliographicResource',
      'dcterms:title': c.short,
      'dcterms:bibliographicCitation': c.full,
      'tie:kind': c.kind,
      ...(c.url ? { 'foaf:page': { '@id': c.url } } : {}),
    });
  }
  return {
    '@context': {
      owl: 'http://www.w3.org/2002/07/owl#',
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
      xsd: 'http://www.w3.org/2001/XMLSchema#',
      skos: 'http://www.w3.org/2004/02/skos/core#',
      dcterms: 'http://purl.org/dc/terms/',
      foaf: 'http://xmlns.com/foaf/0.1/',
      tie: m.iri,
    },
    '@graph': graph,
  };
}

function xsd(range: string): string {
  switch (range) {
    case 'date':
      return 'xsd:date';
    case 'datetime':
      return 'xsd:dateTime';
    case 'money':
    case 'integer':
      return 'xsd:integer';
    case 'decimal':
    case 'percent':
      return 'xsd:decimal';
    case 'boolean':
      return 'xsd:boolean';
    default:
      return 'xsd:string';
  }
}

function lit(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export function toTurtle(o: Ontology): string {
  const m = o.module;
  const local = (id: string) => (id.startsWith(`${m.prefix}:`) ? id : `${m.prefix}:${id}`);
  const out: string[] = [
    `@prefix ${m.prefix}: <${m.iri}> .`,
    '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .',
    '@prefix dcterms: <http://purl.org/dc/terms/> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `<${m.iri.replace(/#$/, '')}> a owl:Ontology ;`,
    `  dcterms:title ${lit(m.title)} ;`,
    `  owl:versionInfo ${lit(m.version)} .`,
    '',
  ];
  for (const c of o.allClasses()) {
    const parts = [`${local(c.id)} a owl:Class`, `  rdfs:label ${lit(c.label)}@en`];
    for (const p of c.parents) parts.push(`  rdfs:subClassOf ${local(p)}`);
    parts.push(`  skos:definition ${lit(c.definition)}@en`, `  skos:scopeNote ${lit(c.whyItMatters)}@en`, `  skos:example ${lit(c.example)}@en`);
    for (const s of c.synonyms ?? []) parts.push(`  skos:altLabel ${lit(s)}@en`);
    for (const mp of c.mappings ?? []) parts.push(`  skos:${mp.match === 'exact' ? 'exactMatch' : 'closeMatch'} ${lit(`${mp.scheme}:${mp.ref}`)}`);
    out.push(parts.join(' ;\n') + ' .', '');
  }
  for (const r of m.relations) {
    out.push(
      [`${local(r.id)} a owl:ObjectProperty`, `  rdfs:label ${lit(r.label)}@en`, `  rdfs:domain ${local(r.domain)}`, `  rdfs:range ${local(r.range)}`, `  skos:definition ${lit(r.description)}@en`].join(' ;\n') + ' .',
      '',
    );
  }
  for (const a of m.axioms) {
    out.push([`${m.prefix}:${a.id.replace(/-/g, '_')} a ${m.prefix}:Axiom`, `  rdfs:label ${lit(a.title)}@en`, `  ${m.prefix}:formal ${lit(a.formal)}`, `  skos:definition ${lit(a.plainEnglish)}@en`].join(' ;\n') + ' .', '');
  }
  return out.join('\n');
}
