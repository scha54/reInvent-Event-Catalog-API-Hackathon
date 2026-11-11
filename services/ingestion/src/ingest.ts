/**
 * Idempotent ingestion with quarantine (FR-01 1.3, 1.4).
 *
 * - Raw pages are written to a staging prefix (S3 in production) before processing.
 * - Each record is normalized; malformed ones are quarantined with a reason and
 *   a timestamp, and ingestion continues.
 * - Sessions are stored keyed by `(eventId, sessionId, contentHash)`, so ingesting
 *   the same content any number of times yields the same stored result.
 *
 * All storage sits behind small interfaces so it can be tested without AWS.
 */

import type { QuarantineRecord, Session } from '@serendipity/packages-contracts';
import type { RawSessionPage } from './events-api-adapter.js';
import { normalizeSession } from './normalize.js';

/* ------------------------------ storage ports ---------------------------- */

/** Raw page staging (S3 prefix in production). */
export interface RawStagingStore {
  putRawPage(key: string, body: string): Promise<void>;
}

/** Normalized session store. Writes are idempotent per `sessionKey`. */
export interface SessionStore {
  /** Returns true if the record was newly written, false if it already existed. */
  putIfAbsent(key: string, session: Session): Promise<boolean>;
}

/** Quarantine store. Writes are idempotent per `key`. */
export interface QuarantineStore {
  /** Returns true if newly written, false if it already existed. */
  putIfAbsent(key: string, record: QuarantineRecord): Promise<boolean>;
}

export interface IngestStores {
  readonly staging: RawStagingStore;
  readonly sessions: SessionStore;
  readonly quarantine: QuarantineStore;
}

/* --------------------------------- keys ---------------------------------- */

/** Idempotency key: `(eventId, sessionId, contentHash)`. */
export function sessionKey(eventId: string, sessionId: string, contentHash: string): string {
  return [eventId, sessionId, contentHash].map(encodeURIComponent).join('/');
}

export function stagingPrefix(eventId: string, executionId: string): string {
  return `staging/${encodeURIComponent(eventId)}/${encodeURIComponent(executionId)}`;
}

export function stagingKey(eventId: string, executionId: string, pageNumber: number): string {
  return `${stagingPrefix(eventId, executionId)}/page-${String(pageNumber).padStart(6, '0')}.json`;
}

/* -------------------------------- ingestion ------------------------------ */

export interface IngestContext {
  readonly eventId: string;
  readonly catalogVersion: string;
  readonly executionId: string;
  /** ISO timestamp; injected for determinism. */
  readonly ingestedAt: string;
}

export interface IngestResult {
  /** Normalized sessions for every valid input record (including already-stored ones). */
  readonly sessions: Session[];
  readonly quarantined: QuarantineRecord[];
  /** Number of sessions newly written (0 when re-ingesting identical content). */
  readonly written: number;
  /** Total input records seen: sessions.length + quarantined.length. */
  readonly inputCount: number;
}

/** Ingest one page: stage raw, normalize, quarantine bad records, store idempotently. */
export async function ingestPage(
  page: RawSessionPage,
  ctx: IngestContext,
  stores: IngestStores,
): Promise<IngestResult> {
  const key = stagingKey(ctx.eventId, ctx.executionId, page.pageNumber);
  await stores.staging.putRawPage(
    key,
    JSON.stringify({
      eventId: page.eventId,
      pageNumber: page.pageNumber,
      requestToken: page.requestToken,
      nextToken: page.nextToken,
      items: page.items,
      malformedItems: page.malformedItems.map((m) => ({ index: m.index, raw: m.raw })),
    }),
  );

  const sessions: Session[] = [];
  const quarantined: QuarantineRecord[] = [];
  let written = 0;

  const quarantineRecord = async (record: QuarantineRecord): Promise<void> => {
    quarantined.push(record);
    await stores.quarantine.putIfAbsent(`${record.rawRef}|${record.reason}`, record);
  };

  for (const m of page.malformedItems) {
    await quarantineRecord({
      rawRef: `${key}#malformed-${m.index}`,
      reason: m.reason || 'Malformed source record',
      timestamp: ctx.ingestedAt,
      eventId: ctx.eventId,
    });
  }

  for (const [index, raw] of page.items.entries()) {
    const result = normalizeSession(raw, {
      eventId: ctx.eventId,
      catalogVersion: ctx.catalogVersion,
      ingestedAt: ctx.ingestedAt,
      rawRef: `${key}#${index}`,
    });
    if (!result.ok) {
      await quarantineRecord(result.quarantine);
      continue;
    }
    const s = result.session;
    const isNew = await stores.sessions.putIfAbsent(
      sessionKey(s.eventId, s.sessionId, s.sourceHash),
      s,
    );
    if (isNew) written += 1;
    sessions.push(s);
  }

  return {
    sessions,
    quarantined,
    written,
    inputCount: page.items.length + page.malformedItems.length,
  };
}

/** Ingest every page from an async iterable (e.g. `adapter.listAllSessions`). */
export async function ingestPages(
  pages: AsyncIterable<RawSessionPage>,
  ctx: IngestContext,
  stores: IngestStores,
): Promise<IngestResult> {
  const total = { sessions: [] as Session[], quarantined: [] as QuarantineRecord[], written: 0 };
  for await (const page of pages) {
    const r = await ingestPage(page, ctx, stores);
    total.sessions.push(...r.sessions);
    total.quarantined.push(...r.quarantined);
    total.written += r.written;
  }
  return {
    ...total,
    inputCount: total.sessions.length + total.quarantined.length,
  };
}

/* ----------------------------- in-memory stores -------------------------- */

export class InMemoryStores implements IngestStores {
  readonly rawPages = new Map<string, string>();
  readonly sessionMap = new Map<string, Session>();
  readonly quarantineMap = new Map<string, QuarantineRecord>();

  readonly staging: RawStagingStore = {
    putRawPage: (key, body) => {
      this.rawPages.set(key, body);
      return Promise.resolve();
    },
  };
  readonly sessions: SessionStore = {
    putIfAbsent: (key, session) => {
      if (this.sessionMap.has(key)) return Promise.resolve(false);
      this.sessionMap.set(key, session);
      return Promise.resolve(true);
    },
  };
  readonly quarantine: QuarantineStore = {
    putIfAbsent: (key, record) => {
      if (this.quarantineMap.has(key)) return Promise.resolve(false);
      this.quarantineMap.set(key, record);
      return Promise.resolve(true);
    },
  };
}
