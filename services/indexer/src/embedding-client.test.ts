import { describe, expect, it } from 'vitest';
import type { Session } from '@serendipity/packages-contracts';
import {
  BedrockEmbeddingClient,
  EmbeddingConfigError,
  embedChangedSessions,
  loadEmbeddingConfig,
  type EmbeddingRecord,
  type InvokeModelFn,
  type InvokeResult,
} from './index.js';

const env = {
  BEDROCK_EMBEDDING_MODEL_ID: 'test.titan-embed-test',
  BEDROCK_EMBEDDING_DIMENSIONS: '4',
  BEDROCK_REGION: 'us-test-1',
};
const config = loadEmbeddingConfig(env);

const ok = (vector: number[]): InvokeResult => ({
  status: 200,
  headers: { get: () => null },
  body: JSON.stringify({ embedding: vector }),
});
const status = (code: number, retryAfter?: string): InvokeResult => ({
  status: code,
  headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
  body: '',
});

const session = (id: string, hash: string, text = `text ${id}`): Session => ({
  eventId: 'e1',
  sessionId: id,
  catalogVersion: 'v2',
  title: id,
  abstract: '',
  topics: [],
  sourceHash: hash,
  ingestedAt: '2024-01-01T00:00:00Z',
  searchableText: text,
});

const fastRetry = { sleep: async () => {}, random: () => 0.5 };

describe('loadEmbeddingConfig', () => {
  it('reads model, dimensions, and region from configuration', () => {
    expect(config).toMatchObject({
      modelId: 'test.titan-embed-test',
      dimensions: 4,
      region: 'us-test-1',
      modelVersion: 'test.titan-embed-test@4',
    });
  });

  it('rejects missing or invalid values', () => {
    expect(() => loadEmbeddingConfig({ ...env, BEDROCK_REGION: '' })).toThrow(EmbeddingConfigError);
    expect(() => loadEmbeddingConfig({ ...env, BEDROCK_EMBEDDING_MODEL_ID: undefined })).toThrow(
      EmbeddingConfigError,
    );
    expect(() => loadEmbeddingConfig({ ...env, BEDROCK_EMBEDDING_DIMENSIONS: '0' })).toThrow(
      EmbeddingConfigError,
    );
  });
});

describe('embedChangedSessions', () => {
  it('embeds only sessions whose hash or model version changed', async () => {
    const calls: string[] = [];
    const invoke: InvokeModelFn = async (req) => {
      calls.push(JSON.parse(req.body).inputText);
      return ok([1, 0, 0, 0]);
    };
    const client = new BedrockEmbeddingClient(config, { invoke, retry: fastRetry });
    const old = (id: string, hash: string, version = config.modelVersion): EmbeddingRecord => ({
      eventId: 'e1',
      catalogVersion: 'v1',
      sessionId: id,
      embeddingModelVersion: version,
      sourceHash: hash,
      vector: [0, 1, 0, 0],
    });

    const res = await embedChangedSessions(client, {
      sessions: [
        session('a', 'h1'),
        session('b', 'h2-new'),
        session('c', 'h3'),
        session('d', 'h4', '  '),
      ],
      existing: [old('a', 'h1'), old('b', 'h2'), old('c', 'h3', 'other-model@4')],
    });

    expect(calls.sort()).toEqual(['text b', 'text c']);
    expect(res.reused.map((r) => [r.sessionId, r.catalogVersion])).toEqual([['a', 'v2']]);
    expect(res.embedded.map((r) => r.sessionId)).toEqual(['b', 'c']);
    expect(res.skipped).toEqual(['d']);
    expect(res.embedded[0]?.embeddingModelVersion).toBe(config.modelVersion);
  });

  it('retries throttling with backoff and then succeeds', async () => {
    const responses = [status(429, '1'), status(503), ok([1, 2, 3, 4])];
    const sleeps: number[] = [];
    const invoke: InvokeModelFn = async () => responses.shift() as InvokeResult;
    const client = new BedrockEmbeddingClient(config, {
      invoke,
      retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 },
    });
    await expect(client.embedText('x')).resolves.toEqual([1, 2, 3, 4]);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBe(1000); // Retry-After honored
  });

  it('reports sessions that stay throttled as failed instead of throwing', async () => {
    const invoke: InvokeModelFn = async () => status(429);
    const client = new BedrockEmbeddingClient(config, {
      invoke,
      retry: { ...fastRetry, policy: { maxAttempts: 2 } },
    });
    const res = await embedChangedSessions(client, { sessions: [session('a', 'h')] });
    expect(res.failed.map((f) => f.sessionId)).toEqual(['a']);
    expect(res.embedded).toEqual([]);
  });

  it('fails a session when the vector length differs from configured dimensions', async () => {
    const client = new BedrockEmbeddingClient(config, {
      invoke: async () => ok([1, 2]),
      retry: fastRetry,
    });
    const res = await embedChangedSessions(client, { sessions: [session('a', 'h')] });
    expect(res.failed).toHaveLength(1);
  });
});
