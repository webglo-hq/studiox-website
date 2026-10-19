import type { OntologyClass } from '../../../ontology/kernel';

export const ONTOLOGY_VERSION = '1.6.0';

type Extra = Omit<Partial<OntologyClass>, 'id' | 'label' | 'parents' | 'module' | 'definition' | 'whyItMatters' | 'example'>;

/** Compact class declaration: cls(id, label, parents, module, definition, why, example, extra). */
export function cls(
  id: string,
  label: string,
  parents: string | string[],
  module: string,
  definition: string,
  whyItMatters: string,
  example: string,
  extra: Extra = {},
): OntologyClass {
  return {
    id,
    label,
    parents: Array.isArray(parents) ? parents : parents ? [parents] : [],
    module,
    definition,
    whyItMatters,
    example,
    since: extra.since ?? '1.0.0',
    ...extra,
  };
}
