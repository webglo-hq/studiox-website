/** Typed domain errors. The API maps `code` to an HTTP status and a plain-English message. */

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'SOD_VIOLATION'
  | 'INVARIANT'
  | 'PERIOD_LOCKED'
  | 'BUDGET_EXCEEDED'
  | 'RATE_LIMITED'
  | 'CSRF'
  | 'MFA_REQUIRED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export const httpStatusFor: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  SOD_VIOLATION: 403,
  INVARIANT: 422,
  PERIOD_LOCKED: 423,
  BUDGET_EXCEEDED: 429,
  RATE_LIMITED: 429,
  CSRF: 403,
  MFA_REQUIRED: 401,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

export function invariant(condition: unknown, message: string, details?: Record<string, unknown>): asserts condition {
  if (!condition) throw new DomainError('INVARIANT', message, details);
}

export function notFound(what: string, id?: string): never {
  throw new DomainError('NOT_FOUND', id ? `${what} ${id} was not found` : `${what} was not found`);
}

export function forbidden(message: string, details?: Record<string, unknown>): never {
  throw new DomainError('FORBIDDEN', message, details);
}

export function validation(message: string, details?: Record<string, unknown>): never {
  throw new DomainError('VALIDATION', message, details);
}
