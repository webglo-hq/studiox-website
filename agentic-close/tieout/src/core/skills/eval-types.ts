import type { JsonValue } from '../util/json';

/** One golden case: run a skill against a named fixture and assert on the proposals it produces. */
export interface EvalCase {
  id: string;
  title: string;
  fixture: string;
  params?: Record<string, JsonValue>;
  expect: EvalExpectation[];
}

/**
 * Assertion over the run's proposals. `where` matches dotted paths into the proposal row,
 * e.g. { "kind": "finding", "payload.category": "duplicate_payment" }. String values prefixed
 * with "~" match case-insensitively by substring; numeric `{ "approx": n, "tol": t }` objects
 * match within a relative tolerance.
 */
export interface EvalExpectation {
  description: string;
  where?: Record<string, JsonValue>;
  count?: number;
  min?: number;
  max?: number;
}

export interface EvalExpectationResult {
  description: string;
  passed: boolean;
  detail: string;
}

export interface EvalCaseResult {
  caseId: string;
  title: string;
  passed: boolean;
  expectations: EvalExpectationResult[];
  proposals: number;
  durationMs: number;
}
