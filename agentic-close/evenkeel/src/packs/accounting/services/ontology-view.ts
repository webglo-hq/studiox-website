import { z } from 'zod';
import { AppError } from '../../../framework/util/errors';
import { requirePermission, type ServiceContext } from '../domain/context';
import { closeOntology, ONTOLOGY_VERSION } from '../ontology';

/** Browsable ontology: modules, terms with plain-English definitions, axioms, graph, exports. */

export function overview(ctx: ServiceContext) {
  requirePermission(ctx, 'ontology.view');
  const o = closeOntology();
  const modules = new Map<string, number>();
  for (const c of o.allClasses()) modules.set(c.module, (modules.get(c.module) ?? 0) + 1);
  return {
    version: ONTOLOGY_VERSION,
    contentHash: o.contentHash,
    counts: { classes: o.allClasses().length, relations: o.allRelations().length, individuals: o.allIndividuals().length, axioms: o.allAxioms().length },
    modules: [...modules.entries()].map(([id, n]) => ({ id, classes: n })).sort((a, b) => a.id.localeCompare(b.id)),
    classes: o.allClasses().map((c) => ({ id: c.id, label: c.label, module: c.module, parents: c.parents, plain: c.plain })),
    axioms: o.allAxioms().map((a) => ({ id: a.id, name: a.name, appliesTo: a.appliesTo, severity: a.severity, plain: a.plain, formal: a.formal, sources: a.sources })),
    spec: { iri: o.spec.iri ?? null, title: o.spec.title ?? null },
  };
}

export function term(ctx: ServiceContext, id: string) {
  requirePermission(ctx, 'ontology.view');
  const o = closeOntology();
  const ex = o.explain(id);
  if (!ex) throw new AppError('NOT_FOUND', `Unknown term ${id}`);
  const isClass = o.hasClass(id);
  const c = isClass ? o.cls(id) : null;
  const rel = isClass ? o.relationsOf(id) : { outgoing: [], incoming: [] };
  const shape = isClass ? o.shape(id) : undefined;
  return {
    ...ex,
    module: c?.module ?? null,
    synonyms: c?.synonyms ?? [],
    mappings: c?.mappings ?? {},
    properties: c?.properties ?? [],
    children: isClass ? o.children(id).map((x) => ({ id: x.id, label: x.label })) : [],
    ancestors: isClass ? o.ancestors(id) : [],
    relations: { outgoing: rel.outgoing.map((r) => ({ id: r.id, label: r.label, range: r.range, cardinality: r.cardinality })), incoming: rel.incoming.map((r) => ({ id: r.id, label: r.label, domain: r.domain, cardinality: r.cardinality })) },
    axioms: isClass ? o.axiomsFor(id).map((a) => ({ id: a.id, name: a.name, plain: a.plain, formal: a.formal, severity: a.severity })) : [],
    individuals: isClass ? o.individualsOf(id).map((i) => ({ id: i.id, label: i.label, definition: i.definition })) : [],
    jsonSchema: shape ? (z.toJSONSchema(shape, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>) : null,
  };
}

export function search(ctx: ServiceContext, q: string) {
  requirePermission(ctx, 'ontology.view');
  return closeOntology().search(q, 30);
}

export function graph(ctx: ServiceContext) {
  requirePermission(ctx, 'ontology.view');
  return closeOntology().graph();
}

export function exportOntology(ctx: ServiceContext, format: 'jsonld' | 'ttl') {
  requirePermission(ctx, 'ontology.view');
  const o = closeOntology();
  return format === 'ttl' ? { filename: `evenkeel-close-ontology-${ONTOLOGY_VERSION}.ttl`, mediaType: 'text/turtle', content: o.toTurtle() } : { filename: `evenkeel-close-ontology-${ONTOLOGY_VERSION}.jsonld`, mediaType: 'application/ld+json', content: JSON.stringify(o.toJsonLd(), null, 2) };
}

/** Compact glossary for hover definitions across the app (loaded once per session). */
export function glossary(ctx: ServiceContext) {
  requirePermission(ctx, 'close.view');
  const o = closeOntology();
  const out: Record<string, { label: string; plain: string; why: string; example: string }> = {};
  for (const c of o.allClasses()) out[c.id] = { label: c.label, plain: c.plain, why: c.why, example: c.example };
  for (const i of o.allIndividuals()) out[i.id] = { label: i.label, plain: i.plain ?? i.definition, why: '', example: '' };
  for (const a of o.allAxioms()) out[a.id] = { label: a.name, plain: a.plain, why: a.formal, example: '' };
  return { version: ONTOLOGY_VERSION, terms: out };
}
