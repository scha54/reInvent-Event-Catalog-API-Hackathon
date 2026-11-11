/**
 * Step Functions task handlers for the catalog sync workflow
 * (FR-01 1.1, FR-02 2.4, NFR-02 14.1/14.2, NFR-05 17.2).
 *
 * Workflow: startSync -> fetchAndStage -> normalizeStaged -> diffAndEnqueue
 *           -> (indexer) buildIndex -> runChecks -> publish.
 *
 * Invariants:
 * - Every step takes the previous step's small JSON state and returns an extended
 *   copy; bulk data (raw pages, sessions, manifests) lives behind ports (S3).
 * - Only `publish` can change the active catalog version, and only through
 *   {@link publishSnapshot}'s conditional write. Any earlier failure therefore
 *   leaves the active catalog (Last_Known_Good_Snapshot) untouched.
 * - Every step runs through {@link runStep}, which logs, emits
 *   `CatalogSyncFailures` on failure and rethrows so Step Functions can Catch.
 * - All AWS access is injected so handlers are unit-testable.
 */
import type {
  Logger,
  QuarantineRecord,
  Session,
  SnapshotManifest,
} from '@serendipity/packages-contracts';
import type { EventsApiAdapter } from './events-api-adapter.js';
import {
  stagingKey,
  stagingPrefix,
  type RawStagingStore,
  type SessionStore,
  type QuarantineStore,
  sessionKey,
} from './ingest.js';
import { normalizeSession } from './normalize.js';
import {
  checkCompleteness,
  checkReferentialIntegrity,
  publishSnapshot,
  type ActiveVersionStore,
  type CheckIssue,
  type RetrievalCheck,
  type SnapshotCandidate,
} from './publish.js';
import { buildManifest, diffSnapshots } from './snapshot.js';

/* ------------------------------- metrics -------------------------------- */

export const METRIC_SYNC_FAILURES = 'CatalogSyncFailures';
export const METRIC_SYNC_AGE = 'CatalogSyncAge';
export const METRIC_INVALID_SESSIONS = 'InvalidSessionCount';

export interface MetricDatum {
  readonly name: string;
  readonly value: number;
  readonly unit?: 'Count' | 'Seconds' | 'None';
  readonly dimensions?: Readonly<Record<string, string>>;
}

export interface MetricsSink {
  put(metric: MetricDatum): void | Promise<void>;
}

/** CloudWatch Embedded Metric Format sink written through the structured logger. */
export function createEmfMetricsSink(logger: Logger, namespace = 'SerendipityEngine'): MetricsSink {
  return {
    put(m) {
      const dims = m.dimensions ?? {};
      logger.info('metric', {
        operation: 'metric',
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: namespace,
              Dimensions: [Object.keys(dims)],
              Metrics: [{ Name: m.name, Unit: m.unit ?? 'Count' }],
            },
          ],
        },
        ...dims,
        [m.name]: m.value,
      });
    },
  };
}

/* -------------------------------- ports --------------------------------- */

/** Reads the active catalog pointer (DynamoDB in production). */
export interface CatalogRegistry {
  getActiveVersion(eventId: string): Promise<string | undefined>;
}

/** Raw page staging with read access (S3 prefix in production). */
export interface StagedPageStore extends RawStagingStore {
  listPageKeys(prefix: string): Promise<string[]>;
  getRawPage(key: string): Promise<string | undefined>;
}

/** Per-version artifacts: normalized sessions and manifests (S3 in production). */
export interface SnapshotArtifactStore {
  putSessions(eventId: string, catalogVersion: string, sessions: readonly Session[]): Promise<void>;
  getSessions(eventId: string, catalogVersion: string): Promise<Session[] | undefined>;
  putManifest(manifest: SnapshotManifest): Promise<void>;
  getManifest(eventId: string, catalogVersion: string): Promise<SnapshotManifest | undefined>;
}

/** Message body shape consumed by the indexer's SQS worker. */
export interface SyncWorkItem {
  readonly eventId: string;
  readonly catalogVersion: string;
  readonly sessionId: string;
  readonly sourceHash: string;
  readonly searchableText: string;
}

export interface WorkQueue {
  sendBatch(items: readonly SyncWorkItem[]): Promise<void>;
}

export interface SyncDeps {
  readonly adapter: EventsApiAdapter;
  readonly staging: StagedPageStore;
  readonly sessions: SessionStore;
  readonly quarantine: QuarantineStore;
  readonly artifacts: SnapshotArtifactStore;
  readonly registry: CatalogRegistry;
  readonly queue: WorkQueue;
  readonly activeVersionStore: ActiveVersionStore;
  readonly retrievalCheck: RetrievalCheck;
  readonly metrics: MetricsSink;
  readonly logger: Logger;
  /** Injected clock. */
  readonly now?: () => Date;
  readonly maxPages?: number;
}

/* -------------------------------- state --------------------------------- */

export interface StartSyncInput {
  readonly eventId: string;
  readonly executionId: string;
}

export interface SyncStarted extends StartSyncInput {
  readonly catalogVersion: string;
  /** Active version observed at start (`undefined` on first sync); used for the CAS at publish. */
  readonly expectedActiveVersion?: string;
  readonly startedAt: string;
}

export interface SyncFetched extends SyncStarted {
  readonly pageCount: number;
  readonly sourceTotalCount?: number;
  readonly allPagesFetched: true;
}

export interface SyncNormalized extends SyncFetched {
  readonly sessionCount: number;
  readonly quarantinedCount: number;
}

export interface SyncDiffed extends SyncNormalized {
  readonly addedCount: number;
  readonly modifiedCount: number;
  readonly unchangedCount: number;
  readonly tombstonedCount: number;
  readonly enqueuedCount: number;
}

export interface SyncIndexed extends SyncDiffed {
  readonly embeddingModelVersion: string;
  readonly indexedSessionIds: string[];
  readonly lexicalOnly: boolean;
}

export type SyncChecked = SyncIndexed;

export interface SyncPublished extends SyncChecked {
  readonly activeCatalogVersion: string;
  readonly previousCatalogVersion?: string;
}

export class SyncStepError extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly issues: readonly CheckIssue[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SyncStepError';
  }
}

/* ------------------------------ step runner ----------------------------- */

type MetricsDeps = Pick<SyncDeps, 'metrics' | 'logger' | 'now'>;

export interface StepContext {
  readonly eventId?: string | undefined;
  readonly catalogVersion?: string | undefined;
  readonly executionId?: string | undefined;
}

/** Emit the failure metric + log. Never throws (metrics must not mask the real error). */
export async function recordSyncFailure(
  deps: MetricsDeps,
  step: string,
  err: unknown,
  ctx: StepContext = {},
): Promise<void> {
  try {
    deps.logger.error('sync step failed; active catalog unchanged', {
      operation: `sync.${step}`,
      eventId: ctx.eventId,
      catalogVersion: ctx.catalogVersion,
      executionId: ctx.executionId,
      status: 'failed',
      error: err instanceof Error ? { name: err.name, message: err.message } : 'unknown',
    });
    await deps.metrics.put({
      name: METRIC_SYNC_FAILURES,
      value: 1,
      dimensions: { Step: step },
    });
  } catch {
    /* swallow: observability must never replace the original error */
  }
}

/** Run one step with timing, logging and failure metrics. */
export async function runStep<I extends StepContext, O>(
  deps: MetricsDeps,
  step: string,
  input: I,
  fn: (input: I) => Promise<O>,
): Promise<O> {
  const started = (deps.now ?? (() => new Date()))().getTime();
  try {
    const out = await fn(input);
    deps.logger.info('sync step completed', {
      operation: `sync.${step}`,
      eventId: input.eventId,
      catalogVersion: input.catalogVersion,
      status: 'ok',
      latencyMs: (deps.now ?? (() => new Date()))().getTime() - started,
    });
    return out;
  } catch (err) {
    await recordSyncFailure(deps, step, err, input);
    throw err;
  }
}

/* -------------------------------- steps --------------------------------- */

function nowIso(deps: Pick<SyncDeps, 'now'>): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

/** 1. Start sync: allocate the candidate catalogVersion and observe the active version. */
export function startSync(input: StartSyncInput, deps: SyncDeps): Promise<SyncStarted> {
  return runStep(deps, 'startSync', input, async (i) => {
    if (!i.eventId || !i.executionId) {
      throw new SyncStepError('startSync', 'eventId and executionId are required');
    }
    const startedAt = nowIso(deps);
    const active = await deps.registry.getActiveVersion(i.eventId);
    // Sync age of the catalog currently being served.
    if (active !== undefined) {
      const manifest = await deps.artifacts.getManifest(i.eventId, active);
      if (manifest) {
        const ageSec = Math.max(0, (Date.parse(startedAt) - Date.parse(manifest.createdAt)) / 1000);
        await deps.metrics.put({ name: METRIC_SYNC_AGE, value: ageSec, unit: 'Seconds' });
      }
    }
    const catalogVersion = `${startedAt.replace(/[-:.]/g, '')}-${i.executionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`;
    return {
      eventId: i.eventId,
      executionId: i.executionId,
      catalogVersion,
      ...(active !== undefined ? { expectedActiveVersion: active } : {}),
      startedAt,
    };
  });
}

/** 2. Fetch every page from the Events API and stage it raw. Incomplete walks throw. */
export function fetchAndStage(state: SyncStarted, deps: SyncDeps): Promise<SyncFetched> {
  return runStep(deps, 'fetchAndStage', state, async (s) => {
    let pageCount = 0;
    let sourceTotalCount: number | undefined;
    const pages = deps.adapter.listAllSessions(
      s.eventId,
      deps.maxPages !== undefined ? { maxPages: deps.maxPages } : {},
    );
    for await (const page of pages) {
      await deps.staging.putRawPage(
        stagingKey(s.eventId, s.executionId, page.pageNumber),
        JSON.stringify({
          eventId: page.eventId,
          pageNumber: page.pageNumber,
          requestToken: page.requestToken,
          nextToken: page.nextToken,
          items: page.items,
          malformedItems: page.malformedItems.map((m) => ({
            index: m.index,
            raw: m.raw,
            reason: m.reason,
          })),
        }),
      );
      pageCount += 1;
      if (page.totalCount !== undefined) sourceTotalCount = page.totalCount;
    }
    if (pageCount === 0) throw new SyncStepError('fetchAndStage', 'Events API returned no pages');
    // Reaching here means the iterator finished (nextToken absent): the walk is complete.
    return {
      ...s,
      pageCount,
      ...(sourceTotalCount !== undefined ? { sourceTotalCount } : {}),
      allPagesFetched: true as const,
    };
  });
}

interface StagedPageBody {
  items?: unknown[];
  malformedItems?: { index: number; reason?: string }[];
}

/** 3. Normalize staged pages, quarantining malformed records, and persist the session set. */
export function normalizeStaged(state: SyncFetched, deps: SyncDeps): Promise<SyncNormalized> {
  return runStep(deps, 'normalizeStaged', state, async (s) => {
    const prefix = stagingPrefix(s.eventId, s.executionId);
    const keys = (await deps.staging.listPageKeys(prefix)).sort();
    if (keys.length !== s.pageCount) {
      throw new SyncStepError(
        'normalizeStaged',
        `Expected ${s.pageCount} staged pages but found ${keys.length}`,
      );
    }
    const ingestedAt = nowIso(deps);
    const sessions = new Map<string, Session>();
    let quarantinedCount = 0;

    const quarantine = async (record: QuarantineRecord): Promise<void> => {
      quarantinedCount += 1;
      await deps.quarantine.putIfAbsent(`${record.rawRef}|${record.reason}`, record);
    };

    for (const key of keys) {
      const body = await deps.staging.getRawPage(key);
      if (body === undefined)
        throw new SyncStepError('normalizeStaged', `Staged page missing: ${key}`);
      const page = JSON.parse(body) as StagedPageBody;
      for (const m of page.malformedItems ?? []) {
        await quarantine({
          rawRef: `${key}#malformed-${m.index}`,
          reason: m.reason || 'Malformed source record',
          timestamp: ingestedAt,
          eventId: s.eventId,
        });
      }
      for (const [index, raw] of (page.items ?? []).entries()) {
        const r = normalizeSession(raw, {
          eventId: s.eventId,
          catalogVersion: s.catalogVersion,
          ingestedAt,
          rawRef: `${key}#${index}`,
        });
        if (!r.ok) {
          await quarantine(r.quarantine);
          continue;
        }
        await deps.sessions.putIfAbsent(
          sessionKey(r.session.eventId, r.session.sessionId, r.session.sourceHash),
          r.session,
        );
        sessions.set(r.session.sessionId, r.session);
      }
    }

    // Surface invalid-record volume (even when 0, so alarms see a datapoint).
    await deps.metrics.put({ name: METRIC_INVALID_SESSIONS, value: quarantinedCount });

    const list = [...sessions.values()];
    if (list.length === 0) {
      throw new SyncStepError('normalizeStaged', 'No valid sessions after normalization');
    }
    await deps.artifacts.putSessions(s.eventId, s.catalogVersion, list);
    return { ...s, sessionCount: list.length, quarantinedCount };
  });
}

const SEND_BATCH = 10; // SQS SendMessageBatch limit

/** 4. Build the candidate manifest, diff against the active snapshot and enqueue changed sessions. */
export function diffAndEnqueue(state: SyncNormalized, deps: SyncDeps): Promise<SyncDiffed> {
  return runStep(deps, 'diffAndEnqueue', state, async (s) => {
    const sessions = await deps.artifacts.getSessions(s.eventId, s.catalogVersion);
    if (!sessions) throw new SyncStepError('diffAndEnqueue', 'Normalized sessions not found');

    const previous =
      s.expectedActiveVersion !== undefined
        ? await deps.artifacts.getManifest(s.eventId, s.expectedActiveVersion)
        : undefined;
    const diff = diffSnapshots(previous, sessions);

    // Candidate manifest is immutable and inert until the publish gate flips the pointer.
    await deps.artifacts.putManifest(
      buildManifest(sessions, {
        eventId: s.eventId,
        catalogVersion: s.catalogVersion,
        createdAt: nowIso(deps),
      }) as SnapshotManifest,
    );

    const items: SyncWorkItem[] = diff.changed.map((x) => ({
      eventId: x.eventId,
      catalogVersion: x.catalogVersion,
      sessionId: x.sessionId,
      sourceHash: x.sourceHash,
      searchableText: x.searchableText,
    }));
    for (let i = 0; i < items.length; i += SEND_BATCH) {
      await deps.queue.sendBatch(items.slice(i, i + SEND_BATCH));
    }
    return {
      ...s,
      addedCount: diff.added.length,
      modifiedCount: diff.modified.length,
      unchangedCount: diff.unchanged.length,
      tombstonedCount: diff.tombstoned.length,
      enqueuedCount: items.length,
    };
  });
}

/** Build the publish candidate for a state that has been indexed. */
async function loadCandidate(state: SyncIndexed, deps: SyncDeps): Promise<SnapshotCandidate> {
  const [sessions, manifest] = await Promise.all([
    deps.artifacts.getSessions(state.eventId, state.catalogVersion),
    deps.artifacts.getManifest(state.eventId, state.catalogVersion),
  ]);
  if (!sessions || !manifest) {
    throw new SyncStepError('runChecks', 'Candidate sessions or manifest not found');
  }
  return {
    manifest,
    sessions,
    indexedSessionIds: state.indexedSessionIds,
    allPagesFetched: state.allPagesFetched,
    // Valid + quarantined should equal what the source reported.
    ...(state.sourceTotalCount !== undefined
      ? { expectedRecordCount: state.sourceTotalCount - state.quarantinedCount }
      : {}),
  };
}

/** 6. Run completeness, integrity and sample-retrieval checks. Throws (step fails) on any issue. */
export function runChecks(state: SyncIndexed, deps: SyncDeps): Promise<SyncChecked> {
  return runStep(deps, 'runChecks', state, async (s) => {
    const candidate = await loadCandidate(s, deps);
    const issues: CheckIssue[] = [
      ...checkCompleteness(candidate).issues,
      ...checkReferentialIntegrity(candidate).issues,
    ];
    if (issues.length === 0) {
      const r = await deps.retrievalCheck(candidate);
      const ok = typeof r === 'boolean' ? r : r.ok;
      if (!ok) {
        issues.push({
          check: 'retrieval',
          message:
            typeof r === 'boolean'
              ? 'Sample retrieval check failed'
              : (r.message ?? 'Sample retrieval check failed'),
        });
      }
    }
    if (issues.length > 0) {
      throw new SyncStepError(
        'runChecks',
        `Snapshot checks failed (${issues.length} issues)`,
        issues,
      );
    }
    return s;
  });
}

/** 7. Publish via the atomic gate. A refused publish throws; the active version stays as is. */
export function publish(state: SyncChecked, deps: SyncDeps): Promise<SyncPublished> {
  return runStep(deps, 'publish', state, async (s) => {
    const candidate = await loadCandidate(s, deps);
    const result = await publishSnapshot({
      candidate,
      expectedActiveVersion: s.expectedActiveVersion,
      store: deps.activeVersionStore,
      retrievalCheck: deps.retrievalCheck,
    });
    if (!result.published) {
      throw new SyncStepError(
        'publish',
        `Publish refused (${result.code}, ${result.status}); active catalog unchanged`,
        result.issues,
      );
    }
    await deps.metrics.put({
      name: METRIC_SYNC_FAILURES,
      value: 0,
      dimensions: { Step: 'publish' },
    });
    await deps.metrics.put({ name: METRIC_SYNC_AGE, value: 0, unit: 'Seconds' });
    return {
      ...s,
      activeCatalogVersion: result.activeCatalogVersion,
      ...(result.previousCatalogVersion !== undefined
        ? { previousCatalogVersion: result.previousCatalogVersion }
        : {}),
    };
  });
}
