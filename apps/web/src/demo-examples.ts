/**
 * Prevalidated demo topic pairs (FR-12, 12.1). The third pairing is intentionally
 * unsupported by the catalog so the demo shows the honest no-match state.
 */
export interface DemoExample {
  readonly id: string;
  readonly label: string;
  readonly topicA: string;
  readonly topicB: string;
  readonly expectation: 'match' | 'no-match';
}

export const DEMO_EXAMPLES: readonly DemoExample[] = [
  {
    id: 'serverless-sustainability',
    label: 'Serverless + Sustainability',
    topicA: 'serverless',
    topicB: 'sustainability',
    expectation: 'match',
  },
  {
    id: 'security-ai',
    label: 'Security + AI',
    topicA: 'security',
    topicB: 'AI',
    expectation: 'match',
  },
  {
    id: 'unsupported-pairing',
    label: 'Unsupported pairing (no match)',
    topicA: 'medieval falconry',
    topicB: 'quantum knitting',
    expectation: 'no-match',
  },
];
