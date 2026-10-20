/**
 * The gateway's error surface (design v0.5 §6).
 *
 * Every route returns `{ code, detail? }`; the HTTP status is a property of the
 * code, not of the call site. Keeping the mapping in one table means the
 * snapshot test pins behaviour rather than each handler's memory of it.
 */

export type ErrorCode =
  | 'INVALID_HASH'
  | 'SCHEMA_VIOLATION'
  | 'INVALID_HEX'
  | 'NON_NORMALIZED_INPUT'
  | 'TAG_TOO_LONG'
  | 'INVALID_BATCH_SIZE'
  | 'NO_STAGED'
  | 'UNKNOWN_TX'
  | 'CONTENT_NOT_FOUND'
  | 'PIN_FAILED'
  | 'GATEWAY_UPSTREAM'
  | 'INTERNAL';

export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  INVALID_HASH: 400,
  SCHEMA_VIOLATION: 400,
  INVALID_HEX: 400,
  NON_NORMALIZED_INPUT: 422,
  TAG_TOO_LONG: 422,
  INVALID_BATCH_SIZE: 413,
  NO_STAGED: 409,
  UNKNOWN_TX: 400,
  CONTENT_NOT_FOUND: 404,
  PIN_FAILED: 502,
  GATEWAY_UPSTREAM: 502,
  INTERNAL: 500,
};

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'GatewayError';
    this.code = code;
    this.detail = detail;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

/** Body shape for every error response. */
export function errorBody(error: GatewayError): { code: ErrorCode; detail?: string } {
  return error.detail === undefined
    ? { code: error.code }
    : { code: error.code, detail: error.detail };
}

/**
 * Map a `@menhir/core` typed error onto the gateway surface.
 *
 * The core speaks `UNKNOWN_KEY` / `SCHEMA_VIOLATION` / `NON_NORMALIZED_INPUT` /
 * `TAG_TOO_LONG` / `INVALID_HEX`. The gateway has no `UNKNOWN_KEY` code: an
 * unknown top-level content key is a schema violation from its point of view
 * (design v0.5 R6), so it is folded rather than leaked as a code the gateway's
 * own table does not document.
 */
export function fromCoreError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message ?? String(error);
  switch (code) {
    case 'UNKNOWN_KEY':
    case 'SCHEMA_VIOLATION':
      return new GatewayError('SCHEMA_VIOLATION', message);
    case 'NON_NORMALIZED_INPUT':
      return new GatewayError('NON_NORMALIZED_INPUT', message);
    case 'TAG_TOO_LONG':
      return new GatewayError('TAG_TOO_LONG', message);
    case 'INVALID_HEX':
      return new GatewayError('INVALID_HEX', message);
    default:
      return new GatewayError('INTERNAL', message);
  }
}
