export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'MFA_REQUIRED'
  | 'FORBIDDEN'
  | 'SOD_VIOLATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'ONTOLOGY_VIOLATION'
  | 'PERIOD_LOCKED'
  | 'RATE_LIMITED'
  | 'BUDGET_EXCEEDED'
  | 'CSRF'
  | 'INTERNAL';

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 401,
  FORBIDDEN: 403,
  SOD_VIOLATION: 403,
  CSRF: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ONTOLOGY_VIOLATION: 422,
  PERIOD_LOCKED: 423,
  RATE_LIMITED: 429,
  BUDGET_EXCEEDED: 429,
  INTERNAL: 500,
};

/** Error with a stable machine code and a message that is safe to show to end users. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AppError');
}

export function assert(condition: unknown, code: ErrorCode, message: string, details?: unknown): asserts condition {
  if (!condition) throw new AppError(code, message, details);
}

export function notFound(what: string): AppError {
  return new AppError('NOT_FOUND', `${what} was not found`);
}

/** Translate low-level database errors (constraint/trigger raises) into AppErrors. */
export function fromDbError(e: unknown): unknown {
  if (typeof e !== 'object' || e === null) return e;
  const err = e as { code?: string; message?: string; constraint?: string; detail?: string };
  const msg = err.message ?? 'Database error';
  switch (err.code) {
    case '23505':
      return new AppError('CONFLICT', `Duplicate record (${err.constraint ?? 'unique constraint'})`, { constraint: err.constraint });
    case '23503':
      return new AppError('VALIDATION', `Reference to a missing record (${err.constraint ?? 'foreign key'})`, { constraint: err.constraint });
    case '23514':
    case '23502':
      return new AppError('VALIDATION', msg, { constraint: err.constraint });
    case 'P0001':
      // RAISE EXCEPTION from our triggers carries an "EK-xxx:" prefix naming the invariant
      if (msg.startsWith('EK-PERIOD')) return new AppError('PERIOD_LOCKED', msg);
      if (msg.startsWith('EK-SOD')) return new AppError('SOD_VIOLATION', msg);
      if (msg.startsWith('EK-')) return new AppError('ONTOLOGY_VIOLATION', msg);
      return new AppError('VALIDATION', msg);
    default:
      return e;
  }
}
