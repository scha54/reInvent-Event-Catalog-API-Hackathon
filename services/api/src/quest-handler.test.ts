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
  createDiscoveryService,
  createQuestRoutes,
  type ApiEvent,
  type CatalogHandlerDeps,
} from './index.js';

const MODEL = 'model-1';

function session(
  id: string,
  title: string,
  abstract: string,
  track: string,
  times?: [string, string],
): Session {
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
    officialUrl: `https://example.com/${id}`,
    ...(times ? { startsAt: times[0], endsAt: times[1] } : {}),
  };
}

const SESSIONS = [
  session(
    's1',
    'Serverless functions at scale',
    'Lambda patterns for energy efficient workloads',
    'Compute',
    ['2025-12-01T09:00:00Z', '2025-12-01T10:00:00Z'],
  ),
  session(
    's2',
    'Sustainability in the cloud',
    'Measuring energy efficient workloads and carbon',
    'Sustainability',
    ['2025-12-01T09:30:00Z', '2025-12-01T10:30:00Z'],
  ),
  session('s3', 'Storage deep dive', 'Object lifecycle and durability', 'Storage'),
];
const VECTORS: Record<string, number[]> = { s1: [1, 0], s2: [0.9, 0.1], s3: [0, 1] };

async function setup() {
  const blobs = new Map<string, string>();
  const store: IndexBlobStore = {
    get: async (k) => blobs.get(k),
    put: async (k, b) => void blobs.set(k, b),
  };
  const cache = new IndexCache();
  const index = LocalIndex.build({
    eventId: 'evt',
    catalogVersion: 'v1',
    embeddingModelVersion: MODEL,
    sessions: SESSIONS,
    embeddings: SESSIONS.map((s) => ({
      sessionId: s.sessionId,
      embeddingModelVersion: MODEL,
      vector: VECTORS[s.sessionId] as number[],
    })),
  });
  await saveIndex(store, index, cache);
  const deps: CatalogHandlerDeps = {
    state: {
      get: async (id) =>
        id === 'evt'
          ? {
              eventId: 'evt',
              activeCatalogVersion: 'v1',
              embeddingModelVersion: MODEL,
              lastSuccessfulSyncAt: '2025-01-01T12:00:00Z',
              lastSyncStatus: 'succeeded',
            }
          : undefined,
      list: async () => [],
    },
    artifacts: { getSessions: async () => SESSIONS },
    blobs: store,
    indexCache: cache,
    embedQuery: async () => [1, 0],
  };
  const discovery = createDiscoveryService(deps);
  const handler = createApiHandler(
    { allowedOrigins: [], logger: createLogger({ sink: () => undefined }) },
    [...createCatalogRoutes(deps, discovery), ...createQuestRoutes(deps, discovery)],
  );
  return async (path: string, body?: unknown) => {
    const event: ApiEvent = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      requestContext: { http: { method: 'POST' } },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await handler(event);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
  };
}

const base = { eventId: 'evt', topics: ['serverless', 'sustainability'], seed: 1 };

describe('quests', () => {
  it('returns ordered 2-4 steps linked to real sessions with conflicts and unknownSchedule', async () => {
    const call = await setup();
    const d = await call('/api/v1/discover', base);
    const bridgeId = d.json.bridges[0].id as string;
    const r = await call('/api/v1/quests', { ...base, catalogVersion: 'v1', bridgeId, steps: 3 });
    expect(r.status).toBe(200);
    const ids = new Set(SESSIONS.map((s) => s.sessionId));
    expect(r.json.steps.length).toBeGreaterThanOrEqual(2);
    expect(r.json.steps.length).toBeLessThanOrEqual(4);
    const stepIds = r.json.steps.map((s: { sessionId: string }) => s.sessionId);
    expect(new Set(stepIds).size).toBe(stepIds.length);
    for (const s of r.json.steps) {
      expect(ids.has(s.sessionId)).toBe(true);
      expect(s.reason).toBeTruthy();
    }
    expect(Array.isArray(r.json.conflicts)).toBe(true);
    expect(Array.isArray(r.json.unknownSchedule)).toBe(true);
    expect(r.json.catalogVersion).toBe('v1');
  });

  it('returns 409 on catalog version mismatch', async () => {
    const call = await setup();
    const r = await call('/api/v1/quests', { ...base, catalogVersion: 'v0', bridgeId: 'x' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('VERSION_CONFLICT');
  });

  it('validates the request and 404s unknown bridges', async () => {
    const call = await setup();
    expect((await call('/api/v1/quests', { ...base, bridgeId: 'x' })).status).toBe(400);
    expect(
      (await call('/api/v1/quests', { ...base, catalogVersion: 'v1', bridgeId: 'x', steps: 9 }))
        .status,
    ).toBe(400);
    expect(
      (await call('/api/v1/quests', { ...base, catalogVersion: 'v1', bridgeId: 'bridge:nope' }))
        .status,
    ).toBe(404);
  });
});
