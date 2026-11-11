/**
 * Events, status, and discover handlers.
 *
 * - `GET  /api/v1/events`                    list indexed events with freshness
 * - `GET  /api/v1/events/{eventId}/status`   active catalog version and sync state
 * - `POST /api/v1/discover`                  hybrid retrieval, bridge scoring, graph
 *
 * Every response carries the catalog version and a freshness block. When the
 * latest sync failed, the freshness block labels the data as the last known good
 * snapshot. If the vector index or query embeddings are unavailable, discovery
 * falls back to lexical-only retrieval and reports `degraded: true`.
 *
 * Requirements: FR-01 (1.7), FR-03 (3.1), FR-04 (4.3), FR-10 (10.3),
 * NFR-02 (14.3), NFR-03 (15.2).
 */
import {
  DiscoverRequestSchema,
  type CatalogFreshness,
  type CatalogStatus,
  type DiscoverResponse,
  type EventsListResponse,
  type Session,
} from '@serendipity/packages-contracts';
import {
  buildGraph,
  retrieveForTopics,
  scoreBridges,
  validateTopics,
} from '@serendipity/packages-discovery';
import {
  IndexFormatError,
  loadIndex,
  type IndexBlobStore,
  type IndexCache,
  type LocalIndex,
} from '@serendipity/services-indexer';
import type { SnapshotArtifactStore } from '@serendipity/services-ingestion';
import { notFound, serviceUnavailable, validationError, versionConflict } from './errors.js';
import { defineRoute, type HandlerContext, type RouteDefinition } from './framework.js';

/* ------------------------------------------------------------------ */
/* Ports                                                               */
/* ------------------------------------------------------------------ */

/** Catalog state for one event, as recorded by the sync workflow. */
export interface CatalogState {
  readonly eventId: string;
  readonly name?: string | undefined;
  /** Undefined until a first snapshot has been published. */
  readonly activeCatalogVersion?: string | undefined;
  readonly embeddingModelVersion?: string | undefined;
  readonly sessionCount?: number | undefined;
  /** ISO timestamp of the last successful publish. */
  readonly lastSuccessfulSyncAt?: string | undefined;
  readonly lastSyncStatus?: 'succeeded' | 'failed' | 'running' | undefined;
  /** Set by the index worker when embeddings are unavailable for the active version. */
  readonly lexicalOnly?: boolean | undefined;
}

/** Read access to catalog state (DynamoDB in production). */
export interface CatalogStateStore {
  get(eventId: string): Promise<CatalogState | undefined>;
  list(): Promise<readonly CatalogState[]>;
}

/** Embeds a topic query; rejecting means vectors are unavailable for this request. */
export type QueryEmbedder = (text: string) => Promise<ArrayLike<number>>;

export interface CatalogHandlerDeps {
  readonly state: CatalogStateStore;
  readonly artifacts: Pick<SnapshotArtifactStore, 'getSessions'>;
  readonly blobs: IndexBlobStore;
  readonly indexCache?: IndexCache;
  /** Omit to serve lexical-only. */
  readonly embedQuery?: QueryEmbedder;
  readonly now?: () => number;
  /** Catalog older than this is flagged stale. Default 26 hours. */
  readonly staleAfterSeconds?: number;
}

export const DEFAULT_STALE_AFTER_SECONDS = 26 * 60 * 60;
export const LAST_KNOWN_GOOD_LABEL =
  'Showing the last known good catalog snapshot. The most recent sync did not complete.';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function computeFreshness(
  state: CatalogState,
  nowMs: number,
  staleAfterSeconds: number,
): CatalogFreshness {
  const syncedMs = state.lastSuccessfulSyncAt ? Date.parse(state.lastSuccessfulSyncAt) : NaN;
  const hasSync = Number.isFinite(syncedMs);
  const ageSeconds = hasSync ? Math.max(0, Math.floor((nowMs - syncedMs) / 1000)) : undefined;
  const lastKnownGood = state.lastSyncStatus === 'failed';
  return {
    ...(hasSync && state.lastSuccessfulSyncAt
      ? { lastSuccessfulSyncAt: state.lastSuccessfulSyncAt }
      : {}),
    ...(ageSeconds !== undefined ? { ageSeconds } : {}),
    stale: ageSeconds === undefined || ageSeconds > staleAfterSeconds,
    lastKnownGood,
    ...(lastKnownGood ? { lastKnownGoodLabel: LAST_KNOWN_GOOD_LABEL } : {}),
  };
}

function toStatus(
  state: CatalogState,
  nowMs: number,
  staleAfter: number,
): CatalogStatus | undefined {
  if (!state.activeCatalogVersion) return undefined;
  return {
    eventId: state.eventId,
    ...(state.name !== undefined ? { name: state.name } : {}),
    catalogVersion: state.activeCatalogVersion,
    ...(state.sessionCount !== undefined ? { sessionCount: state.sessionCount } : {}),
    ...(state.lastSyncStatus !== undefined ? { lastSyncStatus: state.lastSyncStatus } : {}),
    lexicalOnly: state.lexicalOnly === true,
    freshness: computeFreshness(state, nowMs, staleAfter),
  };
}

const MAX_SESSION_CACHE = 2;

/* ------------------------------------------------------------------ */
/* Shared discovery pipeline                                           */
/* ------------------------------------------------------------------ */

export interface DiscoveryRun {
  readonly state: CatalogState;
  readonly version: string;
  readonly topics: readonly string[];
  readonly sessions: ReadonlyMap<string, Session>;
  readonly scored: ReturnType<typeof scoreBridges>;
  readonly graph: ReturnType<typeof buildGraph>;
}

export interface DiscoveryInput {
  readonly eventId: string;
  readonly topics: readonly string[];
  readonly novelty?: number | undefined;
  readonly limit?: number | undefined;
  readonly seed?: number | undefined;
  /** When set, a different active catalog version fails with 409. */
  readonly expectedCatalogVersion?: string | undefined;
}

export interface DiscoveryService {
  run(
    ctx: Pick<HandlerContext, 'annotate' | 'logger'>,
    input: DiscoveryInput,
  ): Promise<DiscoveryRun>;
}

/** Loads the active index and sessions and runs retrieval, scoring and graph building. */
export function createDiscoveryService(deps: CatalogHandlerDeps): DiscoveryService {
  const sessionCache = new Map<string, Promise<Map<string, Session>>>();

  const loadSessions = (eventId: string, version: string): Promise<Map<string, Session>> => {
    const key = `${eventId}@${version}`;
    const hit = sessionCache.get(key);
    if (hit) return hit;
    const p = deps.artifacts.getSessions(eventId, version).then((list) => {
      if (!list || list.length === 0) throw serviceUnavailable('Catalog data is unavailable');
      return new Map(list.map((s) => [s.sessionId, s]));
    });
    sessionCache.set(key, p);
    p.catch(() => sessionCache.delete(key));
    while (sessionCache.size > MAX_SESSION_CACHE) {
      sessionCache.delete(sessionCache.keys().next().value as string);
    }
    return p;
  };

  const run: DiscoveryService['run'] = async (ctx, req) => {
    const validated = validateTopics(req.topics);
    if (!validated.ok) throw validationError(validated.error.message);
    const topics = validated.topics;

    const state = await deps.state.get(req.eventId);
    if (!state) throw notFound('Event not found');
    const version = state.activeCatalogVersion;
    if (!version || !state.embeddingModelVersion) {
      throw serviceUnavailable('No catalog is available for this event yet');
    }
    if (req.expectedCatalogVersion !== undefined && req.expectedCatalogVersion !== version) {
      throw versionConflict('Catalog version has changed; refresh and try again');
    }
    ctx.annotate({ eventId: req.eventId, catalogVersion: version });

    let index: LocalIndex | undefined;
    try {
      index = await loadIndex(
        deps.blobs,
        {
          eventId: req.eventId,
          catalogVersion: version,
          embeddingModelVersion: state.embeddingModelVersion,
        },
        deps.indexCache,
      );
    } catch (err) {
      if (!(err instanceof IndexFormatError)) throw err;
      ctx.logger.error('index unreadable', { error: err });
    }
    if (!index) throw serviceUnavailable('Search index is unavailable');

    const sessions = await loadSessions(req.eventId, version);

    // Vector path only when vectors exist, are not flagged unavailable, and the
    // query embeds; any failure degrades to lexical-only for this request.
    const wantVectors = state.lexicalOnly !== true && index.hasVectors && !!deps.embedQuery;
    const embedded = await Promise.all(
      topics.map(async (topic) => {
        if (!wantVectors || !deps.embedQuery) return undefined;
        try {
          return await deps.embedQuery(topic);
        } catch (err) {
          ctx.logger.warn('query embedding failed; using lexical-only', { error: err });
          return undefined;
        }
      }),
    );
    const allEmbedded = embedded.every((e) => e !== undefined);
    const retrievals = retrieveForTopics(
      index,
      topics.map((topic, i) => ({
        topic,
        queryEmbedding: allEmbedded ? embedded[i] : undefined,
      })),
    );

    const scored = scoreBridges({
      catalogVersion: version,
      retrievals,
      sessions,
      novelty: req.novelty,
      limit: req.limit,
      seed: req.seed,
    });

    const graph = buildGraph({
      catalogVersion: version,
      topics,
      bridges: scored.bridges,
      sessions,
      retrievals,
    });

    return { state, version, topics, sessions, scored, graph };
  };

  return { run };
}
/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function createCatalogRoutes(
  deps: CatalogHandlerDeps,
  discovery: DiscoveryService = createDiscoveryService(deps),
): RouteDefinition[] {
  const now = deps.now ?? Date.now;
  const staleAfter = deps.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
  const runDiscovery = discovery.run;
  const events = defineRoute({
    method: 'GET',
    path: '/api/v1/events',
    handler: async (): Promise<{ body: EventsListResponse }> => {
      const nowMs = now();
      const states = await deps.state.list();
      const list = states
        .map((s) => toStatus(s, nowMs, staleAfter))
        .filter((s): s is CatalogStatus => s !== undefined)
        .sort((a, b) => a.eventId.localeCompare(b.eventId));
      return { body: { events: list } };
    },
  });

  const status = defineRoute({
    method: 'GET',
    path: '/api/v1/events/{eventId}/status',
    handler: async (ctx): Promise<{ body: CatalogStatus }> => {
      const eventId = ctx.pathParams['eventId'] as string;
      const state = await deps.state.get(eventId);
      const result = state ? toStatus(state, now(), staleAfter) : undefined;
      if (!result) throw notFound('Event not found');
      ctx.annotate({ eventId, catalogVersion: result.catalogVersion });
      return { body: result };
    },
  });

  const discover = defineRoute({
    method: 'POST',
    path: '/api/v1/discover',
    bodySchema: DiscoverRequestSchema,
    handler: async (ctx): Promise<{ body: DiscoverResponse }> => {
      const req = ctx.body as ReturnType<typeof DiscoverRequestSchema.parse>;
      const run = await runDiscovery(ctx, req);
      const { scored, graph } = run;
      return {
        body: {
          catalogVersion: run.version,
          bridges: scored.bridges,
          noMatch: scored.noMatch,
          graph,
          degraded: scored.degraded,
          freshness: computeFreshness(run.state, now(), staleAfter),
          algorithmVersion: scored.algorithmVersion,
        },
      };
    },
  });
  return [events, status, discover];
}
