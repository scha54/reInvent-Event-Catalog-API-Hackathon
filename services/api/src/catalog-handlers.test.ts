import { describe, expect, it } from 'vitest';
import { createLogger, type Session } from '@serendipity/packages-contracts';
import {
  IndexCache,
  LocalIndex,
  saveIndex,
  type IndexBlobStore,
} from '@serendipity/services-indexer';
import {
  createApiHandler,
  createCatalogRoutes,
  LAST_KNOWN_GOOD_LABEL,
  type ApiEvent,
  type CatalogState,
} from './index.js';

const ORIGIN = 'https://app.example.com';
const NOW = Date.parse('2025-01-02T00:00:00Z');
const MODEL = 'model-1';

function session(id: string, title: string, abstract: string, track: string): Session {
  return {
    eventId: 'evt',
    sessionId: id,
    catalogVersion: 'v1',
    title,
    abstract,
    track,
    topics: [],
    sourceHash: `h-${id}`,
    ingestedAt: '2025-01-01T00:00:00Z',
    searchableText: `${title}. ${abstract}`,
  };
}

const SESSIONS = [
  session(
    's1',
    'Serverless functions at scale',
    'Lambda patterns for energy efficient workloads',
    'Compute',
  ),
  session(
    's2',
    'Sustainability in the cloud',
    'Measuring energy efficient workloads and carbon',
    'Sustainability',
  ),
  session('s3', 'Storage deep dive', 'Object lifecycle and durability', 'Storage'),
  session('s4', 'Networking basics', 'Routing and subnets explained', 'Networking'),
  session('s5', 'Database internals', 'Replication and consensus protocols', 'Databases'),
  session('s6', 'Observability tooling', 'Tracing metrics and dashboards', 'Operations'),
  session('s7', 'Machine learning ops', 'Training pipelines and feature stores', 'AI'),
  session('s8', 'Frontend delivery', 'Edge caching and web performance', 'Web'),
];

async function setup(
  opts: { state?: Partial<CatalogState>; embed?: boolean; failEmbed?: boolean } = {},
) {
  const blobs = new Map<string, string>();
  const store: IndexBlobStore = {
    get: async (k) => blobs.get(k),
    put: async (k, b) => void blobs.set(k, b),
  };
  const cache = new IndexCache();
  const vectors: Record<string, number[]> = { s1: [1, 0], s2: [0.9, 0.1], s3: [0, 1] };
  for (const id of ['s4', 's5', 's6', 's7', 's8']) vectors[id] = [0, 1];
  const index = LocalIndex.build({
    eventId: 'evt',
    catalogVersion: 'v1',
    embeddingModelVersion: MODEL,
    sessions: SESSIONS,
    embeddings:
      opts.embed === false
        ? []
        : SESSIONS.map((s) => ({
            sessionId: s.sessionId,
            embeddingModelVersion: MODEL,
            vector: vectors[s.sessionId] as number[],
          })),
  });
  await saveIndex(store, index, cache);

  const state: CatalogState = {
    eventId: 'evt',
    name: 'Event',
    activeCatalogVersion: 'v1',
    embeddingModelVersion: MODEL,
    sessionCount: 8,
    lastSuccessfulSyncAt: '2025-01-01T12:00:00Z',
    lastSyncStatus: 'succeeded',
    ...opts.state,
  };
  const lines: string[] = [];
  const routes = createCatalogRoutes({
    state: {
      get: async (id) => (id === state.eventId ? state : undefined),
      list: async () => [state, { eventId: 'unpublished' }],
    },
    artifacts: { getSessions: async () => SESSIONS },
    blobs: store,
    indexCache: cache,
    now: () => NOW,
    embedQuery: opts.failEmbed
      ? async () => {
          throw new Error('bedrock down');
        }
      : async () => [1, 0],
  });
  const handler = createApiHandler(
    { allowedOrigins: [ORIGIN], logger: createLogger({ sink: (l) => lines.push(l) }) },
    routes,
  );
  const call = async (method: string, path: string, body?: unknown) => {
    const event: ApiEvent = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      requestContext: { http: { method } },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await handler(event);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
  };
  return { call };
}

describe('events and status', () => {
  it('lists only published events with freshness', async () => {
    const { call } = await setup();
    const r = await call('GET', '/api/v1/events');
    expect(r.status).toBe(200);
    expect(r.json.events).toHaveLength(1);
    expect(r.json.events[0]).toMatchObject({
      eventId: 'evt',
      catalogVersion: 'v1',
      sessionCount: 8,
      lexicalOnly: false,
      freshness: { stale: false, lastKnownGood: false, ageSeconds: 12 * 3600 },
    });
  });

  it('labels last-known-good and stale catalogs', async () => {
    const { call } = await setup({
      state: { lastSyncStatus: 'failed', lastSuccessfulSyncAt: '2024-12-01T00:00:00Z' },
    });
    const r = await call('GET', '/api/v1/events/evt/status');
    expect(r.status).toBe(200);
    expect(r.json.freshness).toMatchObject({
      stale: true,
      lastKnownGood: true,
      lastKnownGoodLabel: LAST_KNOWN_GOOD_LABEL,
    });
  });

  it('returns 404 for unknown events', async () => {
    const { call } = await setup();
    expect((await call('GET', '/api/v1/events/nope/status')).status).toBe(404);
  });
});

describe('discover', () => {
  const body = { eventId: 'evt', topics: ['serverless', 'sustainability'], seed: 1 };

  it('returns bridges built from indexed sessions with version and freshness', async () => {
    const { call } = await setup();
    const r = await call('POST', '/api/v1/discover', body);
    expect(r.status).toBe(200);
    expect(r.json.catalogVersion).toBe('v1');
    expect(r.json.noMatch).toBe(false);
    expect(r.json.bridges[0].sessionIds.sort()).toEqual(['s1', 's2']);
    expect(r.json.freshness.lastKnownGood).toBe(false);
    expect(r.json.graph.nodes.length).toBeLessThanOrEqual(40);
    expect(r.json.degraded).toBe(false);
  });

  it('degrades to lexical-only when query embedding fails', async () => {
    const { call } = await setup({ failEmbed: true });
    const r = await call('POST', '/api/v1/discover', body);
    expect(r.status).toBe(200);
    expect(r.json.degraded).toBe(true);
    expect(r.json.noMatch).toBe(false);
  });

  it('degrades to lexical-only when the index has no vectors', async () => {
    const { call } = await setup({ embed: false });
    const r = await call('POST', '/api/v1/discover', body);
    expect(r.status).toBe(200);
    expect(r.json.degraded).toBe(true);
  });

  it('returns noMatch for unconnected topics', async () => {
    const { call } = await setup({ embed: false });
    const r = await call('POST', '/api/v1/discover', {
      eventId: 'evt',
      topics: ['quantum', 'knitting'],
    });
    expect(r.status).toBe(200);
    expect(r.json.noMatch).toBe(true);
    expect(r.json.bridges).toEqual([]);
  });

  it('rejects invalid input and unsafe topics with 400', async () => {
    const { call } = await setup();
    expect((await call('POST', '/api/v1/discover', { eventId: 'evt', topics: [] })).status).toBe(
      400,
    );
    const unsafe = await call('POST', '/api/v1/discover', {
      eventId: 'evt',
      topics: ['<script>x</script>'],
    });
    expect(unsafe.status).toBe(400);
    expect(unsafe.json.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for unknown event and 503 when nothing is published', async () => {
    const { call } = await setup();
    expect((await call('POST', '/api/v1/discover', { ...body, eventId: 'nope' })).status).toBe(404);
    const unpublished = await setup({ state: { activeCatalogVersion: undefined } });
    expect((await unpublished.call('POST', '/api/v1/discover', body)).status).toBe(503);
  });
});
