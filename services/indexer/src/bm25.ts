/**
 * Local BM25 index over `searchableText` (FR-03 3.4, NFR-03 15.1).
 *
 * Pure in-memory and deterministic: ties break on document order.
 */

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'with',
]);

/** Lowercase, split on non-letter/digit, drop stopwords and single characters. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export interface Bm25Hit {
  /** Document index in the order passed to {@link buildBm25}. */
  readonly doc: number;
  readonly score: number;
}

/** Compact serializable form: postings are flat `[doc, tf, doc, tf, ...]` per term. */
export interface Bm25Data {
  readonly docCount: number;
  readonly docLengths: readonly number[];
  readonly postings: Readonly<Record<string, readonly number[]>>;
}

export class Bm25Index {
  private readonly avgLen: number;
  private readonly postings: Map<string, readonly number[]>;

  constructor(readonly data: Bm25Data) {
    this.postings = new Map(Object.entries(data.postings));
    const total = data.docLengths.reduce((a, b) => a + b, 0);
    this.avgLen = data.docCount === 0 ? 0 : total / data.docCount;
  }

  /** Top-k documents by BM25 score (score > 0 only), best first. */
  search(query: string, k: number): Bm25Hit[] {
    if (k <= 0 || this.data.docCount === 0) return [];
    const scores = new Map<number, number>();
    for (const term of new Set(tokenize(query))) {
      const list = this.postings.get(term);
      if (!list) continue;
      const df = list.length / 2;
      const idf = Math.log(1 + (this.data.docCount - df + 0.5) / (df + 0.5));
      for (let i = 0; i < list.length; i += 2) {
        const doc = list[i] as number;
        const tf = list[i + 1] as number;
        const len = this.data.docLengths[doc] as number;
        const norm = 1 - BM25_B + BM25_B * (this.avgLen === 0 ? 0 : len / this.avgLen);
        const s = idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
        scores.set(doc, (scores.get(doc) ?? 0) + s);
      }
    }
    return [...scores.entries()]
      .map(([doc, score]) => ({ doc, score }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.doc - b.doc)
      .slice(0, k);
  }
}

/** Build BM25 data for documents in the given order. */
export function buildBm25(texts: readonly string[]): Bm25Data {
  const postings: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
  const docLengths: number[] = [];
  texts.forEach((text, doc) => {
    const tokens = tokenize(text);
    docLengths.push(tokens.length);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, count] of tf) (postings[term] ??= []).push(doc, count);
  });
  return { docCount: texts.length, docLengths, postings };
}
