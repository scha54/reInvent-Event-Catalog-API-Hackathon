import { describe, expect, it } from 'vitest';
import { createLogger, type Session } from '@serendipity/packages-contracts';
import { ExplanationOrchestrator, type TextGenerator } from '@serendipity/packages-discovery';
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
  createExplainRoutes,
  type ApiEvent,
  type CatalogHandlerDeps,
} from './index.js';

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
];

const GROUNDED = JSON.stringify({
  status: 'supported',
  headline: 'Efficient workloads',
  connection: 'A possible connection is energy efficient workloads.',
  observedEvidence: [
    { sessionId: 's1', field: 'title', excerpt: 'Serverless functions at scale' },
    { sessionId: 's2', field: 'title', excerpt: 'Sustainability in the cloud' },
  ],
  inference: 'Both discuss energy efficiency.',
  uncertainty: 'Thematic inference only.',
});

const VECTORS: Record<string, number[]> = { s1: [1, 0], s2: [0.9, 0.1], s3: [0, 1] };

async function setup(opts: { modelText?: string; modelFails?: boolean } = {}) {
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

  const catalogDeps: CatalogHandlerDeps = {
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
  let modelCalls = 0;
  const generator: TextGenerator = {
    config: { modelId: 'm1' },
    generate: async (prompt) => {
      modelCalls++;
      if (opts.modelFails) throw new Error('down');
      return {
        text: opts.modelText ?? GROUNDED,
        modelId: 'm1',
        promptVersion: prompt.promptVersion,
      };
    },
  };
  const orchestrator = new ExplanationOrchestrator({ generator });
  const discovery = createDiscoveryService(catalogDeps);
  const handler = createApiHandler(
    { allowedOrigins: [], logger: createLogger({ sink: () => undefined }) },
    [
      ...createCatalogRoutes(catalogDeps, discovery),
      ...createExplainRoutes({ orchestrator }, catalogDeps, discovery),
    ],
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
  return { call, modelCalls: () => modelCalls };
}

const discoverBody = { eventId: 'evt', topics: ['serverless', 'sustainability'], seed: 1 };
const explainBody = { ...discoverBody, catalogVersion: 'v1' };

async function firstBridgeId(call: Awaited<ReturnType<typeof setup>>['call']): Promise<string> {
  const r = await call('POST', '/api/v1/discover', discoverBody);
  return r.json.bridges[0].id as string;
}

describe('explain', () => {
  it('returns a grounded explanation for a discovered bridge', async () => {
    const { call } = await setup();
    const id = await firstBridgeId(call);
    const r = await call('POST', `/api/v1/bridges/${encodeURIComponent(id)}/explain`, explainBody);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ catalogVersion: 'v1', bridgeId: id, source: 'model' });
    expect(r.json.explanation.status).toBe('supported');
  });

  it('falls back to a deterministic explanation when the model fails', async () => {
    const { call } = await setup({ modelFails: true });
    const id = await firstBridgeId(call);
    const r = await call('POST', `/api/v1/bridges/${encodeURIComponent(id)}/explain`, explainBody);
    expect(r.status).toBe(200);
    expect(r.json.source).toBe('fallback');
    expect(r.json.fallbackReason).toBeDefined();
  });

  it('serves a repeat request from cache', async () => {
    const { call, modelCalls } = await setup();
    const id = await firstBridgeId(call);
    const path = `/api/v1/bridges/${encodeURIComponent(id)}/explain`;
    await call('POST', path, explainBody);
    const second = await call('POST', path, explainBody);
    expect(second.json.source).toBe('cache');
    expect(modelCalls()).toBe(1);
  });

  it('returns 409 when the catalog version does not match the active version', async () => {
    const { call, modelCalls } = await setup();
    const id = await firstBridgeId(call);
    const r = await call('POST', `/api/v1/bridges/${encodeURIComponent(id)}/explain`, {
      ...explainBody,
      catalogVersion: 'v0',
    });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('VERSION_CONFLICT');
    expect(modelCalls()).toBe(0);
  });

  it('requires a catalog version', async () => {
    const { call } = await setup();
    const rest = { eventId: 'evt', topics: explainBody.topics };
    const r = await call('POST', '/api/v1/bridges/bridge%3As1/explain', rest);
    expect(r.status).toBe(400);
  });

  it('returns 404 for an unknown bridge or event', async () => {
    const { call } = await setup();
    expect((await call('POST', '/api/v1/bridges/bridge%3Anope/explain', explainBody)).status).toBe(
      404,
    );
    expect(
      (await call('POST', '/api/v1/bridges/bridge%3As1/explain', { ...explainBody, eventId: 'x' }))
        .status,
    ).toBe(404);
  });
});
