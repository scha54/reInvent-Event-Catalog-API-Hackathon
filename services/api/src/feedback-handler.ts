/**
 * Feedback handlers.
 *
 * - `POST   /api/v1/feedback`               records an explicit thumbs-up/down
 * - `DELETE /api/v1/feedback/{anonymousId}` deletes/resets all feedback for that ID
 *
 * Records are minimal and keyed by an anonymous rotating ID (DynamoDB
 * `PK = FEEDBACK#<anonId>`, `SK = <timestamp>#<bridgeId>`) with a TTL. Nothing
 * is stored unless the client explicitly posts a rating. Raw IP addresses,
 * headers, user agents and profile data are never read or persisted.
 *
 * Requirements: FR-09 (9.1, 9.2, 9.3, 9.4), NFR-06 (18.2).
 */
import { randomUUID } from 'node:crypto';
import { FeedbackRequestSchema } from '@serendipity/packages-contracts';
import { validationError } from './errors.js';
import { defineRoute, type RouteDefinition } from './framework.js';

/** Default retention for feedback records. */
export const FEEDBACK_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Anonymous IDs are opaque tokens: letters, digits, `-` and `_`, 16-64 chars. */
const ANON_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** The only fields ever persisted for feedback. */
export interface FeedbackRecord {
  pk: string;
  sk: string;
  bridgeId: string;
  eventId: string;
  catalogVersion: string;
  rating: 'up' | 'down';
  createdAt: string;
  /** Epoch seconds, consumed by the DynamoDB TTL attribute. */
  ttl: number;
}

export interface FeedbackStore {
  put(record: FeedbackRecord): Promise<void>;
  /** Deletes every record under the partition; returns the number removed. */
  deleteByPartition(pk: string): Promise<number>;
}

export interface FeedbackHandlerDeps {
  store: FeedbackStore;
  ttlSeconds?: number;
  now?: () => number;
  generateAnonymousId?: () => string;
}

export const feedbackPartitionKey = (anonymousId: string): string => `FEEDBACK#${anonymousId}`;

/** In-memory store for tests and local development. */
export class InMemoryFeedbackStore implements FeedbackStore {
  readonly records = new Map<string, FeedbackRecord>();

  async put(record: FeedbackRecord): Promise<void> {
    this.records.set(`${record.pk}|${record.sk}`, record);
  }

  async deleteByPartition(pk: string): Promise<number> {
    let removed = 0;
    for (const [key, rec] of this.records) {
      if (rec.pk === pk) {
        this.records.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

export function createFeedbackRoutes(deps: FeedbackHandlerDeps): RouteDefinition[] {
  const ttlSeconds = deps.ttlSeconds ?? FEEDBACK_TTL_SECONDS;
  const now = deps.now ?? Date.now;
  const newAnonId = deps.generateAnonymousId ?? (() => randomUUID().replace(/-/g, ''));

  const submit = defineRoute({
    method: 'POST',
    path: '/api/v1/feedback',
    bodySchema: FeedbackRequestSchema,
    handler: async (ctx) => {
      const req = ctx.body as ReturnType<typeof FeedbackRequestSchema.parse>;
      if (req.anonymousId !== undefined && !ANON_ID_PATTERN.test(req.anonymousId)) {
        throw validationError('Invalid anonymousId');
      }
      // A fresh ID is issued when the client has none (or after a reset).
      const anonymousId = req.anonymousId ?? newAnonId();

      const nowMs = now();
      const createdAt = new Date(nowMs).toISOString();
      await deps.store.put({
        pk: feedbackPartitionKey(anonymousId),
        sk: `${createdAt}#${req.bridgeId}`,
        bridgeId: req.bridgeId,
        eventId: req.eventId,
        catalogVersion: req.catalogVersion,
        rating: req.rating,
        createdAt,
        ttl: Math.floor(nowMs / 1000) + ttlSeconds,
      });
      ctx.annotate({ eventId: req.eventId, catalogVersion: req.catalogVersion });
      return { statusCode: 201, body: { anonymousId, recorded: true } };
    },
  });

  const reset = defineRoute({
    method: 'DELETE',
    path: '/api/v1/feedback/{anonymousId}',
    handler: async (ctx) => {
      const anonymousId = ctx.pathParams['anonymousId'] as string;
      if (!ANON_ID_PATTERN.test(anonymousId)) throw validationError('Invalid anonymousId');
      const deleted = await deps.store.deleteByPartition(feedbackPartitionKey(anonymousId));
      return { body: { deleted } };
    },
  });

  return [submit, reset];
}
