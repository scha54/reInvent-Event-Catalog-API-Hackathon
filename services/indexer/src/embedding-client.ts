/**
 * Bedrock embedding client (FR-04 4.1, NFR-03 15.3, NFR-04 16.1, AI 20.4).
 *
 * - Model ID, dimensions, and region come from {@link EmbeddingConfig}.
 * - Only sessions whose `(sessionId, sourceHash, embeddingModelVersion)` is not
 *   already embedded are sent to the model.
 * - Throttling (429), 5xx, timeouts, and network errors are retried using the
 *   shared backoff utility from services/ingestion.
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import type { Session } from '@serendipity/packages-contracts';
import { withRetry } from '@serendipity/services-ingestion';
import type { RetryOptions, RetryableResponse } from '@serendipity/services-ingestion';
import type { EmbeddingConfig } from './embedding-config.js';

/** Stored embedding: `{eventId, catalogVersion, sessionId, embeddingModelVersion, vector}`. */
export interface EmbeddingRecord {
  readonly eventId: string;
  readonly catalogVersion: string;
  readonly sessionId: string;
  readonly embeddingModelVersion: string;
  /** Content hash of the session the vector was computed from. */
  readonly sourceHash: string;
  readonly vector: readonly number[];
}

/** Response-like result so the transport plugs into `withRetry`. */
export interface InvokeResult extends RetryableResponse {
  /** Raw JSON response body ('' on error statuses). */
  readonly body: string;
}

export interface InvokeRequest {
  readonly modelId: string;
  readonly body: string;
}

/** Low-level model invocation; replaceable in tests. */
export type InvokeModelFn = (req: InvokeRequest, signal: AbortSignal) => Promise<InvokeResult>;

export class EmbeddingResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingResponseError';
  }
}

/* ---------------------------- model families ---------------------------- */

type Family = 'titan' | 'cohere';

function familyOf(modelId: string): Family {
  const id = modelId.toLowerCase();
  if (id.includes('titan')) return 'titan';
  if (id.includes('cohere')) return 'cohere';
  throw new EmbeddingResponseError(
    `Unsupported embedding model family for "${modelId}" (supported: titan, cohere)`,
  );
}

export function buildRequestBody(config: EmbeddingConfig, text: string): string {
  switch (familyOf(config.modelId)) {
    case 'titan':
      return JSON.stringify({ inputText: text, dimensions: config.dimensions, normalize: true });
    case 'cohere':
      return JSON.stringify({
        texts: [text],
        input_type: 'search_document',
        embedding_types: ['float'],
      });
  }
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function parseEmbedding(config: EmbeddingConfig, raw: string): number[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new EmbeddingResponseError('Embedding response is not valid JSON');
  }
  const obj = (json ?? {}) as Record<string, unknown>;
  let vector: unknown;
  if (familyOf(config.modelId) === 'titan') {
    vector = obj['embedding'];
  } else {
    const embeddings = obj['embeddings'];
    const list = Array.isArray(embeddings)
      ? embeddings
      : (embeddings as Record<string, unknown>)?.['float'];
    vector = Array.isArray(list) ? list[0] : undefined;
  }
  if (!isNumberArray(vector)) {
    throw new EmbeddingResponseError('Embedding response has no numeric vector');
  }
  if (vector.length !== config.dimensions) {
    throw new EmbeddingResponseError(
      `Embedding has ${vector.length} dimensions; configured ${config.dimensions}`,
    );
  }
  return vector;
}

/* ------------------------------ transport ------------------------------- */

interface SdkErrorLike {
  name?: string;
  $metadata?: { httpStatusCode?: number };
  $response?: { headers?: Record<string, string | undefined> };
}

function headersOf(
  h: Record<string, string | undefined> | undefined,
): RetryableResponse['headers'] {
  const lower = new Map(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v ?? null]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

/**
 * Real Bedrock transport. Service errors are converted to response-like results
 * so `withRetry` can classify them; unknown errors (network) are rethrown and
 * retried by `withRetry`.
 */
export function createBedrockInvoker(
  config: Pick<EmbeddingConfig, 'region'>,
  client: Pick<BedrockRuntimeClient, 'send'> = new BedrockRuntimeClient({
    region: config.region,
    // Retries are owned by withRetry; avoid multiplying attempts.
    maxAttempts: 1,
  }),
): InvokeModelFn {
  return async (req, signal) => {
    try {
      const out: InvokeModelCommandOutput = await client.send(
        new InvokeModelCommand({
          modelId: req.modelId,
          body: req.body,
          contentType: 'application/json',
          accept: 'application/json',
        }),
        { abortSignal: signal },
      );
      return {
        status: 200,
        headers: headersOf(undefined),
        body: new TextDecoder().decode(out.body),
      };
    } catch (err) {
      const e = err as SdkErrorLike;
      let status = e.$metadata?.httpStatusCode;
      if (e.name === 'ThrottlingException' || e.name === 'TooManyRequestsException') status = 429;
      else if (e.name === 'ModelTimeoutException' || e.name === 'ServiceUnavailableException')
        status = 503;
      if (status === undefined) throw err;
      return { status, headers: headersOf(e.$response?.headers), body: '' };
    }
  };
}

/* -------------------------------- client -------------------------------- */

export interface EmbeddingClientOptions {
  readonly invoke?: InvokeModelFn;
  readonly retry?: RetryOptions;
}

export class BedrockEmbeddingClient {
  private readonly invoke: InvokeModelFn;
  private readonly retry: RetryOptions;

  constructor(
    readonly config: EmbeddingConfig,
    options: EmbeddingClientOptions = {},
  ) {
    familyOf(config.modelId); // fail fast on unsupported models
    this.invoke = options.invoke ?? createBedrockInvoker(config);
    this.retry = options.retry ?? {};
  }

  /** Embed one text. Throttling is retried with backoff; exhaustion throws. */
  async embedText(text: string): Promise<number[]> {
    const body = buildRequestBody(this.config, text);
    const res = await withRetry(
      (signal) => this.invoke({ modelId: this.config.modelId, body }, signal),
      this.retry,
    );
    return parseEmbedding(this.config, res.body);
  }
}

/* ------------------------- incremental embedding ------------------------ */

export interface EmbedSessionsResult {
  /** Newly computed records. */
  readonly embedded: EmbeddingRecord[];
  /** Existing records reused (same session, hash, and model version), re-stamped to this catalog version. */
  readonly reused: EmbeddingRecord[];
  /** Sessions with no searchable text. */
  readonly skipped: string[];
  /** Sessions that failed after retries; safe to redrive. */
  readonly failed: { sessionId: string; error: unknown }[];
}

export interface EmbedSessionsInput {
  readonly sessions: readonly Session[];
  /** Previously stored embeddings (any catalog version). */
  readonly existing?: readonly EmbeddingRecord[];
}

/**
 * Embed only the sessions that changed: a session is skipped when an existing
 * record matches its `sourceHash` and the client's model version.
 */
export async function embedChangedSessions(
  client: BedrockEmbeddingClient,
  input: EmbedSessionsInput,
): Promise<EmbedSessionsResult> {
  const { modelVersion, concurrency } = client.config;
  const cache = new Map<string, EmbeddingRecord>();
  for (const r of input.existing ?? []) {
    if (r.embeddingModelVersion === modelVersion) {
      cache.set(`${r.eventId}\u0000${r.sessionId}\u0000${r.sourceHash}`, r);
    }
  }

  const result: EmbedSessionsResult = { embedded: [], reused: [], skipped: [], failed: [] };
  const todo: Session[] = [];
  const seen = new Set<string>();
  for (const s of input.sessions) {
    const id = `${s.eventId}\u0000${s.sessionId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (s.searchableText.trim() === '') {
      result.skipped.push(s.sessionId);
      continue;
    }
    const hit = cache.get(`${id}\u0000${s.sourceHash}`);
    if (hit) result.reused.push({ ...hit, catalogVersion: s.catalogVersion });
    else todo.push(s);
  }

  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < todo.length; i = next++) {
      const s = todo[i] as Session;
      try {
        const vector = await client.embedText(s.searchableText);
        result.embedded.push({
          eventId: s.eventId,
          catalogVersion: s.catalogVersion,
          sessionId: s.sessionId,
          embeddingModelVersion: modelVersion,
          sourceHash: s.sourceHash,
          vector,
        });
      } catch (error) {
        result.failed.push({ sessionId: s.sessionId, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

  const bySession = (a: { sessionId: string }, b: { sessionId: string }): number =>
    a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  result.embedded.sort(bySession);
  result.reused.sort(bySession);
  result.failed.sort(bySession);
  return result;
}
