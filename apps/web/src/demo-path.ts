/**
 * Scripted demo path (FR-12 12.1, 12.3). Pure data and helpers: the guide only drives the
 * real UI and API. It never supplies results of its own, so nothing shown is fabricated.
 */
import { DEMO_EXAMPLES, type DemoExample } from './demo-examples';

/** Requirement 12.3: the whole path must fit in under three minutes. */
export const DEMO_BUDGET_SECONDS = 180;

export interface DemoStep {
  readonly id: string;
  readonly title: string;
  readonly instruction: string;
  /** Suggested time on this step. */
  readonly seconds: number;
  /** When set, the step can run this prevalidated topic pair against the live API. */
  readonly example?: DemoExample;
}

function example(id: string): DemoExample {
  const found = DEMO_EXAMPLES.find((e) => e.id === id);
  if (!found) throw new Error(`Unknown demo example: ${id}`);
  return found;
}

export const DEMO_STEPS: readonly DemoStep[] = [
  {
    id: 'snapshot',
    title: 'Check the catalog snapshot',
    instruction:
      'Note the catalog version and freshness in Catalog status. Every result is tied to that real snapshot.',
    seconds: 15,
  },
  {
    id: 'discover',
    title: 'Discover a connection',
    instruction:
      'Run Serverless + Sustainability. Ranked connections appear with score breakdowns.',
    seconds: 25,
    example: example('serverless-sustainability'),
  },
  {
    id: 'evidence',
    title: 'Inspect the evidence',
    instruction:
      'Open the top connection. Compare Observed evidence (catalog text) with Inferred connection (interpretation).',
    seconds: 35,
  },
  {
    id: 'graph',
    title: 'Explore the graph',
    instruction:
      'Use the graph, or its list view, to see how topics link to sessions. Select a session node to open its details.',
    seconds: 25,
  },
  {
    id: 'quest',
    title: 'Plan a quest',
    instruction:
      'In the connection details, choose Plan a quest to get 2-4 sessions with conflict and schedule badges.',
    seconds: 30,
  },
  {
    id: 'second-pair',
    title: 'Try another pairing',
    instruction: 'Run Security + AI to see a different, independently scored result.',
    seconds: 20,
    example: example('security-ai'),
  },
  {
    id: 'no-match',
    title: 'See an honest no-match',
    instruction:
      'Run the unsupported pairing. The engine reports no credible bridge instead of forcing one.',
    seconds: 20,
    example: example('unsupported-pairing'),
  },
];

export function totalDemoSeconds(steps: readonly DemoStep[] = DEMO_STEPS): number {
  return steps.reduce((sum, s) => sum + s.seconds, 0);
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Clamp a step index into range. */
export function clampStep(index: number, steps: readonly DemoStep[] = DEMO_STEPS): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(steps.length - 1, Math.max(0, Math.trunc(index)));
}
