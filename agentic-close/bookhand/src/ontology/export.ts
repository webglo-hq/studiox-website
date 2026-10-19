import type { Ontology } from './kernel';

/** OWL 2 / RDFS serialization in Turtle. Axioms are carried as annotated individuals of bh:Axiom. */
export function toTurtle(o: Ontology): string {
  const { prefix, iri, title, version, description } = o.spec;
  const lit = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"@en`;
  const lines: string[] = [
    `@prefix ${prefix}: <${iri}#> .`,
    '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .',
    '@prefix dcterms: <http://purl.org/dc/terms/> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `<${iri}> a owl:Ontology ;`,
    `  dcterms:title ${lit(title)} ;`,
    `  dcterms:description ${lit(description)} ;`,
    `  owl:versionInfo "${version}" ;`,
    `  owl:versionIRI <${iri}/${version}> .`,
    '',
    `${prefix}:whyItMatters a owl:AnnotationProperty ; rdfs:label "why it matters"@en .`,
    `${prefix}:formalStatement a owl:AnnotationProperty ; rdfs:label "formal statement"@en .`,
    `${prefix}:standardRef a owl:AnnotationProperty ; rdfs:label "standard reference"@en .`,
    `${prefix}:reaCategory a owl:AnnotationProperty ; rdfs:label "REA category"@en .`,
    `${prefix}:materializedBy a owl:AnnotationProperty ; rdfs:label "materialized by table"@en .`,
    `${prefix}:appliesTo a owl:ObjectProperty ; rdfs:label "applies to"@en .`,
    `${prefix}:severity a owl:DatatypeProperty ; rdfs:label "severity"@en .`,
    '',
  ];
  for (const c of o.classes()) {
    const parts = [`${c.id} a owl:Class`, `rdfs:label ${lit(c.label)}`, `skos:definition ${lit(c.definition)}`, `${prefix}:whyItMatters ${lit(c.whyItMatters)}`, `skos:example ${lit(c.example)}`];
    for (const p of c.parents) parts.push(`rdfs:subClassOf ${p}`);
    for (const s of c.synonyms ?? []) parts.push(`skos:altLabel ${lit(s)}`);
    if (c.formal) parts.push(`${prefix}:formalStatement ${lit(c.formal)}`);
    if (c.rea) parts.push(`${prefix}:reaCategory "${c.rea}"`);
    if (c.table) parts.push(`${prefix}:materializedBy "${c.table}"`);
    for (const s of c.standards ?? []) parts.push(`${prefix}:standardRef ${lit(`${s.source} ${s.ref}${s.note ? ` (${s.note})` : ''}`)}`);
    lines.push(`${parts.join(' ;\n  ')} .`, '');
    for (const prop of c.properties ?? []) {
      const isData = prop.range.startsWith('xsd:') || prop.range === `${prefix}:Money`;
      lines.push(
        `${prefix}:${camel(c.id)}_${prop.id} a ${isData ? 'owl:DatatypeProperty' : 'owl:ObjectProperty'} ;\n  rdfs:label ${lit(prop.label)} ;\n  rdfs:domain ${c.id} ;\n  rdfs:range ${prop.range} ;\n  skos:definition ${lit(prop.definition)} .`,
        '',
      );
    }
  }
  for (const r of o.spec.relations) {
    const parts = [`${r.id} a owl:ObjectProperty`, `rdfs:label ${lit(r.label)}`, `rdfs:domain ${r.domain}`, `rdfs:range ${r.range}`, `skos:definition ${lit(r.definition)}`];
    if (r.inverse) parts.push(`owl:inverseOf ${r.inverse}`);
    lines.push(`${parts.join(' ;\n  ')} .`, '');
  }
  for (const i of o.spec.individuals) {
    lines.push(`${i.id} a owl:NamedIndividual, ${i.type} ;\n  rdfs:label ${lit(i.label)} ;\n  skos:definition ${lit(i.definition)} ;\n  ${prefix}:whyItMatters ${lit(i.whyItMatters)} ;\n  skos:example ${lit(i.example)} .`, '');
  }
  for (const a of o.axioms()) {
    lines.push(
      `${prefix}:${a.id.replace(/[^A-Za-z0-9]/g, '_')} a owl:NamedIndividual, ${prefix}:Axiom ;\n  rdfs:label ${lit(a.label)} ;\n  ${prefix}:appliesTo ${a.appliesTo} ;\n  ${prefix}:formalStatement ${lit(a.formal)} ;\n  skos:definition ${lit(a.plainEnglish)} ;\n  ${prefix}:severity "${a.severity}" .`,
      '',
    );
  }
  return lines.join('\n');
}

function camel(id: string): string {
  return id.split(':')[1] ?? id;
}

/** JSON-LD document (schema-light, for tooling that prefers JSON). */
export function toJsonLd(o: Ontology): Record<string, unknown> {
  const { prefix, iri } = o.spec;
  return {
    '@context': {
      [prefix]: `${iri}#`,
      owl: 'http://www.w3.org/2002/07/owl#',
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
      skos: 'http://www.w3.org/2004/02/skos/core#',
      label: 'rdfs:label',
      subClassOf: { '@id': 'rdfs:subClassOf', '@type': '@id' },
      definition: 'skos:definition',
      example: 'skos:example',
    },
    '@id': iri,
    '@type': 'owl:Ontology',
    'owl:versionInfo': o.version,
    contentHash: o.hash,
    '@graph': [
      ...o.classes().map((c) => ({
        '@id': c.id,
        '@type': 'owl:Class',
        label: c.label,
        subClassOf: c.parents,
        definition: c.definition,
        whyItMatters: c.whyItMatters,
        example: c.example,
        module: c.module,
        rea: c.rea,
        table: c.table,
        standards: c.standards,
        properties: c.properties,
        normalBalance: c.normalBalance,
        accountClass: c.accountClass,
      })),
      ...o.spec.relations.map((r) => ({ '@id': r.id, '@type': 'owl:ObjectProperty', label: r.label, domain: r.domain, range: r.range, definition: r.definition })),
      ...o.spec.individuals.map((i) => ({ '@id': i.id, '@type': ['owl:NamedIndividual', i.type], label: i.label, definition: i.definition })),
      ...o.axioms().map((a) => ({
        '@id': `${prefix}:${a.id}`,
        '@type': `${prefix}:Axiom`,
        label: a.label,
        appliesTo: a.appliesTo,
        formal: a.formal,
        definition: a.plainEnglish,
        severity: a.severity,
        assertions: a.assertions,
      })),
    ],
  };
}

/** Graph view data for the explorer: nodes = classes, edges = subClassOf + relations. */
export function toGraph(o: Ontology): {
  nodes: Array<{ id: string; label: string; module: string; depth: number; degree: number }>;
  edges: Array<{ source: string; target: string; kind: 'subClassOf' | 'relation'; label?: string }>;
} {
  const edges: Array<{ source: string; target: string; kind: 'subClassOf' | 'relation'; label?: string }> = [];
  for (const c of o.classes()) for (const p of c.parents) edges.push({ source: c.id, target: p, kind: 'subClassOf' });
  for (const r of o.spec.relations) edges.push({ source: r.domain, target: r.range, kind: 'relation', label: r.label });
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return {
    nodes: o.classes().map((c) => ({ id: c.id, label: c.label, module: c.module, depth: o.ancestors(c.id).length, degree: degree.get(c.id) ?? 0 })),
    edges,
  };
}
