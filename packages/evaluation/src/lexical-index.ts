/**
 * Tiny in-memory BM25 index implementing the discovery `RetrievalIndex`
 * structurally, so the harness exercises the real retrieval and scoring code
 * without depending on the indexer service. Lexical only (no vectors).
 */
import type {
  RetrievalHit,
  RetrievalIndex,
  ScorableSession,
} from '@serendipity/packages-discovery';

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'into', 'your']);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !STOP.has(t));

export function buildLexicalIndex(sessions: readonly ScorableSession[]): RetrievalIndex {
  const docs = sessions.map((s) => {
    const toks = tokenize([s.title, s.abstract, s.track ?? '', ...s.topics].join(' '));
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { id: s.sessionId, len: toks.length, tf };
  });
  const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;

  return {
    hasVectors: false,
    searchVector: () => [],
    searchLexical(query: string, k: number): readonly RetrievalHit[] {
      const q = [...new Set(tokenize(query))];
      const hits: RetrievalHit[] = [];
      for (const d of docs) {
        let score = 0;
        for (const t of q) {
          const f = d.tf.get(t) ?? 0;
          if (f === 0) continue;
          const n = df.get(t) ?? 0;
          const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
          score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg));
        }
        if (score > 0) hits.push({ sessionId: d.id, score });
      }
      hits.sort((x, y) => y.score - x.score || x.sessionId.localeCompare(y.sessionId));
      return hits.slice(0, k);
    },
  };
}
