export const CONNECTOR_ERROR_CODES = [
  'LOGIN_REQUIRED',
  'CHECKPOINT_REQUIRED',
  'UI_CHANGED',
  'UNSUPPORTED_CONTENT',
  'TEMPORARY_FAILURE',
  'RATE_LIMITED_OR_BLOCKED',
] as const;

export const API_ERROR_CODES = [
  ...CONNECTOR_ERROR_CODES,
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'OUTBOUND_DISABLED',
  'CONSENT_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'ACCOUNT_NOT_CONNECTED',
  'CONFIRMATION_REQUIRED',
  'IDENTITY_MISMATCH',
  'PROFILE_LOCKED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof API_ERROR_CODES)[number];

const RETRYABLE: ReadonlySet<string> = new Set(['TEMPORARY_FAILURE', 'RATE_LIMITED_OR_BLOCKED']);

const HTTP_STATUS: Record<ErrorCode, number> = {
  LOGIN_REQUIRED: 409,
  CHECKPOINT_REQUIRED: 409,
  UI_CHANGED: 502,
  UNSUPPORTED_CONTENT: 422,
  TEMPORARY_FAILURE: 503,
  RATE_LIMITED_OR_BLOCKED: 429,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  OUTBOUND_DISABLED: 403,
  CONSENT_REQUIRED: 400,
  IDEMPOTENCY_CONFLICT: 409,
  ACCOUNT_NOT_CONNECTED: 409,
  CONFIRMATION_REQUIRED: 400,
  IDENTITY_MISMATCH: 409,
  PROFILE_LOCKED: 409,
  INTERNAL: 500,
};

export class ConnectorError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCode,
    message: string,
    opts?: { retryable?: boolean; operation?: string; cause?: unknown },
  ) {
    super(message, { cause: opts?.cause });
    this.name = 'ConnectorError';
    this.retryable = opts?.retryable ?? RETRYABLE.has(code);
    this.operation = opts?.operation;
  }
  readonly operation?: string;
  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, retryable: this.retryable } };
  }
}
