/**
 * Skill eval assertions (domain-agnostic). An expectation selects proposals with `where` (dotted
 * paths into the proposal row, array indices allowed) and checks how many matched.
 *   "~text"            case-insensitive substring (any element when the field is an array)
 *   { approx, tol }    numeric match within a relative tolerance
 *   anything else      equality (membership when the field is an array)
 */
import type { JsonValue } from '../util/json';
import type { EvalExpectation, EvalExpectationResult } from './eval-types';

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

function valueMatches(actual: unknown, expected: JsonValue): boolean {
  if (typeof expected === 'string' && expected.startsWith('~')) {
    const needle = expected.slice(1).toLowerCase();
    const hay = Array.isArray(actual) ? actual.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [typeof actual === 'string' ? actual : JSON.stringify(actual ?? '')];
    return hay.some((h) => h.toLowerCase().includes(needle));
  }
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && 'approx' in expected) {
    const target = Number((expected as { approx: number }).approx);
    const tol = Number((expected as { tol?: number }).tol ?? 0.01);
    const n = Number(actual);
    return Number.isFinite(n) && Math.abs(n - target) <= Math.abs(target) * tol;
  }
  if (Array.isArray(actual) && !Array.isArray(expected)) return actual.some((x) => x === expected || Number(x) === expected);
  if (typeof expected === 'number') return Number(actual) === expected;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function matchesWhere(row: unknown, where: Record<string, JsonValue> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([path, expected]) => valueMatches(getPath(row, path), expected));
}

export function evaluateExpectations(rows: readonly unknown[], expectations: readonly EvalExpectation[]): EvalExpectationResult[] {
  return expectations.map((e) => {
    const n = rows.filter((r) => matchesWhere(r, e.where)).length;
    const problems: string[] = [];
    if (e.count !== undefined && n !== e.count) problems.push(`expected ${e.count}, got ${n}`);
    if (e.min !== undefined && n < e.min) problems.push(`expected at least ${e.min}, got ${n}`);
    if (e.max !== undefined && n > e.max) problems.push(`expected at most ${e.max}, got ${n}`);
    if (e.count === undefined && e.min === undefined && e.max === undefined && n === 0) problems.push('expected at least one match');
    return { description: e.description, passed: problems.length === 0, detail: problems.length ? problems.join('; ') : `${n} matching` };
  });
}
