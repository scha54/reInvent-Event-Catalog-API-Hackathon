/**
 * Evaluation harness: runs golden cases through the real retrieval and bridge
 * scoring code and aggregates quality metrics (AI 20.5, 20.6, FR-04 4.2).
 */
import type { Bridge } from '@serendipity/packages-contracts';
import {
  DEFAULT_SCORING_CONFIG,
  retrieveForTopics,
  scoreBridges,
  type RetrievalIndex,
  type ScorableSession,
  type ScoringConfig,
} from '@serendipity/packages-discovery';
import { EVAL_CATALOG_VERSION, EVAL_SESSIONS } from './catalog.js';
import { GOLDEN_CASES, type GoldenCase, type GoldenCategory } from './golden-cases.js';
import { buildLexicalIndex } from './lexical-index.js';
import {
  DEFAULT_COST_MODEL,
  estimateCaseCostUsd,
  groundingRate,
  mean,
  meanNovelty,
  percentile,
  relevancePrecision,
  resultDiversity,
  type CostModel,
} from './metrics.js';

export interface Thresholds {
  readonly rMin: number;
  readonly bMin: number;
}

export interface HarnessOptions {
  readonly cases?: readonly GoldenCase[];
  readonly sessions?: readonly ScorableSession[];
  readonly catalogVersion?: string;
  readonly thresholds?: Thresholds;
  readonly novelty?: number;
  readonly seed?: number;
  readonly costModel?: CostModel;
  /** Injectable clock in ms (defaults to `performance.now`). */
  readonly now?: () => number;
  readonly index?: RetrievalIndex;
}

export interface CaseResult {
  readonly caseId: string;
  readonly category: GoldenCategory;
  readonly expectBridge: boolean;
  readonly noMatch: boolean;
  /** Behavior matches the label (bridge returned iff expected). */
  readonly correct: boolean;
  readonly bridges: readonly Bridge[];
  readonly relevance: number;
  readonly novelty: number;
  readonly grounded: number;
  readonly groundedTotal: number;
  readonly diversity: number;
  readonly latencyMs: number;
  readonly costUsd: number;
}

export interface EvaluationSummary {
  readonly thresholds: Thresholds;
  readonly caseCount: number;
  /** Fraction of cases whose bridge/no-match outcome matches the label. */
  readonly outcomeAccuracy: number;
  /** Share of no-match-labeled cases that wrongly returned a bridge. */
  readonly falseBridgeRate: number;
  /** Share of bridge-labeled cases that wrongly returned no-match. */
  readonly missedBridgeRate: number;
  /** Mean precision over bridge-labeled cases that returned bridges. */
  readonly relevance: number;
  readonly novelty: number;
  /** Grounded evidence share across all returned evidence (1 when none returned). */
  readonly grounding: number;
  readonly diversity: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly totalCostUsd: number;
  readonly meanCostUsd: number;
}

export interface EvaluationRun {
  readonly summary: EvaluationSummary;
  readonly results: readonly CaseResult[];
}

export function runEvaluation(options: HarnessOptions = {}): EvaluationRun {
  const cases = options.cases ?? GOLDEN_CASES;
  const sessionList = options.sessions ?? EVAL_SESSIONS;
  const sessions = new Map(sessionList.map((s) => [s.sessionId, s]));
  const index = options.index ?? buildLexicalIndex(sessionList);
  const thresholds: Thresholds = options.thresholds ?? {
    rMin: DEFAULT_SCORING_CONFIG.minRelevance,
    bMin: DEFAULT_SCORING_CONFIG.minBridgeStrength,
  };
  const costModel = options.costModel ?? DEFAULT_COST_MODEL;
  const now = options.now ?? (() => performance.now());
  const config: Partial<ScoringConfig> = {
    minRelevance: thresholds.rMin,
    minBridgeStrength: thresholds.bMin,
  };

  const results: CaseResult[] = cases.map((c) => {
    const t0 = now();
    const retrievals = retrieveForTopics(
      index,
      c.topics.map((topic) => ({ topic })),
      { minRelevance: thresholds.rMin },
    );
    const scored = scoreBridges({
      catalogVersion: options.catalogVersion ?? EVAL_CATALOG_VERSION,
      retrievals,
      sessions,
      novelty: options.novelty,
      seed: options.seed ?? 0,
      config,
    });
    const latencyMs = Math.max(0, now() - t0);
    const g = groundingRate(scored.bridges, sessions);
    return {
      caseId: c.id,
      category: c.category,
      expectBridge: c.expectBridge,
      noMatch: scored.noMatch,
      correct: c.expectBridge ? !scored.noMatch : scored.noMatch,
      bridges: scored.bridges,
      relevance: relevancePrecision(scored.bridges, new Set(c.relevantSessionIds)),
      novelty: meanNovelty(scored.bridges),
      grounded: g.grounded,
      groundedTotal: g.total,
      diversity: resultDiversity(scored.bridges),
      latencyMs,
      costUsd: estimateCaseCostUsd(scored.bridges, costModel),
    };
  });

  return { summary: summarize(results, thresholds), results };
}

export function summarize(
  results: readonly CaseResult[],
  thresholds: Thresholds,
): EvaluationSummary {
  const expectNone = results.filter((r) => !r.expectBridge);
  const expectSome = results.filter((r) => r.expectBridge);
  const returned = results.filter((r) => r.bridges.length > 0);
  const groundedTotal = results.reduce((a, r) => a + r.groundedTotal, 0);
  const grounded = results.reduce((a, r) => a + r.grounded, 0);
  const cost = results.reduce((a, r) => a + r.costUsd, 0);
  const lat = results.map((r) => r.latencyMs);
  const labeledReturned = returned.filter((r) => r.expectBridge);
  return {
    thresholds,
    caseCount: results.length,
    outcomeAccuracy:
      results.length === 0 ? 0 : results.filter((r) => r.correct).length / results.length,
    falseBridgeRate:
      expectNone.length === 0 ? 0 : expectNone.filter((r) => !r.noMatch).length / expectNone.length,
    missedBridgeRate:
      expectSome.length === 0 ? 0 : expectSome.filter((r) => r.noMatch).length / expectSome.length,
    relevance: mean(labeledReturned.map((r) => r.relevance)),
    novelty: mean(returned.map((r) => r.novelty)),
    grounding: groundedTotal === 0 ? 1 : grounded / groundedTotal,
    diversity: mean(returned.map((r) => r.diversity)),
    latencyP50Ms: percentile(lat, 50),
    latencyP95Ms: percentile(lat, 95),
    totalCostUsd: cost,
    meanCostUsd: results.length === 0 ? 0 : cost / results.length,
  };
}
