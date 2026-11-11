import { describe, expect, it } from 'vitest';
import { calibrateThresholds } from './calibration.js';
import { GOLDEN_CASES } from './golden-cases.js';
import { runEvaluation } from './harness.js';
import { renderCalibrationReport, renderEvaluationReport } from './report.js';

describe('golden cases', () => {
  it('has at least 20 pairs covering every required category', () => {
    expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(20);
    const cats = new Set(GOLDEN_CASES.map((c) => c.category));
    for (const c of ['irrelevant', 'ambiguous', 'adversarial', 'no-match']) {
      expect(cats.has(c as never)).toBe(true);
    }
    expect(new Set(GOLDEN_CASES.map((c) => c.id)).size).toBe(GOLDEN_CASES.length);
  });
});

describe('evaluation harness', () => {
  it('is deterministic apart from latency and reports all metrics', () => {
    const strip = (r: ReturnType<typeof runEvaluation>) =>
      r.results.map((x) => ({ ...x, latencyMs: 0 }));
    const a = runEvaluation({ now: () => 0 });
    const b = runEvaluation({ now: () => 0 });
    expect(strip(a)).toEqual(strip(b));
    const s = a.summary;
    expect(s.caseCount).toBe(GOLDEN_CASES.length);
    expect(s.grounding).toBe(1);
    expect(s.latencyP95Ms).toBe(0);
  });
});

describe('threshold calibration', () => {
  it('recommends thresholds with no false bridges on no-match cases', () => {
    const report = calibrateThresholds();
    expect(report.recommended).toBeDefined();
    expect(report.recommendedSummary?.falseBridgeRate).toBe(0);
    expect(report.recommendedSummary?.grounding).toBe(1);
    const md = renderCalibrationReport(report);
    expect(md).toContain('R_min=');
    expect(renderEvaluationReport(runEvaluation({ thresholds: report.recommended! }))).toContain(
      '## Cases',
    );
  });
});
