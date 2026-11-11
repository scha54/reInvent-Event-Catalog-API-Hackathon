/**
 * Threshold calibration for `R_min` and `B_min` (FR-04 4.2, AI 20.5).
 * Sweeps a grid over the labeled set and selects the pair that never returns
 * a bridge for a no-match case, then maximizes outcome accuracy and relevance.
 */
import {
  runEvaluation,
  type EvaluationSummary,
  type HarnessOptions,
  type Thresholds,
} from './harness.js';

export interface CalibrationOptions extends Omit<HarnessOptions, 'thresholds'> {
  readonly rMinGrid?: readonly number[];
  readonly bMinGrid?: readonly number[];
  /** Maximum tolerated false-bridge rate on no-match cases. Default 0. */
  readonly maxFalseBridgeRate?: number;
}

export interface CalibrationReport {
  readonly grid: readonly EvaluationSummary[];
  readonly recommended: Thresholds | undefined;
  readonly recommendedSummary: EvaluationSummary | undefined;
  readonly maxFalseBridgeRate: number;
}

const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
};

export const DEFAULT_R_MIN_GRID = range(0.2, 0.6, 0.05);
export const DEFAULT_B_MIN_GRID = range(0.1, 0.6, 0.05);

export function calibrateThresholds(options: CalibrationOptions = {}): CalibrationReport {
  const {
    rMinGrid = DEFAULT_R_MIN_GRID,
    bMinGrid = DEFAULT_B_MIN_GRID,
    maxFalseBridgeRate = 0,
    ...rest
  } = options;
  const grid: EvaluationSummary[] = [];
  for (const rMin of rMinGrid) {
    for (const bMin of bMinGrid) {
      grid.push(runEvaluation({ ...rest, thresholds: { rMin, bMin } }).summary);
    }
  }
  let best: EvaluationSummary | undefined;
  for (const s of grid) {
    if (s.falseBridgeRate > maxFalseBridgeRate) continue;
    if (
      !best ||
      s.outcomeAccuracy > best.outcomeAccuracy ||
      (s.outcomeAccuracy === best.outcomeAccuracy && s.relevance > best.relevance)
    ) {
      best = s;
    }
  }
  return { grid, recommended: best?.thresholds, recommendedSummary: best, maxFalseBridgeRate };
}
