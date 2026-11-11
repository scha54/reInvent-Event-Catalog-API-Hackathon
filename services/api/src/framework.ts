/**
 * API handler framework: request ID propagation, schema validation, body size
 * limits, uniform error envelope, strict CORS allowlist and structured logging.
 *
 * Works on the API Gateway HTTP API (payload v2) event shape, declared
 * minimally here so no AWS typings are required.
 *
 * Requirements: 13.3 (NFR-01), 17.1 (NFR-05), 3.3 (FR-03).
 */
import { randomUUID } from 'node:crypto';
import { ZodError, type ZodType } from 'zod';
import {
  createLogger,
  type ErrorEnvelope,
  type LogContext,
  type Logger,
} from '@serendipity/packages-contracts';
import { ApiError, ERROR_STATUS, notFound, validationError, forbidden } from './errors.js';

/* ------------------------------------------------------------------ */
/* Event / result shapes                                               */
/* ------------------------------------------------------------------ */

export interface ApiEvent {
  rawPath?: string;
  rawQueryString?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
  pathParameters?: Record<string, string | undefined> | null;
  headers?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    requestId?: string;
    http?: { method?: string; path?: string };
    authorizer?: unknown;
  };
}

export interface ApiResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/* ------------------------------------------------------------------ */
/* Handler contract                                                    */
/* ------------------------------------------------------------------ */

export interface HandlerContext<TBody = unknown, TQuery = unknown> {
  requestId: string;
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  pathParams: Readonly<Record<string, string>>;
  query: TQuery;
  body: TBody;
  /** Request-scoped logger carrying the requestId. */
  logger: Logger;
  /** Adds eventId / catalogVersion / etc. to the final request log line. */
  annotate(fields: LogContext): void;
  /** Raw API Gateway event, for authorizer claims and similar. */
  event: ApiEvent;
}

export interface HandlerResponse {
  statusCode?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RouteDefinition<TBody = unknown, TQuery = unknown> {
  method: string;
  /** Path template, e.g. `/api/v1/bridges/{bridgeId}/explain`. */
  path: string;
  /** Validates the JSON body. Routes without it ignore any body. */
  bodySchema?: ZodType<TBody>;
  querySchema?: ZodType<TQuery>;
  /** Overrides the framework default body size limit for this route. */
  maxBodyBytes?: number;
  handler(ctx: HandlerContext<TBody, TQuery>): Promise<HandlerResponse> | HandlerResponse;
}

/** Builds a route while preserving the inferred body/query types. */
export function defineRoute<TBody = unknown, TQuery = unknown>(
  route: RouteDefinition<TBody, TQuery>,
): RouteDefinition {
  return route as unknown as RouteDefinition;
}

export interface ApiConfig {
  /** Exact origins allowed for CORS. Wildcards are rejected. */
  allowedOrigins: readonly string[];
  /** Default maximum request body size in bytes. */
  maxBodyBytes?: number;
  logger?: Logger;
  now?: () => number;
  generateRequestId?: () => string;
}

export const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
export const REQUEST_ID_HEADER = 'x-request-id';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const ALLOWED_HEADERS = 'content-type,x-request-id,authorization';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function lowerHeaders(raw: ApiEvent['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
  }
  return out;
}

function pickRequestId(
  headers: Record<string, string>,
  event: ApiEvent,
  generate: () => string,
): string {
  const supplied = headers[REQUEST_ID_HEADER];
  if (supplied && REQUEST_ID_PATTERN.test(supplied)) return supplied;
  const gateway = event.requestContext?.requestId;
  if (gateway && REQUEST_ID_PATTERN.test(gateway)) return gateway;
  return generate();
}

/** Matches a template against a concrete path; returns decoded params or null. */
export function matchPath(template: string, path: string): Record<string, string> | null {
  const t = template.split('/').filter(Boolean);
  const p = path.split('/').filter(Boolean);
  if (t.length !== p.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) {
    const seg = t[i] as string;
    const actual = p[i] as string;
    if (seg.startsWith('{') && seg.endsWith('}')) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(actual);
      } catch {
        return null;
      }
      params[seg.slice(1, -1)] = decoded;
    } else if (seg !== actual) {
      return null;
    }
  }
  return params;
}

/** Summarises a ZodError by field path and issue message only; never echoes input values. */
export function summarizeZodError(err: ZodError): string {
  const parts = err.issues.slice(0, 5).map((i) => {
    const path = i.path.map(String).join('.');
    return path ? `${path}: ${i.message}` : i.message;
  });
  return `Invalid request: ${parts.join('; ')}`;
}

function parseBody(event: ApiEvent, headers: Record<string, string>, limit: number): unknown {
  const raw = event.body;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw validationError(`Request body exceeds the ${limit} byte limit`);
  }
  const contentType = (headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw validationError('Content-Type must be application/json');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw validationError('Request body is not valid JSON');
  }
}

/** Prevents body-less requests from bypassing the size check via an oversized declared length. */
function checkDeclaredLength(headers: Record<string, string>, limit: number): void {
  const declared = headers['content-length'];
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limit) {
    throw validationError(`Request body exceeds the ${limit} byte limit`);
  }
}

/* ------------------------------------------------------------------ */
/* Response builders                                                   */
/* ------------------------------------------------------------------ */

const SECURITY_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function errorEnvelope(error: ApiError, requestId: string): ErrorEnvelope {
  return { error: { code: error.code, message: error.message, requestId } };
}

/* ------------------------------------------------------------------ */
/* Framework                                                           */
/* ------------------------------------------------------------------ */

export type ApiHandler = (event: ApiEvent) => Promise<ApiResult>;

export function createApiHandler(
  config: ApiConfig,
  routes: readonly RouteDefinition[],
): ApiHandler {
  for (const origin of config.allowedOrigins) {
    if (origin === '*' || origin.includes('*')) {
      throw new Error('CORS allowedOrigins must be exact origins; wildcards are not permitted');
    }
  }
  const allowed = new Set(config.allowedOrigins);
  const defaultLimit = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const baseLogger = config.logger ?? createLogger();
  const now = config.now ?? Date.now;
  const generateId = config.generateRequestId ?? randomUUID;

  return async (event: ApiEvent): Promise<ApiResult> => {
    const started = now();
    const headers = lowerHeaders(event.headers);
    const requestId = pickRequestId(headers, event, generateId);
    const method = (event.requestContext?.http?.method ?? 'GET').toUpperCase();
    const path = event.rawPath ?? event.requestContext?.http?.path ?? '/';
    const origin = headers['origin'];
    const originAllowed = origin !== undefined && allowed.has(origin);

    const annotations: LogContext = {};
    const logger = baseLogger.child({ requestId });
    let operation = `${method} ${path}`;

    const baseHeaders = (): Record<string, string> => {
      const h: Record<string, string> = { ...SECURITY_HEADERS, [REQUEST_ID_HEADER]: requestId };
      if (originAllowed && origin !== undefined) {
        h['access-control-allow-origin'] = origin;
        h['access-control-expose-headers'] = REQUEST_ID_HEADER;
        h['vary'] = 'Origin';
      }
      return h;
    };

    const finish = (
      statusCode: number,
      body: string,
      extra: Record<string, string> = {},
    ): ApiResult => {
      const latencyMs = now() - started;
      const fields = { ...annotations, operation, latencyMs, status: statusCode };
      if (statusCode >= 500) logger.error('request completed', fields);
      else if (statusCode >= 400) logger.warn('request completed', fields);
      else logger.info('request completed', fields);
      return { statusCode, headers: { ...baseHeaders(), ...extra }, body };
    };

    const fail = (error: ApiError): ApiResult => {
      const extra: Record<string, string> = {};
      if (error.retryAfterSeconds !== undefined)
        extra['retry-after'] = String(error.retryAfterSeconds);
      return finish(error.statusCode, JSON.stringify(errorEnvelope(error, requestId)), extra);
    };

    try {
      // Strict CORS: browsers sending a non-allowlisted Origin are refused outright.
      if (origin !== undefined && !originAllowed) throw forbidden('Origin not allowed');

      if (method === 'OPTIONS') {
        operation = `OPTIONS ${path}`;
        if (origin === undefined) throw notFound();
        return finish(204, '', {
          'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
          'access-control-allow-headers': ALLOWED_HEADERS,
          'access-control-max-age': '600',
        });
      }

      let matched: { route: RouteDefinition; params: Record<string, string> } | undefined;
      for (const route of routes) {
        if (route.method.toUpperCase() !== method) continue;
        const params = matchPath(route.path, path);
        if (params) {
          matched = { route, params };
          break;
        }
      }
      if (!matched) throw notFound();
      const { route, params } = matched;
      operation = `${method} ${route.path}`;

      const limit = route.maxBodyBytes ?? defaultLimit;
      checkDeclaredLength(headers, limit);
      const rawBody = parseBody(event, headers, limit);

      let body: unknown = undefined;
      if (route.bodySchema) {
        if (rawBody === undefined) throw validationError('Request body is required');
        body = route.bodySchema.parse(rawBody);
      }
      const query = route.querySchema
        ? route.querySchema.parse(event.queryStringParameters ?? {})
        : (event.queryStringParameters ?? {});

      const ctx: HandlerContext = {
        requestId,
        method,
        path,
        headers,
        pathParams: params,
        query,
        body,
        logger,
        annotate: (fields) => {
          Object.assign(annotations, fields);
        },
        event,
      };

      const result = await route.handler(ctx);
      const statusCode = result.statusCode ?? 200;
      const payload = result.body === undefined ? '' : JSON.stringify(result.body);
      return finish(statusCode, payload, result.headers ?? {});
    } catch (err) {
      if (err instanceof ApiError) return fail(err);
      if (err instanceof ZodError) return fail(validationError(summarizeZodError(err)));
      // Unknown failure: log redacted name/message (no stack), return a generic message.
      logger.error('unhandled error', { ...annotations, operation, error: err });
      return finish(
        ERROR_STATUS.INTERNAL_ERROR,
        JSON.stringify(
          errorEnvelope(new ApiError('INTERNAL_ERROR', 'Internal server error'), requestId),
        ),
      );
    }
  };
}
