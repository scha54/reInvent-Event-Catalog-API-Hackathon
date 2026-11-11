/**
 * Local search index: BM25 over `searchableText` + in-memory vector index with
 * precomputed top-K neighbors and topic clusters (FR-03 3.4, NFR-03 15.1/15.3,
 * NFR-04 16.2).
 *
 * The index is built once per `(eventId, catalogVersion, embeddingModelVersion)`,
 * serialized to a compact JSON document (vectors as base64 Float32), stored in
 * S3 behind {@link IndexBlobStore}, and cached per container.
 */
import type { Session } from '@serendipity/packages-contracts';
import { Bm25Index, buildBm25, type Bm25Data } from './bm25.js';
import type { EmbeddingRecord } from './embedding-client.js';
import { VectorIndex, defaultClusterCount } from './vector-index.js';

export const INDEX_FORMAT_VERSION = 1;
export const DEFAULT_NEIGHBOR_K = 10;

export class IndexFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexFormatError';
  }
}

export interface IndexKey {
  readonly eventId: string;
  readonly catalogVersion: string;
  readonly embeddingModelVersion: string;
}

export type IndexSession = Pick<Session, 'sessionId' | 'searchableText'>;

export interface BuildIndexInput extends IndexKey {
  readonly sessions: readonly IndexSession[];
  /** Embeddings for this catalog; records for other models/sessions are ignored. */
  readonly embeddings: readonly Pick<
    EmbeddingRecord,
    'sessionId' | 'embeddingModelVersion' | 'vector'
  >[];
  readonly neighborK?: number;
  readonly clusterCount?: number;
}

export interface Neighbor {
  readonly sessionId: string;
  readonly score: number;
}

export interface ScoredSession {
  readonly sessionId: string;
  readonly score: number;
}

/** Serialized shape (JSON). */
interface SerializedIndex {
  readonly formatVersion: number;
  readonly key: IndexKey;
  readonly sessionIds: readonly string[];
  readonly bm25: Bm25Data;
  readonly dims: number;
  /** Doc indexes that have a vector, in vector-row order. */
  readonly vectorDocs: readonly number[];
  /** Base64 little-endian Float32 rows. */
  readonly vectors: string;
  readonly neighborK: number;
  /** Per vector row: flat `[row, score, ...]` neighbor pairs. */
  readonly neighbors: readonly (readonly number[])[];
  readonly clusterAssignments: readonly number[];
  readonly centroids: string;
}

/* ------------------------------ base64 f32 ------------------------------ */

function f32ToBase64(a: Float32Array): string {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
}

function base64ToF32(s: string): Float32Array {
  const buf = Buffer.from(s, 'base64');
  if (buf.byteLength % 4 !== 0) throw new IndexFormatError('Corrupt vector payload');
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

/* -------------------------------- LocalIndex ---------------------------- */

export class LocalIndex {
  private readonly bm25: Bm25Index;
  private readonly vectors: VectorIndex;
  private readonly docToRow = new Map<number, number>();
  private readonly idToDoc = new Map<string, number>();

  private constructor(private readonly s: SerializedIndex) {
    this.bm25 = new Bm25Index(s.bm25);
    this.vectors = new VectorIndex(s.dims, s.vectorDocs.length, base64ToF32(s.vectors));
    s.vectorDocs.forEach((doc, row) => this.docToRow.set(doc, row));
    s.sessionIds.forEach((id, doc) => this.idToDoc.set(id, doc));
  }

  get key(): IndexKey {
    return this.s.key;
  }
  get sessionIds(): readonly string[] {
    return this.s.sessionIds;
  }
  /** True when at least one session has a vector (false => lexical-only). */
  get hasVectors(): boolean {
    return this.vectors.rows > 0;
  }
  get clusterCount(): number {
    return this.s.centroids === '' ? 0 : base64ToF32(this.s.centroids).length / this.s.dims;
  }

  /** BM25 search over `searchableText`. */
  searchLexical(query: string, k: number): ScoredSession[] {
    return this.bm25
      .search(query, k)
      .map((h) => ({ sessionId: this.s.sessionIds[h.doc] as string, score: h.score }));
  }

  /** Cosine nearest sessions to a query embedding. */
  searchVector(query: ArrayLike<number>, k: number): ScoredSession[] {
    return this.vectors
      .search(query, k)
      .map((h) => ({ sessionId: this.idOfRow(h.row), score: h.score }));
  }

  /** Precomputed nearest neighbors of a session (empty if it has no vector). */
  neighborsOf(sessionId: string, k?: number): Neighbor[] {
    const row = this.rowOf(sessionId);
    if (row === undefined) return [];
    const flat = this.s.neighbors[row] ?? [];
    const out: Neighbor[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      out.push({ sessionId: this.idOfRow(flat[i] as number), score: flat[i + 1] as number });
    }
    return k === undefined ? out : out.slice(0, k);
  }

  /** Topic cluster id of a session, or undefined if it has no vector. */
  clusterOf(sessionId: string): number | undefined {
    const row = this.rowOf(sessionId);
    return row === undefined ? undefined : this.s.clusterAssignments[row];
  }

  clusterMembers(cluster: number): string[] {
    const out: string[] = [];
    this.s.clusterAssignments.forEach((c, row) => {
      if (c === cluster) out.push(this.idOfRow(row));
    });
    return out;
  }

  serialize(): string {
    return JSON.stringify(this.s);
  }

  static build(input: BuildIndexInput): LocalIndex {
    const seen = new Set<string>();
    const sessions = input.sessions.filter((s) => {
      if (seen.has(s.sessionId)) return false;
      seen.add(s.sessionId);
      return true;
    });
    const vecById = new Map<string, readonly number[]>();
    for (const e of input.embeddings) {
      if (e.embeddingModelVersion === input.embeddingModelVersion) {
        vecById.set(e.sessionId, e.vector);
      }
    }

    const vectorDocs: number[] = [];
    const rawVectors: (readonly number[])[] = [];
    sessions.forEach((s, doc) => {
      const v = vecById.get(s.sessionId);
      if (v) {
        vectorDocs.push(doc);
        rawVectors.push(v);
      }
    });
    const dims = rawVectors[0]?.length ?? 0;
    const vectors = VectorIndex.fromVectors(rawVectors, dims);

    const neighborK = input.neighborK ?? DEFAULT_NEIGHBOR_K;
    const neighbors = vectors
      .precomputeNeighbors(neighborK)
      .map((hits) => hits.flatMap((h) => [h.row, h.score]));
    const { assignments, centroids } = vectors.cluster(
      input.clusterCount ?? defaultClusterCount(vectors.rows),
    );

    return new LocalIndex({
      formatVersion: INDEX_FORMAT_VERSION,
      key: {
        eventId: input.eventId,
        catalogVersion: input.catalogVersion,
        embeddingModelVersion: input.embeddingModelVersion,
      },
      sessionIds: sessions.map((s) => s.sessionId),
      bm25: buildBm25(sessions.map((s) => s.searchableText)),
      dims,
      vectorDocs,
      vectors: f32ToBase64(vectors.vectors),
      neighborK,
      neighbors,
      clusterAssignments: assignments,
      centroids: f32ToBase64(centroids),
    });
  }

  static deserialize(raw: string): LocalIndex {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new IndexFormatError('Index is not valid JSON');
    }
    const s = json as Partial<SerializedIndex> | null;
    if (
      !s ||
      s.formatVersion !== INDEX_FORMAT_VERSION ||
      !s.key ||
      !Array.isArray(s.sessionIds) ||
      !s.bm25 ||
      typeof s.dims !== 'number' ||
      !Array.isArray(s.vectorDocs) ||
      typeof s.vectors !== 'string' ||
      typeof s.centroids !== 'string' ||
      !Array.isArray(s.neighbors) ||
      !Array.isArray(s.clusterAssignments)
    ) {
      throw new IndexFormatError('Unsupported or malformed index document');
    }
    if (
      s.bm25.docCount !== s.sessionIds.length ||
      s.neighbors.length !== s.vectorDocs.length ||
      s.clusterAssignments.length !== s.vectorDocs.length
    ) {
      throw new IndexFormatError('Index sections are inconsistent');
    }
    try {
      return new LocalIndex(s as SerializedIndex);
    } catch (err) {
      throw new IndexFormatError(err instanceof Error ? err.message : 'Corrupt index');
    }
  }

  private rowOf(sessionId: string): number | undefined {
    const doc = this.idToDoc.get(sessionId);
    return doc === undefined ? undefined : this.docToRow.get(doc);
  }

  private idOfRow(row: number): string {
    return this.s.sessionIds[this.s.vectorDocs[row] as number] as string;
  }
}

/* ---------------------------- storage and cache -------------------------- */

/** Minimal blob store (S3 in production, in-memory in tests). */
export interface IndexBlobStore {
  /** Returns undefined when the object does not exist. */
  get(key: string): Promise<string | undefined>;
  put(key: string, body: string): Promise<void>;
}

function seg(s: string): string {
  return encodeURIComponent(s).replace(/\./g, '%2E');
}

/** S3 object key: `indexes/<eventId>/<catalogVersion>/<embeddingModelVersion>.json`. */
export function indexObjectKey(k: IndexKey): string {
  return `indexes/${seg(k.eventId)}/${seg(k.catalogVersion)}/${seg(k.embeddingModelVersion)}.json`;
}

/** Per-container cache of deserialized indexes keyed by version. */
export class IndexCache {
  private readonly entries = new Map<string, Promise<LocalIndex | undefined>>();
  constructor(private readonly maxEntries = 2) {}

  get(key: string, load: () => Promise<LocalIndex | undefined>): Promise<LocalIndex | undefined> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key); // refresh LRU order
      this.entries.set(key, hit);
      return hit;
    }
    const p = load();
    this.entries.set(key, p);
    // Never cache failures or misses.
    p.then(
      (v) => {
        if (v === undefined) this.entries.delete(key);
      },
      () => this.entries.delete(key),
    );
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return p;
  }

  set(key: string, index: LocalIndex): void {
    this.entries.set(key, Promise.resolve(index));
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Shared per-container cache (module scope survives warm Lambda invocations). */
export const containerIndexCache = new IndexCache();

/** Serialize and store an index under its versioned key; primes the cache. */
export async function saveIndex(
  store: IndexBlobStore,
  index: LocalIndex,
  cache: IndexCache = containerIndexCache,
): Promise<string> {
  const key = indexObjectKey(index.key);
  await store.put(key, index.serialize());
  cache.set(key, index);
  return key;
}

/** Load an index for a catalog/model version (cache first, then store). */
export async function loadIndex(
  store: IndexBlobStore,
  key: IndexKey,
  cache: IndexCache = containerIndexCache,
): Promise<LocalIndex | undefined> {
  const objectKey = indexObjectKey(key);
  return cache.get(objectKey, async () => {
    const raw = await store.get(objectKey);
    return raw === undefined ? undefined : LocalIndex.deserialize(raw);
  });
}
