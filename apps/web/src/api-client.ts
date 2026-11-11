/**
 * Typed API client. Request and response shapes come from the shared contracts and
 * every response is validated at runtime. No credentials are sent or stored.
 */
import {
  CatalogStatusSchema,
  DiscoverResponseSchema,
  ErrorEnvelopeSchema,
  EventsListResponseSchema,
  ExplainResponseSchema,
  FeedbackResetResponseSchema,
  FeedbackResponseSchema,
  QuestResponseSchema,
  type CatalogStatus,
  type DiscoverRequest,
  type DiscoverResponse,
  type ErrorCode,
  type EventsListResponse,
  type ExplainRequest,
  type ExplainResponse,
  type FeedbackRequest,
  type FeedbackResetResponse,
  type FeedbackResponse,
  type QuestRequest,
  type QuestResponse,
} from '@serendipity/packages-contracts';
import type { ZodType } from 'zod';

export type ApiErrorCode = ErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(code: ApiErrorCode, message: string, status: number, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

export interface ApiClient {
  discover(request: DiscoverRequest, signal?: AbortSignal): Promise<DiscoverResponse>;
  explain(
    bridgeId: string,
    request: ExplainRequest,
    signal?: AbortSignal,
  ): Promise<ExplainResponse>;
  createQuest(request: QuestRequest, signal?: AbortSignal): Promise<QuestResponse>;
  listEvents(signal?: AbortSignal): Promise<EventsListResponse>;
  getStatus(eventId: string, signal?: AbortSignal): Promise<CatalogStatus>;
  /** Only call after an explicit user action (FR-09 9.2). */
  submitFeedback(request: FeedbackRequest, signal?: AbortSignal): Promise<FeedbackResponse>;
  /** Deletes all saved feedback for the anonymous ID (FR-09 9.4). */
  resetFeedback(anonymousId: string, signal?: AbortSignal): Promise<FeedbackResetResponse>;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: body === undefined ? { accept: 'application/json' } : jsonHeaders,
      // Anonymous public API: never send cookies or other ambient credentials.
      credentials: 'omit',
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signal) init.signal = signal;

    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, init);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError('NETWORK_ERROR', 'Could not reach the service.', 0);
    }

    const payload: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const envelope = ErrorEnvelopeSchema.safeParse(payload);
      if (envelope.success) {
        const { code, message, requestId } = envelope.data.error;
        throw new ApiError(code, message, res.status, requestId);
      }
      throw new ApiError(statusToCode(res.status), `Request failed (${res.status}).`, res.status);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the service.', res.status);
    }
    return parsed.data;
  }

  return {
    discover: (request, signal) =>
      call('POST', '/api/v1/discover', DiscoverResponseSchema, request, signal),
    explain: (bridgeId, request, signal) =>
      call(
        'POST',
        `/api/v1/bridges/${encodeURIComponent(bridgeId)}/explain`,
        ExplainResponseSchema,
        request,
        signal,
      ),
    createQuest: (request, signal) =>
      call('POST', '/api/v1/quests', QuestResponseSchema, request, signal),
    listEvents: (signal) =>
      call('GET', '/api/v1/events', EventsListResponseSchema, undefined, signal),
    getStatus: (eventId, signal) =>
      call(
        'GET',
        `/api/v1/events/${encodeURIComponent(eventId)}/status`,
        CatalogStatusSchema,
        undefined,
        signal,
      ),
    submitFeedback: (request, signal) =>
      call('POST', '/api/v1/feedback', FeedbackResponseSchema, request, signal),
    resetFeedback: (anonymousId, signal) =>
      call(
        'DELETE',
        `/api/v1/feedback/${encodeURIComponent(anonymousId)}`,
        FeedbackResetResponseSchema,
        undefined,
        signal,
      ),
  };
}

const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json' };

function statusToCode(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'VERSION_CONFLICT';
    case 429:
      return 'THROTTLED';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'INTERNAL_ERROR';
  }
}
