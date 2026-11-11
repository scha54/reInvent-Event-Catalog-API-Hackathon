/**
 * Pure metric functions for the evaluation harness (AI 20.6).
 * Relevance, novelty, grounding, diversity, latency, and cost.
 */
import type { Bridge } from '@serendipity/packages-contracts';
import type { ScorableSession } from '@serendipity/packages-discovery';

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Share of bridges whose sessions are all labeled relevant. 1 for an empty set is NOT assumed: returns 0. */
export function relevancePrecision(
  bridges: readonly Bridge[],
  relevant: ReadonlySet<string>,
): number {
  if (bridges.length === 0) return 0;
  return (
    bridges.filter((b) => b.sessionIds.every((id) => relevant.has(id))).length / bridges.length
  );
}

/** Mean novelty score component of returned bridges. */
export function meanNovelty(bridges: readonly Bridge[]): number {
  return mean(bridges.map((b) => b.scoreComponents.novelty));
}

/**
 * Programmatic grounding: fraction of evidence items whose session resolves,
 * whose cited session is part of the bridge, and whose excerpt is a real
 * substring of the cited field. Human grounding review is still required for
 * explanation claims (see requirements success metrics).
 */
export function groundingRate(
  bridges: readonly Bridge[],
  sessions: ReadonlyMap<string, ScorableSession>,
): { grounded: number; total: number } {
  let grounded = 0;
  let total = 0;
  for (const b of bridges) {
    for (const e of b.evidence) {
      total++;
      const s = sessions.get(e.sessionId);
      if (!s || !b.sessionIds.includes(e.sessionId)) continue;
      const field = e.field === 'title' ? s.title : e.field === 'abstract' ? s.abstract : undefined;
      if (field !== undefined && e.excerpt.length > 0 && field.includes(e.excerpt)) grounded++;
    }
  }
  return { grounded, total };
}

/** Distinct sessions divided by total session slots across the result set (1 = no repetition). */
export function resultDiversity(bridges: readonly Bridge[]): number {
  const slots = bridges.flatMap((b) => b.sessionIds);
  return slots.length === 0 ? 0 : new Set(slots).size / slots.length;
}

/** Nearest-rank percentile; `p` in [0,100]. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] as number;
}

export interface CostModel {
  /** USD per 1,000 input tokens for the explanation model (configurable assumption). */
  readonly inputPer1kTokensUsd: number;
  readonly outputPer1kTokensUsd: number;
  /** Fixed prompt/schema overhead tokens per explanation call. */
  readonly promptOverheadTokens: number;
  readonly outputTokensPerExplanation: number;
  /** Explanations generated per case (the top bridge only, per the design). */
  readonly explanationsPerCase: number;
}

export const DEFAULT_COST_MODEL: CostModel = {
  inputPer1kTokensUsd: 0.0008,
  outputPer1kTokensUsd: 0.004,
  promptOverheadTokens: 400,
  outputTokensPerExplanation: 250,
  explanationsPerCase: 1,
};

/** Estimated explanation cost for one case; ranking itself is deterministic and free of model calls. */
export function estimateCaseCostUsd(bridges: readonly Bridge[], model: CostModel): number {
  const top = bridges[0];
  if (!top || model.explanationsPerCase <= 0) return 0;
  const evidenceChars = top.evidence.reduce((a, e) => a + e.excerpt.length, 0);
  const input = model.promptOverheadTokens + Math.ceil(evidenceChars / 4);
  const perCall =
    (input / 1000) * model.inputPer1kTokensUsd +
    (model.outputTokensPerExplanation / 1000) * model.outputPer1kTokensUsd;
  return perCall * model.explanationsPerCase;
}

export { mean };
