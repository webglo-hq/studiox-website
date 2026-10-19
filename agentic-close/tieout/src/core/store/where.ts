import type { Condition, Scalar } from './types';

/** Evaluate a Where condition against a value (memory adapter semantics == SQL semantics). */
export function matches(value: unknown, cond: Condition | undefined): boolean {
  if (cond === undefined) return true;
  if (cond === null) return value === null || value === undefined;
  if (typeof cond !== 'object') return value === cond;
  if ('in' in cond) return cond.in.some((v) => v === value);
  if ('notIn' in cond) return value !== null && value !== undefined && !cond.notIn.some((v) => v === value);
  if ('ne' in cond) return value !== null && value !== undefined && value !== cond.ne;
  if ('isNull' in cond) return cond.isNull ? value === null || value === undefined : value !== null && value !== undefined;
  if ('ilike' in cond) {
    if (typeof value !== 'string') return false;
    return value.toLowerCase().includes(cond.ilike.toLowerCase());
  }
  const range = cond as { gt?: Scalar; gte?: Scalar; lt?: Scalar; lte?: Scalar };
  if (value === null || value === undefined) return false;
  const v = value as string | number;
  if (range.gt !== undefined && range.gt !== null && !(v > (range.gt as string | number))) return false;
  if (range.gte !== undefined && range.gte !== null && !(v >= (range.gte as string | number))) return false;
  if (range.lt !== undefined && range.lt !== null && !(v < (range.lt as string | number))) return false;
  if (range.lte !== undefined && range.lte !== null && !(v <= (range.lte as string | number))) return false;
  return true;
}

export function isEquality(cond: Condition | undefined): cond is Scalar {
  return cond === null || (cond !== undefined && typeof cond !== 'object');
}

export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1; // NULLS LAST (Postgres default for ASC)
  if (b === null || b === undefined) return -1;
  return (a as string | number) < (b as string | number) ? -1 : 1;
}
