/**
 * Typed domain errors. Every error carries a stable `code` that the HTTP layer maps to a status
 * and the UI maps to plain-English copy. Axiom violations carry the ontology axiom id.
 */
export type ErrorCode =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'unauthenticated'
  | 'sod_violation'
  | 'invariant_violation'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'precondition_failed'
  | 'internal';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export const validation = (message: string, details: Record<string, unknown> = {}) =>
  new DomainError('validation', message, details);
export const notFound = (what: string, id?: string) =>
  new DomainError('not_found', id ? `${what} ${id} was not found` : `${what} was not found`, { what, id });
export const conflict = (message: string, details: Record<string, unknown> = {}) =>
  new DomainError('conflict', message, details);
export const forbidden = (message: string, details: Record<string, unknown> = {}) =>
  new DomainError('forbidden', message, details);
export const sodViolation = (message: string, details: Record<string, unknown> = {}) =>
  new DomainError('sod_violation', message, details);
export const invariant = (axiomId: string, message: string, details: Record<string, unknown> = {}) =>
  new DomainError('invariant_violation', `${axiomId}: ${message}`, { axiomId, ...details });
export const precondition = (message: string, details: Record<string, unknown> = {}) =>
  new DomainError('precondition_failed', message, details);

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}

/** Map storage-level failures (Postgres or the memory emulation) to domain errors. */
export function fromStorageError(e: unknown): DomainError {
  if (isDomainError(e)) return e;
  const err = e as { code?: string; message?: string };
  const message = err?.message ?? String(e);
  const axiom = /\b(AX-[A-Z]+-\d+)\b/.exec(message)?.[1];
  if (axiom) return invariant(axiom, message.replace(`${axiom}: `, ''));
  switch (err?.code) {
    case '23505':
      return conflict('A record with the same unique key already exists', { cause: message });
    case '23503':
      return validation('A referenced record does not exist', { cause: message });
    case '23514':
    case '23502':
      return validation('The record violates a data rule', { cause: message });
    default:
      return new DomainError('internal', 'Storage error', { cause: message });
  }
}
