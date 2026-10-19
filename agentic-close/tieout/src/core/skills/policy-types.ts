/**
 * Skill policy: what accounting users tune without code. Versioned and audited on every change.
 *  - autonomy level (bounded by the manifest's max)
 *  - thresholds (manifest-declared tunables + generic autoPostMax/minConfidence/sampleRate)
 *  - mappings (e.g. vendor -> account/department)
 *  - plain-English rules, compiled by a deterministic controlled-language compiler (pack-provided),
 *    shown back to the user as an interpretation before they take effect
 */
import type { JsonValue } from '../util/json';

export type PolicyThresholds = Record<string, number>;

export interface PolicyMapping {
  id: string;
  match: Record<string, string>;
  set: Record<string, string>;
  note?: string;
}

export interface PolicyRule {
  id: string;
  text: string;
  status: 'active' | 'disabled' | 'unrecognized';
  compiled: Record<string, JsonValue> | null;
  interpretation: string;
  createdBy: string;
  createdAt: string;
}
