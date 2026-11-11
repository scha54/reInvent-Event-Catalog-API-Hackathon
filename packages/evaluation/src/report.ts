/** Markdown report generation for evaluation runs and threshold calibration. */
import type { CalibrationReport } from './calibration.js';
import type { EvaluationRun, EvaluationSummary } from './harness.js';

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function summaryRows(s: EvaluationSummary): string[] {
  return [
    `| Outcome accuracy | ${pct(s.outcomeAccuracy)} |`,
    `| False-bridge rate (no-match cases) | ${pct(s.falseBridgeRate)} |`,
    `| Missed-bridge rate (bridge cases) | ${pct(s.missedBridgeRate)} |`,
    `| Relevance (bridge precision) | ${pct(s.relevance)} |`,
    `| Novelty (mean component) | ${s.novelty.toFixed(3)} |`,
    `| Grounding (evidence excerpts verified) | ${pct(s.grounding)} |`,
    `| Diversity (distinct sessions) | ${pct(s.diversity)} |`,
    `| Latency p50 / p95 | ${s.latencyP50Ms.toFixed(2)} ms / ${s.latencyP95Ms.toFixed(2)} ms |`,
    `| Estimated explanation cost (total / per case) | $${s.totalCostUsd.toFixed(5)} / $${s.meanCostUsd.toFixed(5)} |`,
  ];
}

export function renderEvaluationReport(run: EvaluationRun): string {
  const { summary: s, results } = run;
  const lines = [
    '# Evaluation report',
    '',
    `Thresholds: R_min=${s.thresholds.rMin}, B_min=${s.thresholds.bMin}. Cases: ${s.caseCount}.`,
    '',
    '| Metric | Value |',
    '|---|---|',
    ...summaryRows(s),
    '',
    '## Cases',
    '',
    '| Case | Category | Expected | Result | Bridges | OK |',
    '|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.caseId} | ${r.category} | ${r.expectBridge ? 'bridge' : 'no-match'} | ${r.noMatch ? 'no-match' : 'bridge'} | ${r.bridges.length} | ${r.correct ? 'yes' : 'NO'} |`,
    ),
    '',
    'Grounding is verified programmatically against cited session fields. Human grounding and meaningful-surprise ratings are still required before release.',
    '',
  ];
  return lines.join('\n');
}

export function renderCalibrationReport(report: CalibrationReport): string {
  const lines = ['# Threshold calibration report', ''];
  if (!report.recommended || !report.recommendedSummary) {
    lines.push(
      `No threshold pair met the false-bridge limit of ${pct(report.maxFalseBridgeRate)}. Revisit labels or scoring.`,
      '',
    );
    return lines.join('\n');
  }
  const r = report.recommended;
  lines.push(
    `Recommended: **R_min=${r.rMin}**, **B_min=${r.bMin}** (max false-bridge rate ${pct(report.maxFalseBridgeRate)}, then highest accuracy and relevance).`,
    '',
    '| Metric | Value |',
    '|---|---|',
    ...summaryRows(report.recommendedSummary),
    '',
    'Weights and thresholds are tuned on a small synthetic labeled set and are not statistically validated.',
    '',
    '## Grid (eligible pairs only)',
    '',
    '| R_min | B_min | Accuracy | False-bridge | Missed | Relevance |',
    '|---|---|---|---|---|---|',
    ...report.grid
      .filter((g) => g.falseBridgeRate <= report.maxFalseBridgeRate)
      .map(
        (g) =>
          `| ${g.thresholds.rMin} | ${g.thresholds.bMin} | ${pct(g.outcomeAccuracy)} | ${pct(g.falseBridgeRate)} | ${pct(g.missedBridgeRate)} | ${pct(g.relevance)} |`,
      ),
    '',
  );
  return lines.join('\n');
}
