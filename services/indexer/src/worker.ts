/**
 * SQS embedding/index worker (NFR-02 14.1/14.3, FR-10 10.2).
 *
 * - Idempotent: a message is a no-op when an embedding already exists for
 *   `(eventId, sessionId, sourceHash, embeddingModelVersion)`, so SQS
 *   at-least-once delivery and redrives are safe.
 * - DLQ-friendly: failures are returned as SQS partial batch responses
 *   (`batchItemFailures`); SQS retries them and redrives to the DLQ after
 *   `maxReceiveCount`. One bad message never fails the whole batch.
 * - Degraded mode: when embeddings are unavailable (throttling or 5xx retries
 *   exhausted, timeouts), a lexical-only fallback flag is set for the catalog
 *   version instead of blocking, and the message is still reported as failed so
 *   it can be retried later.
 */
import {
  HttpStatusError,
  RequestTimeoutError,
  RetriesExhaustedError,
} from '@serendipity/services-ingestion';
import type { BedrockEmbeddingClient, EmbeddingRecord } from './embedding-client.js';

/** One unit of embedding work (one session). Message body is this JSON. */
export interface EmbeddingWorkItem {
  readonly eventId: string;
  readonly catalogVersion: string;
  readonly sessionId: string;
  /** Content hash of the session; part of the idempotency key. */
  readonly sourceHash: string;
  readonly searchableText: string;
}

export interface EmbeddingLookupKey {
  readonly eventId: string;
  readonly sessionId: string;
  readonly sourceHash: string;
  readonly embeddingModelVersion: string;
}

/** Persistence for embeddings (S3/DynamoDB in production, in-memory in tests). */
export interface EmbeddingStore {
  get(key: EmbeddingLookupKey): Promise<EmbeddingRecord | undefined>;
  /** Must be safe to repeat with the same record. */
  put(record: EmbeddingRecord): Promise<void>;
}

export interface LexicalFallbackFlag {
  readonly eventId: string;
  readonly catalogVersion: string;
  readonly embeddingModelVersion: string;
  readonly reason: string;
}

/** Records that a catalog version must be served lexical-only. */
export interface FallbackFlagStore {
  setLexicalOnly(flag: LexicalFallbackFlag): Promise<void>;
}

/* ------------------------------ SQS shapes ------------------------------ */

export interface SqsRecordLike {
  readonly messageId: string;
  readonly body: string;
}
export interface SqsBatchLike {
  readonly Records: readonly SqsRecordLike[];
}
export interface SqsBatchResponse {
  readonly batchItemFailures: { itemIdentifier: string }[];
}

export type WorkOutcome = 'embedded' | 'duplicate' | 'skipped' | 'failed';

export interface WorkerLogEvent {
  readonly messageId: string;
  readonly outcome: WorkOutcome;
  readonly reason?: string;
  readonly eventId?: string;
  readonly catalogVersion?: string;
}

export interface WorkerDeps {
  readonly client: Pick<BedrockEmbeddingClient, 'embedText' | 'config'>;
  readonly store: EmbeddingStore;
  readonly fallback: FallbackFlagStore;
  /** Structured, PII-free logging hook (never receives session text). */
  readonly log?: (event: WorkerLogEvent) => void;
}

/* ------------------------------ validation ------------------------------ */

export class InvalidWorkItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkItemError';
  }
}

const REQUIRED_STRINGS = ['eventId', 'catalogVersion', 'sessionId', 'sourceHash'] as const;

export function parseWorkItem(body: string): EmbeddingWorkItem {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new InvalidWorkItemError('Work item is not valid JSON');
  }
  const o = (json ?? {}) as Record<string, unknown>;
  for (const k of REQUIRED_STRINGS) {
    if (typeof o[k] !== 'string' || o[k] === '') {
      throw new InvalidWorkItemError(`Work item field "${k}" must be a non-empty string`);
    }
  }
  if (typeof o['searchableText'] !== 'string') {
    throw new InvalidWorkItemError('Work item field "searchableText" must be a string');
  }
  return {
    eventId: o['eventId'] as string,
    catalogVersion: o['catalogVersion'] as string,
    sessionId: o['sessionId'] as string,
    sourceHash: o['sourceHash'] as string,
    searchableText: o['searchableText'] as string,
  };
}

/** True when the model is unavailable (throttling/5xx exhausted, timeout), as opposed to a bad message. */
export function isEmbeddingUnavailable(err: unknown): boolean {
  return (
    err instanceof RetriesExhaustedError ||
    err instanceof HttpStatusError ||
    err instanceof RequestTimeoutError
  );
}

/* ------------------------------- processing ----------------------------- */

/**
 * Process one work item. Resolves with the outcome, or throws so the caller can
 * report a batch item failure.
 */
export async function processWorkItem(
  item: EmbeddingWorkItem,
  deps: WorkerDeps,
): Promise<Exclude<WorkOutcome, 'failed'>> {
  if (item.searchableText.trim() === '') return 'skipped';

  const { modelVersion } = deps.client.config;
  const existing = await deps.store.get({
    eventId: item.eventId,
    sessionId: item.sessionId,
    sourceHash: item.sourceHash,
    embeddingModelVersion: modelVersion,
  });
  if (existing) return 'duplicate';

  let vector: number[];
  try {
    vector = await deps.client.embedText(item.searchableText);
  } catch (err) {
    if (isEmbeddingUnavailable(err)) {
      await deps.fallback.setLexicalOnly({
        eventId: item.eventId,
        catalogVersion: item.catalogVersion,
        embeddingModelVersion: modelVersion,
        reason: err instanceof Error ? err.name : 'EmbeddingUnavailable',
      });
    }
    throw err;
  }

  await deps.store.put({
    eventId: item.eventId,
    catalogVersion: item.catalogVersion,
    sessionId: item.sessionId,
    embeddingModelVersion: modelVersion,
    sourceHash: item.sourceHash,
    vector,
  });
  return 'embedded';
}

/**
 * SQS handler core. Every record is processed independently; failures are
 * returned as `batchItemFailures` (enable `ReportBatchItemFailures` on the
 * event source mapping) so only those messages are retried and eventually
 * redriven to the DLQ.
 */
export async function handleSqsBatch(
  batch: SqsBatchLike,
  deps: WorkerDeps,
): Promise<SqsBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  const log = deps.log ?? (() => {});

  await Promise.all(
    batch.Records.map(async (record) => {
      let item: EmbeddingWorkItem | undefined;
      try {
        item = parseWorkItem(record.body);
        const outcome = await processWorkItem(item, deps);
        log({
          messageId: record.messageId,
          outcome,
          eventId: item.eventId,
          catalogVersion: item.catalogVersion,
        });
      } catch (err) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
        log({
          messageId: record.messageId,
          outcome: 'failed',
          reason: err instanceof Error ? err.name : 'UnknownError',
          ...(item ? { eventId: item.eventId, catalogVersion: item.catalogVersion } : {}),
        });
      }
    }),
  );

  batchItemFailures.sort((a, b) => (a.itemIdentifier < b.itemIdentifier ? -1 : 1));
  return { batchItemFailures };
}
