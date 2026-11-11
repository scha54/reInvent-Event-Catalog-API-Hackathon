/** Writes the calibration and evaluation reports: `npm run report -w @serendipity/packages-evaluation`. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { calibrateThresholds } from './calibration.js';
import { runEvaluation } from './harness.js';
import { renderCalibrationReport, renderEvaluationReport } from './report.js';

const outDir = new URL('../reports/', import.meta.url);
mkdirSync(outDir, { recursive: true });

const calibration = calibrateThresholds();
writeFileSync(new URL('calibration.md', outDir), renderCalibrationReport(calibration));
const run = runEvaluation(calibration.recommended ? { thresholds: calibration.recommended } : {});
writeFileSync(new URL('evaluation.md', outDir), renderEvaluationReport(run));
console.log(`Reports written to ${outDir.pathname}`);
