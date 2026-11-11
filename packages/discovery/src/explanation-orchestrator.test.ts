import { describe, expect, it } from 'vitest';
import type { Session } from '@serendipity/packages-contracts';
import { TextModelError } from './bedrock-text-client.js';
import {
  ExplanationOrchestrator,
  type ExplainRequest,
  type ExplanationMetric,
  type TextGenerator,
} from './explanation-orchestrator.js';
import { validateExplanation } from './explanation-validator.js';

const session = (id: string, title: string, abstract: string): Session => ({
  eventId: 'e',
  sessionId: id,
  catalogVersion: 'v1',
  title,
  abstract,
  topics: ['t'],
  sourceHash: 'h',
  ingestedAt: 't',
  searchableText: `${title} ${abstract}`,
});

const sessions = [
  session('s1', 'Serverless at scale', 'Cut idle compute.'),
  session('s2', 'Green cloud', 'Measure carbon.'),
];

const req = (bridgeId = 'b1', catalogVersion = 'v1'): ExplainRequest => ({
  bridgeId,
  catalogVersion,
  topics: ['serverless', 'sustainability'],
  relationship: 'inferred-bridge',
  sessions,
  evidence: [],
});

const good = JSON.stringify({
  status: 'supported',
  headline: 'h',
  connection: 'A possible connection is ...',
  observedEvidence: [
    { sessionId: 's1', field: 'title', excerpt: 'Serverless at scale' },
    { sessionId: 's2', field: 'title', excerpt: 'Green cloud' },
  ],
  inference: 'i',
  uncertainty: 'Thematic inference.',
});
const ungrounded = good.replace('Green cloud', 'Invented');

type Step = string | TextModelError;

function setup(steps: Step[], opts: { ttl?: number; threshold?: number; cooldown?: number } = {}) {
  let t = 1000;
  const calls: number[] = [];
  const metrics: ExplanationMetric[] = [];
  const generator: TextGenerator = {
    config: { modelId: 'm1' },
    generate: (prompt) => {
      calls.push(1);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
      if (step instanceof TextModelError) return Promise.reject(step);
      return Promise.resolve({ text: step, modelId: 'm1', promptVersion: prompt.promptVersion });
    },
  };
  const orch = new ExplanationOrchestrator({
    generator,
    metrics: { put: (m) => void metrics.push(m) },
    now: () => t,
    ...(opts.ttl !== undefined ? { cacheTtlMs: opts.ttl } : {}),
    ...(opts.threshold !== undefined ? { failureThreshold: opts.threshold } : {}),
    ...(opts.cooldown !== undefined ? { cooldownMs: opts.cooldown } : {}),
  });
  return { orch, calls, metrics, advance: (ms: number) => (t += ms) };
}

describe('ExplanationOrchestrator', () => {
  it('returns a validated model answer and caches it', async () => {
    const { orch, calls } = setup([good]);
    const first = await orch.explain(req());
    const second = await orch.explain(req());
    expect(first.source).toBe('model');
    expect(second.source).toBe('cache');
    expect(calls).toHaveLength(1);
  });

  it('keys the cache by catalog version and bridge, and expires by TTL', async () => {
    const { orch, calls, advance } = setup([good], { ttl: 100 });
    await orch.explain(req('b1', 'v1'));
    await orch.explain(req('b1', 'v2'));
    await orch.explain(req('b2', 'v1'));
    expect(calls).toHaveLength(3);
    advance(101);
    expect((await orch.explain(req('b1', 'v1'))).source).toBe('model');
    expect(calls).toHaveLength(4);
  });

  it('retries once after a validation failure and accepts a grounded retry', async () => {
    const { orch, calls, metrics } = setup([ungrounded, good]);
    const r = await orch.explain(req());
    expect(r.source).toBe('model');
    expect(calls).toHaveLength(2);
    expect(metrics.map((m) => m.name)).toEqual(['GroundingValidationFailures']);
  });

  it('falls back to a valid template after two validation failures (no third call)', async () => {
    const { orch, calls, metrics } = setup([ungrounded]);
    const r = await orch.explain(req());
    expect(r.source).toBe('fallback');
    expect(r.fallbackReason).toBe('validation_failed');
    expect(calls).toHaveLength(2);
    expect(metrics.filter((m) => m.name === 'GroundingValidationFailures')).toHaveLength(2);
    expect(validateExplanation(r.explanation, { sessions }).ok).toBe(true);
    // Fallbacks are not cached.
    await orch.explain(req());
    expect(calls).toHaveLength(4);
  });

  it('emits a throttle metric and falls back without retrying', async () => {
    const { orch, calls, metrics } = setup([new TextModelError('throttled', 'x')]);
    const r = await orch.explain(req());
    expect(r.fallbackReason).toBe('throttled');
    expect(calls).toHaveLength(1);
    expect(metrics.map((m) => m.name)).toEqual(['BedrockThrottles']);
  });

  it('opens a cooldown after repeated failures, then recovers', async () => {
    const down = new TextModelError('unavailable', 'x');
    const { orch, calls, advance } = setup([down, down, good], { threshold: 2, cooldown: 500 });
    await orch.explain(req('a'));
    await orch.explain(req('b'));
    expect(orch.inCooldown).toBe(true);
    const skipped = await orch.explain(req('c'));
    expect(skipped.fallbackReason).toBe('cooldown');
    expect(calls).toHaveLength(2);
    advance(501);
    expect((await orch.explain(req('c'))).source).toBe('model');
  });

  it('shares one generation across concurrent requests for the same key', async () => {
    const { orch, calls } = setup([good]);
    await Promise.all([orch.explain(req()), orch.explain(req())]);
    expect(calls).toHaveLength(1);
  });
});
