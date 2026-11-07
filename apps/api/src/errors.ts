export const API_ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'LOGIN_REQUIRED',
  'ACCOUNT_NOT_CONNECTED',
  'OUTSIDE_MESSAGING_WINDOW',
  'NOT_CONFIGURED',
  'TEMPORARY_FAILURE',
  'RATE_LIMITED_OR_BLOCKED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof API_ERROR_CODES)[number];

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['TEMPORARY_FAILURE', 'RATE_LIMITED_OR_BLOCKED']);

const HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  LOGIN_REQUIRED: 409,
  ACCOUNT_NOT_CONNECTED: 409,
  OUTSIDE_MESSAGING_WINDOW: 409,
  NOT_CONFIGURED: 503,
  TEMPORARY_FAILURE: 503,
  RATE_LIMITED_OR_BLOCKED: 429,
  INTERNAL: 500,
};

/** Every error the API returns: `{ error: { code, message, retryable } }` with the code's HTTP status. */
export class ApiError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCode,
    message: string,
    opts?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message, { cause: opts?.cause });
    this.name = 'ApiError';
    this.retryable = opts?.retryable ?? RETRYABLE.has(code);
  }
  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, retryable: this.retryable } };
  }
}
