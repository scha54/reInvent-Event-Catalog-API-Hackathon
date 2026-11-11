/**
 * Events API adapter (task 2.4).
 *
 * - Talks only to the allowlisted host `api.awsevents.com` over HTTPS.
 * - Auth is a server-side bearer token supplied by `getAccessToken`; it is only
 *   ever sent in the `Authorization` header, never in URLs or errors.
 * - `listAllSessions` follows `nextToken` until absent, regardless of page size.
 *   Tokens are opaque and passed back unchanged. Repeated tokens and runaway
 *   walks (max-page guard) fail loudly.
 * - Retries/backoff come from `withRetry` (task 2.2).
 * - Responses are validated against the spike findings (SPIKE.md). Every
 *   optional field is optional; nothing is fabricated.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventMeta } from '@serendipity/packages-contracts';
import { EventMetaSchema } from '@serendipity/packages-contracts';
import { HttpStatusError, withRetry, type RetryOptions } from './retry.js';

export const ALLOWED_HOST = 'api.awsevents.com';
export const DEFAULT_BASE_URL = `https://${ALLOWED_HOST}`;
export const DEFAULT_MAX_PAGES = 500;
export const DEFAULT_MAX_CONCURRENCY = 4;
export const CORRELATION_HEADER = 'x-correlation-id';

/* ------------------------------------------------------------------ */
/* Wire schemas (from the OpenAPI spec, see SPIKE.md)                  */
/* ------------------------------------------------------------------ */

const strArray = z.array(z.string());

/** Only `sessionId` and `title` are required by the spec; the rest is optional. */
export const RawSessionSchema = z.looseObject({
  sessionId: z.string().min(1).max(128),
  title: z.string(),
  abbreviation: z.string().optional(),
  abstract: z.string().optional(),
  type: z.string().optional(),
  level: z.string().optional(),
  venue: z.string().optional(),
  room: z.string().optional(),
  isAllDaySession: z.boolean().optional(),
  isReservable: z.boolean().optional(),
  seatAvailability: z.string().optional(),
  sessionTime: z
    .looseObject({
      date: z.string().optional(),
      time: z.string().optional(),
      length: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
  speakers: z.array(z.looseObject({ name: z.string().optional() })).optional(),
  tracks: strArray.optional(),
  topics: strArray.optional(),
  industries: strArray.optional(),
  areasOfInterest: strArray.optional(),
  roles: strArray.optional(),
  services: strArray.optional(),
  segments: strArray.optional(),
  features: strArray.optional(),
  customerPersonas: strArray.optional(),
  experiences: strArray.optional(),
  additionalActivities: strArray.optional(),
  focusAreas: strArray.optional(),
});
export type RawSession = z.infer<typeof RawSessionSchema>;

/** Envelope only; items are validated one by one so a bad record never hides the page. */
const SessionsEnvelopeSchema = z.looseObject({
  items: z.array(z.unknown()),
  totalCount: z.number().int().nonnegative().optional(),
  nextToken: z.string().min(1).max(512).optional(),
});

const WireEventSchema = z.looseObject({
  eventId: z.string().min(1).max(128),
  name: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  address: z.looseObject({ city: z.string().optional() }).optional(),
});
const GetEventEnvelopeSchema = z.looseObject({ event: WireEventSchema });

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export interface MalformedItem {
  /** Zero-based index within the page. */
  readonly index: number;
  readonly reason: string;
  readonly raw: unknown;
}

export interface RawSessionPage {
  readonly eventId: string;
  /** Zero-based page number within the walk. */
  readonly pageNumber: number;
  /** Token used to fetch this page (undefined for the first page), unchanged. */
  readonly requestToken?: string;
  /** Token for the next page, unchanged; absent on the last page. */
  readonly nextToken?: string;
  readonly totalCount?: number;
  /** Locale reported by `Content-Language`, if present. */
  readonly contentLanguage?: string;
  readonly correlationId: string;
  /** Records that satisfy the session contract. */
  readonly items: readonly RawSession[];
  /** Records that did not; kept for quarantine, never dropped silently. */
  readonly malformedItems: readonly MalformedItem[];
}

export interface ListSessionsOptions {
  readonly maxPages?: number;
  readonly locale?: string;
  readonly includeAbstracts?: boolean;
}

export interface EventsApiAdapter {
  getEvent(eventId: string): Promise<EventMeta>;
  listAllSessions(eventId: string, opts?: ListSessionsOptions): AsyncIterable<RawSessionPage>;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class DisallowedHostError extends Error {
  constructor(readonly host: string) {
    super(`Host "${host}" is not allowlisted; only ${ALLOWED_HOST} may be contacted`);
    this.name = 'DisallowedHostError';
  }
}

/** 401/403 from the Events API. Never includes credentials. */
export class EventsApiAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly correlationId: string,
  ) {
    super(`Events API rejected the request with HTTP ${status} (correlationId ${correlationId})`);
    this.name = 'EventsApiAuthError';
  }
}

export class EventsApiNotFoundError extends Error {
  constructor(
    readonly eventId: string,
    readonly correlationId: string,
  ) {
    super(`Event "${eventId}" not found (correlationId ${correlationId})`);
    this.name = 'EventsApiNotFoundError';
  }
}

export class ContractViolationError extends Error {
  constructor(
    message: string,
    readonly correlationId: string,
  ) {
    super(`${message} (correlationId ${correlationId})`);
    this.name = 'ContractViolationError';
  }
}

export class PaginationError extends Error {
  constructor(
    readonly kind: 'repeated-token' | 'max-pages',
    message: string,
    readonly pagesFetched: number,
  ) {
    super(message);
    this.name = 'PaginationError';
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Minimal counting semaphore for bounded concurrency. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  constructor(limit: number) {
    this.available = Math.max(1, Math.floor(limit));
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.available > 0) {
      this.available--;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.available++;
    }
  }
}

/** Throws unless `url` is https on exactly the allowlisted host (default port). */
export function assertAllowedUrl(url: URL): void {
  if (url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST || url.port !== '') {
    throw new DisallowedHostError(url.host || url.href);
  }
}

const EventIdSchema = z.string().min(1).max(128);

export interface EventsApiAdapterConfig {
  /** Must resolve to the allowlisted host. Defaults to https://api.awsevents.com. */
  readonly baseUrl?: string;
  /** Server-side credential source (scope `events/access`). Omit for anonymous calls. */
  readonly getAccessToken?: () => Promise<string | undefined> | string | undefined;
  /** Injectable for tests. Node's global fetch (undici) keeps connections alive. */
  readonly fetch?: typeof fetch;
  readonly maxConcurrency?: number;
  readonly retry?: RetryOptions;
  readonly newCorrelationId?: () => string;
}

/* ------------------------------------------------------------------ */
/* Implementation                                                      */
/* ------------------------------------------------------------------ */

export function createEventsApiAdapter(config: EventsApiAdapterConfig = {}): EventsApiAdapter {
  const base = new URL(config.baseUrl ?? DEFAULT_BASE_URL);
  assertAllowedUrl(base);
  const doFetch = config.fetch ?? fetch;
  const gate = new Semaphore(config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  const newId = config.newCorrelationId ?? randomUUID;

  async function request(url: URL, correlationId: string, eventId: string): Promise<Response> {
    assertAllowedUrl(url);
    const token = await config.getAccessToken?.();
    try {
      return await gate.run(() =>
        withRetry(
          (signal) =>
            doFetch(url, {
              method: 'GET',
              signal,
              redirect: 'error',
              headers: {
                accept: 'application/json',
                connection: 'keep-alive',
                [CORRELATION_HEADER]: correlationId,
                ...(token ? { authorization: `Bearer ${token}` } : {}),
              },
            }),
          config.retry,
        ),
      );
    } catch (err) {
      if (err instanceof HttpStatusError) {
        if (err.status === 401 || err.status === 403) {
          throw new EventsApiAuthError(err.status, correlationId);
        }
        if (err.status === 404) throw new EventsApiNotFoundError(eventId, correlationId);
      }
      throw err;
    }
  }

  async function readJson(res: Response, correlationId: string): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new ContractViolationError('Response body is not valid JSON', correlationId);
    }
  }

  function describe(error: z.ZodError): string {
    return error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
  }

  async function getEvent(eventId: string): Promise<EventMeta> {
    const id = EventIdSchema.parse(eventId);
    const correlationId = newId();
    const url = new URL(`/v1/events/${encodeURIComponent(id)}`, base);
    const res = await request(url, correlationId, id);
    const parsed = GetEventEnvelopeSchema.safeParse(await readJson(res, correlationId));
    if (!parsed.success) {
      throw new ContractViolationError(
        `GetEvent response violates contract: ${describe(parsed.error)}`,
        correlationId,
      );
    }
    const e = parsed.data.event;
    if (e.eventId !== id) {
      throw new ContractViolationError(
        `GetEvent returned eventId "${e.eventId}" for requested "${id}"`,
        correlationId,
      );
    }
    // Only map fields that exist; there is no URL field in the API.
    return EventMetaSchema.parse({
      eventId: e.eventId,
      ...(e.name !== undefined ? { name: e.name } : {}),
      ...(e.startDate !== undefined ? { startsAt: e.startDate } : {}),
      ...(e.endDate !== undefined ? { endsAt: e.endDate } : {}),
      ...(e.address?.city !== undefined ? { location: e.address.city } : {}),
    });
  }

  async function* listAllSessions(
    eventId: string,
    opts: ListSessionsOptions = {},
  ): AsyncGenerator<RawSessionPage, void, void> {
    const id = EventIdSchema.parse(eventId);
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new RangeError('maxPages must be a positive integer');
    }
    const walkId = newId();
    const seen = new Set<string>();
    let token: string | undefined;

    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber >= maxPages) {
        throw new PaginationError(
          'max-pages',
          `Pagination exceeded maxPages (${maxPages}) for event "${id}" (walk ${walkId})`,
          pageNumber,
        );
      }
      const correlationId = `${walkId}.${pageNumber}`;
      const url = new URL(`/v1/events/${encodeURIComponent(id)}/sessions`, base);
      if (token !== undefined) url.searchParams.set('nextToken', token);
      if (opts.locale !== undefined) url.searchParams.set('locale', opts.locale);
      if (opts.includeAbstracts !== undefined) {
        url.searchParams.set('includeAbstracts', String(opts.includeAbstracts));
      }

      const res = await request(url, correlationId, id);
      const parsed = SessionsEnvelopeSchema.safeParse(await readJson(res, correlationId));
      if (!parsed.success) {
        throw new ContractViolationError(
          `ListSessions response violates contract: ${describe(parsed.error)}`,
          correlationId,
        );
      }

      const items: RawSession[] = [];
      const malformedItems: MalformedItem[] = [];
      parsed.data.items.forEach((raw, index) => {
        const item = RawSessionSchema.safeParse(raw);
        if (item.success) items.push(item.data);
        else malformedItems.push({ index, reason: describe(item.error), raw });
      });

      const nextToken = parsed.data.nextToken;
      if (nextToken !== undefined) {
        // Tokens are stored and sent unchanged. The first token is the request token
        // of the following page, so a repeat means the server is looping.
        if (seen.has(nextToken) || nextToken === token) {
          throw new PaginationError(
            'repeated-token',
            `Repeated nextToken detected after ${pageNumber + 1} page(s) for event "${id}" (walk ${walkId})`,
            pageNumber + 1,
          );
        }
        seen.add(nextToken);
      }

      const contentLanguage = res.headers.get('content-language');
      yield {
        eventId: id,
        pageNumber,
        ...(token !== undefined ? { requestToken: token } : {}),
        ...(nextToken !== undefined ? { nextToken } : {}),
        ...(parsed.data.totalCount !== undefined ? { totalCount: parsed.data.totalCount } : {}),
        ...(contentLanguage !== null ? { contentLanguage } : {}),
        correlationId,
        items,
        malformedItems,
      };

      if (nextToken === undefined) return;
      token = nextToken;
    }
  }

  return { getEvent, listAllSessions };
}
