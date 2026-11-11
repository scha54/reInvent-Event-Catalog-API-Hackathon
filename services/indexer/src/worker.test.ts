import { describe, expect, it } from 'vitest';
import {
  BedrockEmbeddingClient,
  handleSqsBatch,
  loadEmbeddingConfig,
  type EmbeddingLookupKey,
  type EmbeddingRecord,
  type EmbeddingStore,
  type FallbackFlagStore,
  type InvokeModelFn,
  type InvokeResult,
  type LexicalFallbackFlag,
  type WorkerDeps,
} from './index.js';

const config = loadEmbeddingConfig({
  BEDROCK_EMBEDDING_MODEL_ID: 'test.titan-embed-test',
  BEDROCK_EMBEDDING_DIMENSIONS: '2',
  BEDROCK_REGION: 'us-test-1',
});

const ok = (vector: number[]): InvokeResult => ({
  status: 200,
  headers: { get: () => null },
  body: JSON.stringify({ embedding: vector }),
});
const throttled: InvokeResult = { status: 429, headers: { get: () => null }, body: '' };

const keyOf = (k: EmbeddingLookupKey): string =>
  [k.eventId, k.sessionId, k.sourceHash, k.embeddingModelVersion].join('|');

function setup(invoke: InvokeModelFn) {
  const records = new Map<string, EmbeddingRecord>();
  const flags: LexicalFallbackFlag[] = [];
  const store: EmbeddingStore = {
    get: async (k) => records.get(keyOf(k)),
    put: async (r) => {
      records.set(keyOf({ ...r, embeddingModelVersion: r.embeddingModelVersion }), r);
    },
  };
  const fallback: FallbackFlagStore = { setLexicalOnly: async (f) => void flags.push(f) };
  const client = new BedrockEmbeddingClient(config, {
    invoke,
    retry: { policy: { maxAttempts: 2 }, sleep: async () => {}, random: () => 0.5 },
  });
  const deps: WorkerDeps = { client, store, fallback };
  return { deps, records, flags };
}

const msg = (id: string, over: Record<string, unknown> = {}) => ({
  messageId: id,
  body: JSON.stringify({
    eventId: 'e1',
    catalogVersion: 'v1',
    sessionId: id,
    sourceHash: `h-${id}`,
    searchableText: `text ${id}`,
    ...over,
  }),
});

describe('handleSqsBatch', () => {
  it('embeds and stores new work items', async () => {
    const { deps, records } = setup(async () => ok([1, 0]));
    const res = await handleSqsBatch({ Records: [msg('a'), msg('b')] }, deps);
    expect(res.batchItemFailures).toEqual([]);
    expect(records.size).toBe(2);
  });

  it('is idempotent: redelivery does not call the model again', async () => {
    let calls = 0;
    const { deps, records } = setup(async () => {
      calls++;
      return ok([1, 0]);
    });
    await handleSqsBatch({ Records: [msg('a')] }, deps);
    const res = await handleSqsBatch({ Records: [msg('a')] }, deps);
    expect(res.batchItemFailures).toEqual([]);
    expect(calls).toBe(1);
    expect(records.size).toBe(1);
  });

  it('re-embeds when the content hash changes', async () => {
    let calls = 0;
    const { deps } = setup(async () => {
      calls++;
      return ok([1, 0]);
    });
    await handleSqsBatch({ Records: [msg('a')] }, deps);
    await handleSqsBatch({ Records: [msg('a', { sourceHash: 'new' })] }, deps);
    expect(calls).toBe(2);
  });

  it('reports malformed messages as batch item failures without failing others', async () => {
    const { deps, records } = setup(async () => ok([1, 0]));
    const res = await handleSqsBatch(
      { Records: [msg('good'), { messageId: 'bad', body: '{not json' }] },
      deps,
    );
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }]);
    expect(records.size).toBe(1);
  });

  it('sets the lexical-only flag and reports failure when throttling is exhausted', async () => {
    const { deps, records, flags } = setup(async () => throttled);
    const res = await handleSqsBatch({ Records: [msg('a')] }, deps);
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'a' }]);
    expect(records.size).toBe(0);
    expect(flags).toEqual([
      expect.objectContaining({
        eventId: 'e1',
        catalogVersion: 'v1',
        embeddingModelVersion: config.modelVersion,
      }),
    ]);
  });

  it('does not set the flag for a bad model response', async () => {
    const { deps, flags } = setup(async () => ok([1, 2, 3]));
    const res = await handleSqsBatch({ Records: [msg('a')] }, deps);
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'a' }]);
    expect(flags).toEqual([]);
  });

  it('skips sessions without searchable text', async () => {
    const { deps, records } = setup(async () => ok([1, 0]));
    const res = await handleSqsBatch({ Records: [msg('a', { searchableText: '  ' })] }, deps);
    expect(res.batchItemFailures).toEqual([]);
    expect(records.size).toBe(0);
  });
});
