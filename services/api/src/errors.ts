/**
 * API error type and status-code mapping for the error envelope
 * `{ "error": { "code", "message", "requestId" } }` (Requirements 13.3, 17.1).
 */
import type { ErrorCode } from '@serendipity/packages-contracts';

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  THROTTLED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/** A client-safe error. The message is returned verbatim, so never put internals in it. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, options: { retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const validationError = (message: string): ApiError =>
  new ApiError('VALIDATION_ERROR', message);
export const unauthorized = (message = 'Authentication required'): ApiError =>
  new ApiError('UNAUTHORIZED', message);
export const forbidden = (message = 'Access denied'): ApiError =>
  new ApiError('FORBIDDEN', message);
export const notFound = (message = 'Resource not found'): ApiError =>
  new ApiError('NOT_FOUND', message);
export const versionConflict = (message = 'Catalog version conflict'): ApiError =>
  new ApiError('VERSION_CONFLICT', message);
export const throttled = (retryAfterSeconds?: number): ApiError =>
  new ApiError(
    'THROTTLED',
    'Too many requests',
    retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
  );
export const serviceUnavailable = (message = 'Service temporarily unavailable'): ApiError =>
  new ApiError('SERVICE_UNAVAILABLE', message);
