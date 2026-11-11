/**
 * Hybrid retrieval (FR-03 3.1/3.4, FR-04 4.4).
 *
 * For each topic, combine BM25 (lexical) and vector-nearest hits from the local
 * index, merge and deduplicate by session ID, and drop candidates below a
 * minimum topical relevance threshold. Only the index is queried; the catalog
 * is never scanned, so every returned session ID exists in the index.
 */

export interface RetrievalHit {
  readonly sessionId: string;
  readonly score: number;
}

/** Structural subset of the indexer's `LocalIndex` used by retrieval. */
export interface RetrievalIndex {
  searchLexical(query: string, k: number): readonly RetrievalHit[];
  searchVector(query: ArrayLike<number>, k: number): readonly RetrievalHit[];
  readonly hasVectors: boolean;
}

export interface RetrievalConfig {
  /** Minimum topical relevance in [0,1] for a session to be kept (R_min floor). */
  readonly minRelevance: number;
  /** Max hits requested from each retriever, per topic. */
  readonly topK: number;
  /** BM25 score at which normalized lexical relevance reaches 0.5. */
  readonly lexicalSaturation: number;
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  minRelevance: 0.3,
  topK: 50,
  lexicalSaturation: 3,
};

export type RetrievalSource = 'lexical' | 'vector';

export interface RetrievedCandidate {
  readonly sessionId: string;
  /** Combined topical relevance in [0,1]: max of normalized lexical and vector scores. */
  readonly relevance: number;
  readonly lexicalScore: number;
  readonly vectorScore: number;
  readonly sources: readonly RetrievalSource[];
}

export interface TopicRetrieval {
  readonly topic: string;
  readonly candidates: readonly RetrievedCandidate[];
  /** True when vector search was skipped (no vectors or no query embedding). */
  readonly lexicalOnly: boolean;
}

export interface RetrieveInput {
  readonly index: RetrievalIndex;
  /** Normalized topic (see `validateTopic`). */
  readonly topic: string;
  /** Query embedding for the topic; omit for the lexical-only degraded path. */
  readonly queryEmbedding?: ArrayLike<number> | undefined;
  readonly config?: Partial<RetrievalConfig> | undefined;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Retrieve candidates for one topic from the index. Deterministic. */
export function retrieveForTopic(input: RetrieveInput): TopicRetrieval {
  const cfg: RetrievalConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...input.config };
  const { index, topic } = input;

  const lexical = index.searchLexical(topic, cfg.topK);
  const useVector =
    input.queryEmbedding !== undefined && input.queryEmbedding.length > 0 && index.hasVectors;
  const vector = useVector
    ? index.searchVector(input.queryEmbedding as ArrayLike<number>, cfg.topK)
    : [];

  const merged = new Map<
    string,
    { lexicalScore: number; vectorScore: number; sources: Set<RetrievalSource> }
  >();
  const entry = (id: string) => {
    let e = merged.get(id);
    if (!e) {
      e = { lexicalScore: 0, vectorScore: 0, sources: new Set() };
      merged.set(id, e);
    }
    return e;
  };
  for (const h of lexical) {
    const e = entry(h.sessionId);
    e.lexicalScore = Math.max(e.lexicalScore, h.score);
    e.sources.add('lexical');
  }
  for (const h of vector) {
    const e = entry(h.sessionId);
    e.vectorScore = Math.max(e.vectorScore, h.score);
    e.sources.add('vector');
  }

  const candidates: RetrievedCandidate[] = [];
  for (const [sessionId, e] of merged) {
    const lexNorm =
      e.lexicalScore > 0 ? e.lexicalScore / (e.lexicalScore + cfg.lexicalSaturation) : 0;
    const relevance = clamp01(Math.max(lexNorm, clamp01(e.vectorScore)));
    if (relevance < cfg.minRelevance) continue;
    candidates.push({
      sessionId,
      relevance,
      lexicalScore: e.lexicalScore,
      vectorScore: e.vectorScore,
      sources: [...e.sources].sort(),
    });
  }
  candidates.sort((a, b) => b.relevance - a.relevance || a.sessionId.localeCompare(b.sessionId));

  return { topic, candidates, lexicalOnly: !useVector };
}

/** Retrieve per topic (one or two topics), preserving topic order. */
export function retrieveForTopics(
  index: RetrievalIndex,
  topics: readonly {
    readonly topic: string;
    readonly queryEmbedding?: ArrayLike<number> | undefined;
  }[],
  config?: Partial<RetrievalConfig>,
): TopicRetrieval[] {
  return topics.map((t) =>
    retrieveForTopic({ index, topic: t.topic, queryEmbedding: t.queryEmbedding, config }),
  );
}
