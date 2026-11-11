import { describe, expect, it } from 'vitest';
import type { Session } from '@serendipity/packages-contracts';
import { buildFallbackExplanation, validateExplanation } from './explanation-validator.js';

const session = (id: string, title: string, abstract: string): Session => ({
  eventId: 'e',
  sessionId: id,
  catalogVersion: 'v1',
  title,
  abstract,
  topics: ['serverless'],
  sourceHash: 'h',
  ingestedAt: 't',
  searchableText: `${title} ${abstract}`,
});

const sessions = [
  session('s1', 'Serverless at scale', 'Build event-driven apps. Cut idle compute.'),
  session('s2', 'Green cloud', 'Measure carbon footprint of workloads.'),
];
const ctx = { sessions };

const good = {
  status: 'supported',
  headline: 'h',
  connection: 'A possible connection is ...',
  observedEvidence: [
    { sessionId: 's1', field: 'abstract', excerpt: 'Cut idle compute' },
    { sessionId: 's2', field: 'title', excerpt: 'Green cloud' },
  ],
  inference: 'i',
  uncertainty: 'Thematic inference.',
};

const issueCodes = (r: ReturnType<typeof validateExplanation>) =>
  r.ok ? [] : r.issues.map((i) => i.code);

describe('validateExplanation', () => {
  it('accepts grounded output, as object or JSON text', () => {
    expect(validateExplanation(good, ctx).ok).toBe(true);
    expect(validateExplanation(JSON.stringify(good), ctx).ok).toBe(true);
  });

  it('accepts schema-valid insufficient_evidence', () => {
    expect(validateExplanation({ status: 'insufficient_evidence' }, ctx).ok).toBe(true);
  });

  it('rejects invalid JSON and schema violations', () => {
    expect(issueCodes(validateExplanation('not json', ctx))).toEqual(['invalid_json']);
    expect(issueCodes(validateExplanation({ status: 'supported' }, ctx))).toEqual(['schema']);
  });

  it('rejects fabricated session IDs', () => {
    const bad = {
      ...good,
      observedEvidence: [
        ...good.observedEvidence,
        { sessionId: 'zz', field: 'title', excerpt: 'x' },
      ],
    };
    expect(issueCodes(validateExplanation(bad, ctx))).toContain('unknown_session');
  });

  it('rejects excerpts not found in the cited field', () => {
    const bad = {
      ...good,
      observedEvidence: [
        { sessionId: 's1', field: 'title', excerpt: 'Cut idle compute' },
        good.observedEvidence[1],
      ],
    };
    expect(issueCodes(validateExplanation(bad, ctx))).toContain('excerpt_mismatch');
  });

  it('requires two cited IDs unless single-session is declared', () => {
    const one = { ...good, observedEvidence: [good.observedEvidence[0]] };
    expect(issueCodes(validateExplanation(one, ctx))).toContain('insufficient_citations');
    expect(validateExplanation(one, { ...ctx, singleSessionRelationship: true }).ok).toBe(true);
  });

  it('requires a non-blank uncertainty statement', () => {
    expect(issueCodes(validateExplanation({ ...good, uncertainty: '   ' }, ctx))).toContain(
      'missing_uncertainty',
    );
  });
});

describe('buildFallbackExplanation', () => {
  it('is deterministic and passes the validator', () => {
    const a = buildFallbackExplanation(ctx);
    expect(buildFallbackExplanation(ctx)).toEqual(a);
    expect(a.status).toBe('supported');
    expect(validateExplanation(a, ctx).ok).toBe(true);
  });

  it('returns insufficient_evidence when records cannot support a claim', () => {
    expect(buildFallbackExplanation({ sessions: [sessions[0]!] }).status).toBe(
      'insufficient_evidence',
    );
    expect(buildFallbackExplanation({ sessions: [] }).status).toBe('insufficient_evidence');
  });

  it('supports a declared single-session relationship', () => {
    const single = { sessions: [sessions[0]!], singleSessionRelationship: true };
    const e = buildFallbackExplanation(single);
    expect(validateExplanation(e, single).ok).toBe(true);
  });
});
