/**
 * Bridge scoring, hard gates, MMR rerank, no-match, and the novelty slider
 * (FR-04 4.1/4.2/4.3/4.5/4.6, FR-10 10.1, AI 20.2/20.4).
 *
 * score(b) = wR*relevance + wB*bridgeStrength + wN*novelty + wD*diversity + wQ*quality
 * with every component in [0,1]. Hard gates (R_min, B_min, evidence count) are
 * applied before ranking, so neither novelty nor the slider can resurrect a
 * candidate that fails the relevance floor. Ordering is deterministic for a
 * fixed catalog version, config, and seed. Bridges are only built from
 * evidence found in real session text; when none qualify, `noMatch` is true.
 */
import type {
  Bridge,
  Evidence,
  Relationship,
  ScoreComponents,
} from '@serendipity/packages-contracts';
import type { RetrievedCandidate, TopicRetrieval } from './retrieval.js';

export const ALGORITHM_VERSION = 'bridge-scoring/1.0.0';

export interface ScoreWeights {
  readonly relevance: number;
  readonly bridgeStrength: number;
  readonly novelty: number;
  readonly diversity: number;
  readonly quality: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  relevance: 0.3,
  bridgeStrength: 0.25,
  novelty: 0.25,
  diversity: 0.15,
  quality: 0.05,
};

export interface ScoringConfig {
  readonly weights: ScoreWeights;
  /** Relevance floor (R_min): min of per-topic relevance of the bridge's sessions. */
  readonly minRelevance: number;
  /** Bridge strength floor (B_min). */
  readonly minBridgeStrength: number;
  /** Minimum evidence items for a two-session bridge. */
  readonly minEvidenceCount: number;
  /** Max candidates taken from each topic's retrieval before pairing. */
  readonly maxCandidatesPerTopic: number;
  /** Default number of bridges returned. */
  readonly defaultLimit: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weights: DEFAULT_WEIGHTS,
  minRelevance: 0.3,
  minBridgeStrength: 0.25,
  minEvidenceCount: 2,
  maxCandidatesPerTopic: 20,
  defaultLimit: 10,
};

/** Session fields used for scoring; the contracts `Session` is assignable to this. */
export interface ScorableSession {
  readonly sessionId: string;
  readonly title: string;
  readonly abstract: string;
  readonly track?: string | undefined;
  readonly topics: readonly string[];
  readonly level?: string | undefined;
  readonly format?: string | undefined;
  readonly startsAt?: string | undefined;
  readonly venue?: string | undefined;
  readonly officialUrl?: string | undefined;
}

export type SessionSimilarity = (a: ScorableSession, b: ScorableSession) => number;

export interface ScoreBridgesInput {
  readonly catalogVersion: string;
  /** Per-topic retrieval results (one or two topics), in topic order. */
  readonly retrievals: readonly TopicRetrieval[];
  /** Sessions available in the index, keyed by session ID. */
  readonly sessions: ReadonlyMap<string, ScorableSession>;
  /** Novelty slider in [0,1]; default 0.5. */
  readonly novelty?: number | undefined;
  readonly limit?: number | undefined;
  readonly seed?: number | undefined;
  readonly config?: Partial<Omit<ScoringConfig, 'weights'>> & {
    readonly weights?: Partial<ScoreWeights>;
  };
  /** Optional semantic similarity in [0,1] (e.g. embedding cosine). Defaults to token Jaccard. */
  readonly similarity?: SessionSimilarity | undefined;
}

export interface ScoreBridgesResult {
  readonly catalogVersion: string;
  readonly bridges: Bridge[];
  readonly noMatch: boolean;
  readonly degraded: boolean;
  readonly algorithmVersion: string;
  /** Effective configuration used for this run (weights are the slider-adjusted, normalized ones). */
  readonly config: {
    readonly scoring: ScoringConfig;
    readonly effectiveWeights: ScoreWeights;
    readonly novelty: number;
    readonly limit: number;
    readonly seed: number;
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

const STOP_WORDS = new Set(
  (
    'the and for with from that this these those into onto over under about your you our their ' +
    'are was were will can how what why when where which who using use used build building ' +
    'session sessions learn aws amazon more most best new not but all any has have its via per'
  ).split(' '),
);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (t.length >= 3 && !STOP_WORDS.has(t)) out.add(t);
  }
  return out;
}

const sessionText = (s: ScorableSession): string =>
  [s.title, s.abstract, s.track ?? '', ...s.topics].join(' ');

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** FNV-1a hash used only for seeded, deterministic tie-breaking. */
function tieHash(seed: number, id: string): number {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Build a short excerpt (a real substring of `text`) around `term`. */
function excerptFor(text: string, term: string): string | undefined {
  const idx = text.toLowerCase().indexOf(term);
  if (idx < 0) return undefined;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + term.length + 40);
  const ex = text.slice(start, end).trim();
  return ex.length > 0 ? ex : undefined;
}

function findEvidence(s: ScorableSession, terms: readonly string[]): Evidence | undefined {
  for (const term of terms) {
    for (const field of ['title', 'abstract'] as const) {
      const excerpt = excerptFor(s[field], term);
      if (excerpt) return { sessionId: s.sessionId, field, excerpt };
    }
  }
  return undefined;
}

function completeness(s: ScorableSession): number {
  const present = [
    s.title.trim().length > 0,
    s.abstract.trim().length > 0,
    !!s.track,
    s.topics.length > 0,
    !!s.level,
    !!s.format,
    !!s.startsAt,
    !!s.venue,
    !!s.officialUrl,
  ];
  return present.filter(Boolean).length / present.length;
}

/** Apply the novelty slider to the base weights, then renormalize to sum 1. */
export function effectiveWeights(base: ScoreWeights, novelty: number): ScoreWeights {
  const n = clamp01(novelty);
  const novMul = 0.4 + 1.2 * n; // 0.4 .. 1.6, 1.0 at n=0.5
  const relMul = 1.3 - 0.6 * n; // 1.3 .. 0.7, 1.0 at n=0.5
  const raw = {
    relevance: Math.max(0, base.relevance) * relMul,
    bridgeStrength: Math.max(0, base.bridgeStrength) * relMul,
    novelty: Math.max(0, base.novelty) * novMul,
    diversity: Math.max(0, base.diversity),
    quality: Math.max(0, base.quality),
  };
  const sum = raw.relevance + raw.bridgeStrength + raw.novelty + raw.diversity + raw.quality;
  if (sum <= 0) return DEFAULT_WEIGHTS;
  return {
    relevance: raw.relevance / sum,
    bridgeStrength: raw.bridgeStrength / sum,
    novelty: raw.novelty / sum,
    diversity: raw.diversity / sum,
    quality: raw.quality / sum,
  };
}

/* ------------------------------------------------------------------ */
/* Candidate generation                                                */
/* ------------------------------------------------------------------ */

interface Candidate {
  readonly id: string;
  readonly sessions: readonly ScorableSession[];
  readonly relationship: Relationship;
  readonly relevance: number;
  readonly bridgeStrength: number;
  readonly novelty: number;
  readonly quality: number;
  readonly evidence: readonly Evidence[];
}

const bridgeId = (ids: readonly string[]): string => `bridge:${[...ids].sort().join('|')}`;

/** Score candidates and apply hard gates, MMR rerank, and the novelty slider. */
export function scoreBridges(input: ScoreBridgesInput): ScoreBridgesResult {
  const scoring: ScoringConfig = {
    ...DEFAULT_SCORING_CONFIG,
    ...input.config,
    weights: { ...DEFAULT_WEIGHTS, ...input.config?.weights },
  };
  const novelty = clamp01(input.novelty ?? 0.5);
  const seed = input.seed ?? 0;
  const limit = Math.max(1, Math.floor(input.limit ?? scoring.defaultLimit));
  const weights = effectiveWeights(scoring.weights, novelty);

  const simCache = new Map<string, number>();
  const tokenCache = new Map<string, Set<string>>();
  const tokensOf = (s: ScorableSession): Set<string> => {
    let t = tokenCache.get(s.sessionId);
    if (!t) {
      t = tokenize(sessionText(s));
      tokenCache.set(s.sessionId, t);
    }
    return t;
  };
  const sim = (a: ScorableSession, b: ScorableSession): number => {
    if (a.sessionId === b.sessionId) return 1;
    const key =
      a.sessionId < b.sessionId ? `${a.sessionId}|${b.sessionId}` : `${b.sessionId}|${a.sessionId}`;
    let v = simCache.get(key);
    if (v === undefined) {
      v = clamp01(input.similarity ? input.similarity(a, b) : jaccard(tokensOf(a), tokensOf(b)));
      simCache.set(key, v);
    }
    return v;
  };

  const degraded = input.retrievals.some((r) => r.lexicalOnly);
  const base = {
    catalogVersion: input.catalogVersion,
    degraded,
    algorithmVersion: ALGORITHM_VERSION,
    config: { scoring, effectiveWeights: weights, novelty, limit, seed },
  };
  const none = (): ScoreBridgesResult => ({ ...base, bridges: [], noMatch: true });

  if (input.retrievals.length < 1 || input.retrievals.length > 2) return none();

  // Only indexed sessions are eligible (provenance check).
  const pool = (r: TopicRetrieval): { s: ScorableSession; c: RetrievedCandidate }[] =>
    r.candidates
      .filter((c) => c.relevance >= scoring.minRelevance)
      .slice(0, scoring.maxCandidatesPerTopic)
      .flatMap((c) => {
        const s = input.sessions.get(c.sessionId);
        return s ? [{ s, c }] : [];
      });

  const queryTokens = new Set<string>();
  for (const r of input.retrievals) for (const t of tokenize(r.topic)) queryTokens.add(t);

  const candidates = new Map<string, Candidate>();

  const makePair = (
    a: ScorableSession,
    b: ScorableSession,
    relevance: number,
  ): Candidate | undefined => {
    if (a.sessionId === b.sessionId) return undefined;
    const shared = [...tokensOf(a)].filter((t) => tokensOf(b).has(t) && !queryTokens.has(t)).sort();
    if (shared.length === 0) return undefined;
    const ea = findEvidence(a, shared);
    const eb = findEvidence(b, shared);
    if (!ea || !eb) return undefined;
    const similarity = sim(a, b);
    const bridgeStrength = clamp01(0.6 * Math.min(1, shared.length / 3) + 0.4 * similarity);
    const clusterDiff = a.track && b.track ? (a.track === b.track ? 0 : 1) : 0.5;
    // Novelty: topic-cluster distance balanced with semantic distance; unrelated outliers are
    // penalized by scaling with bridge strength.
    const rawNovelty = 0.5 * clusterDiff + 0.5 * (1 - similarity);
    const noveltyScore = clamp01(rawNovelty * (0.5 + 0.5 * bridgeStrength));
    const evidence = [ea, eb];
    const coverage = Math.min(1, evidence.length / 2);
    const quality = clamp01(0.5 * ((completeness(a) + completeness(b)) / 2) + 0.5 * coverage);
    return {
      id: bridgeId([a.sessionId, b.sessionId]),
      sessions: [a, b],
      relationship: shared.length >= 2 ? 'shared-concept' : 'inferred-bridge',
      relevance,
      bridgeStrength,
      novelty: noveltyScore,
      quality,
      evidence,
    };
  };

  if (input.retrievals.length === 2) {
    const [ra, rb] = input.retrievals as [TopicRetrieval, TopicRetrieval];
    const poolA = pool(ra);
    const poolB = pool(rb);
    const relB = new Map(poolB.map((x) => [x.s.sessionId, x]));
    for (const x of poolA) {
      // A session that satisfies both topics is a single-session topic-match bridge.
      const both = relB.get(x.s.sessionId);
      if (both) {
        const relevance = Math.min(x.c.relevance, both.c.relevance);
        const ev = findEvidence(x.s, [...queryTokens].sort());
        if (ev) {
          candidates.set(bridgeId([x.s.sessionId]), {
            id: bridgeId([x.s.sessionId]),
            sessions: [x.s],
            relationship: 'topic-match',
            relevance,
            bridgeStrength: relevance,
            novelty: 0,
            quality: clamp01(0.5 * completeness(x.s) + 0.5),
            evidence: [ev],
          });
        }
      }
      for (const y of poolB) {
        const c = makePair(x.s, y.s, Math.min(x.c.relevance, y.c.relevance));
        if (c) candidates.set(c.id, c);
      }
    }
  } else {
    const p = pool(input.retrievals[0] as TopicRetrieval);
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) {
        const x = p[i] as (typeof p)[number];
        const y = p[j] as (typeof p)[number];
        const c = makePair(x.s, y.s, Math.min(x.c.relevance, y.c.relevance));
        if (c) candidates.set(c.id, c);
      }
    }
  }

  // Hard gates: relevance floor, bridge strength floor, evidence count for pairs.
  const qualified = [...candidates.values()].filter(
    (c) =>
      c.relevance >= scoring.minRelevance &&
      c.bridgeStrength >= scoring.minBridgeStrength &&
      (c.sessions.length < 2 ||
        (c.evidence.length >= scoring.minEvidenceCount &&
          new Set(c.evidence.map((e) => e.sessionId)).size === c.sessions.length)),
  );
  if (qualified.length === 0) return none();

  const candidateSim = (c: Candidate, d: Candidate): number => {
    let m = 0;
    for (const x of c.sessions) for (const y of d.sessions) m = Math.max(m, sim(x, y));
    return m;
  };

  // Greedy MMR: diversity is the marginal gain versus already selected bridges.
  const selected: { cand: Candidate; components: ScoreComponents; score: number }[] = [];
  const remaining = [...qualified].sort((a, b) => a.id.localeCompare(b.id));
  const round = (n: number): number => Math.round(n * 1e12) / 1e12;
  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = -1;
    let best: { components: ScoreComponents; score: number } | undefined;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i] as Candidate;
      const diversity =
        selected.length === 0
          ? 1
          : clamp01(1 - Math.max(...selected.map((s) => candidateSim(c, s.cand))));
      const components: ScoreComponents = {
        relevance: clamp01(c.relevance),
        bridgeStrength: clamp01(c.bridgeStrength),
        novelty: clamp01(c.novelty),
        diversity,
        quality: clamp01(c.quality),
      };
      const score = clamp01(
        weights.relevance * components.relevance +
          weights.bridgeStrength * components.bridgeStrength +
          weights.novelty * components.novelty +
          weights.diversity * components.diversity +
          weights.quality * components.quality,
      );
      const better = (() => {
        if (!best) return true;
        if (round(score) !== round(best.score)) return score > best.score;
        const cur = remaining[bestIdx] as Candidate;
        const hc = tieHash(seed, c.id);
        const hb = tieHash(seed, cur.id);
        return hc !== hb ? hc < hb : c.id < cur.id;
      })();
      if (better) {
        best = { components, score };
        bestIdx = i;
      }
    }
    if (!best) break;
    const [cand] = remaining.splice(bestIdx, 1) as [Candidate];
    selected.push({ cand, ...best });
  }

  const bridges: Bridge[] = selected.map(({ cand, components, score }) => ({
    id: cand.id,
    sessionIds: cand.sessions.map((s) => s.sessionId),
    relationship: cand.relationship,
    score,
    scoreComponents: components,
    evidence: [...cand.evidence],
  }));

  return { ...base, bridges, noMatch: bridges.length === 0 };
}
