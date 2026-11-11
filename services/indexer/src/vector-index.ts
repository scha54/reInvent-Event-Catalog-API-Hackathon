/**
 * In-memory brute-force cosine vector index with top-K neighbor precomputation
 * and deterministic topic clusters (FR-03 3.4, NFR-03 15.1).
 *
 * Brute force is exact and fast enough for event-scale catalogs (thousands of
 * sessions). Vectors are L2-normalized so cosine similarity is a dot product.
 */

export interface VectorHit {
  /** Row index in the order passed to {@link VectorIndex}. */
  readonly row: number;
  readonly score: number;
}

export function normalize(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += (v[i] as number) ** 2;
  const norm = Math.sqrt(sum);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / norm;
  return out;
}

function dot(a: Float32Array, aOff: number, b: Float32Array, bOff: number, dims: number): number {
  let s = 0;
  for (let i = 0; i < dims; i++) s += (a[aOff + i] as number) * (b[bOff + i] as number);
  return s;
}

export class VectorIndex {
  /**
   * @param vectors Flat row-major normalized vectors (`rows * dims`).
   */
  constructor(
    readonly dims: number,
    readonly rows: number,
    readonly vectors: Float32Array,
  ) {
    if (vectors.length !== dims * rows) {
      throw new Error(`Vector data length ${vectors.length} != ${rows} x ${dims}`);
    }
  }

  static fromVectors(vectors: readonly ArrayLike<number>[], dims: number): VectorIndex {
    const flat = new Float32Array(vectors.length * dims);
    vectors.forEach((v, i) => {
      if (v.length !== dims) throw new Error(`Vector ${i} has ${v.length} dims; expected ${dims}`);
      flat.set(normalize(v), i * dims);
    });
    return new VectorIndex(dims, vectors.length, flat);
  }

  /** Top-k rows by cosine similarity to `query`, best first. */
  search(query: ArrayLike<number>, k: number, excludeRow?: number): VectorHit[] {
    if (k <= 0 || this.rows === 0) return [];
    if (query.length !== this.dims) {
      throw new Error(`Query has ${query.length} dims; expected ${this.dims}`);
    }
    const q = normalize(query);
    return this.rank(q, 0, k, excludeRow);
  }

  private rank(q: Float32Array, qOff: number, k: number, excludeRow?: number): VectorHit[] {
    const hits: VectorHit[] = [];
    for (let r = 0; r < this.rows; r++) {
      if (r === excludeRow) continue;
      hits.push({ row: r, score: dot(q, qOff, this.vectors, r * this.dims, this.dims) });
    }
    return hits.sort((a, b) => b.score - a.score || a.row - b.row).slice(0, k);
  }

  /** Precompute the top-k nearest neighbors (excluding self) for every row. */
  precomputeNeighbors(k: number): VectorHit[][] {
    const out: VectorHit[][] = [];
    for (let r = 0; r < this.rows; r++) out.push(this.rank(this.vectors, r * this.dims, k, r));
    return out;
  }

  /**
   * Deterministic k-means (cosine / spherical). Initial centroids are evenly
   * spaced rows, so results depend only on the data. Returns per-row cluster
   * assignment and the (normalized) centroids.
   */
  cluster(k: number, iterations = 10): { assignments: number[]; centroids: Float32Array } {
    const n = this.rows;
    const dims = this.dims;
    const kk = Math.max(0, Math.min(k, n));
    const assignments = new Array<number>(n).fill(0);
    if (kk === 0) return { assignments, centroids: new Float32Array(0) };
    let centroids = new Float32Array(kk * dims);
    for (let c = 0; c < kk; c++) {
      const row = Math.floor((c * n) / kk);
      centroids.set(this.vectors.subarray(row * dims, (row + 1) * dims), c * dims);
    }
    for (let it = 0; it < iterations; it++) {
      let changed = false;
      for (let r = 0; r < n; r++) {
        let best = 0;
        let bestScore = -Infinity;
        for (let c = 0; c < kk; c++) {
          const s = dot(this.vectors, r * dims, centroids, c * dims, dims);
          if (s > bestScore) {
            bestScore = s;
            best = c;
          }
        }
        if (assignments[r] !== best) {
          assignments[r] = best;
          changed = true;
        }
      }
      const sums = new Float32Array(kk * dims);
      const counts = new Array<number>(kk).fill(0);
      for (let r = 0; r < n; r++) {
        const c = assignments[r] as number;
        counts[c] = (counts[c] as number) + 1;
        for (let d = 0; d < dims; d++) {
          sums[c * dims + d] =
            (sums[c * dims + d] as number) + (this.vectors[r * dims + d] as number);
        }
      }
      const next = new Float32Array(kk * dims);
      for (let c = 0; c < kk; c++) {
        if (counts[c] === 0) {
          next.set(centroids.subarray(c * dims, (c + 1) * dims), c * dims); // keep empty centroid
        } else {
          next.set(normalize(sums.subarray(c * dims, (c + 1) * dims)), c * dims);
        }
      }
      centroids = next;
      if (!changed && it > 0) break;
    }
    return { assignments, centroids };
  }
}

/** Default cluster count for `n` vectors: about sqrt(n / 2), at least 1 when n > 0. */
export function defaultClusterCount(n: number): number {
  return n === 0 ? 0 : Math.max(1, Math.round(Math.sqrt(n / 2)));
}
