import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SessionSchema } from '@serendipity/packages-contracts';
import { computeSourceHash, normalizeSession, stripMarkup } from './normalize.js';

const ctx = { eventId: 'evt', catalogVersion: 'v1', ingestedAt: '2026-01-01T00:00:00.000Z' };

function fixture(name: string): { items: unknown[] } {
  return JSON.parse(
    readFileSync(new URL(`../../../fixtures/events-api/${name}`, import.meta.url), 'utf8').replace(
      /^\uFEFF/,
      '',
    ),
  );
}

describe('normalizeSession', () => {
  it('maps a fully populated fixture record and preserves the source ID', () => {
    const [raw] = fixture('sessions.page-1.json').items;
    const res = normalizeSession(raw, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const s = res.session;
    expect(SessionSchema.safeParse(s).success).toBe(true);
    expect(s.sessionId).toBe('SYN-0001');
    expect(s.track).toBe('Synthetic Track AI');
    expect(s.format).toBe('Chalk talk');
    expect(s.level).toBe('300 - Advanced');
    expect(s.venue).toBe('Synthetic Venue A, Room 101');
    expect(s.startsAt).toBe('2026-12-01T16:00:00-08:00');
    expect(s.endsAt).toBe('2026-12-01T17:00:00-08:00');
    expect(s.officialUrl).toBeUndefined();
    expect(s.searchableText).toBe(
      [
        'Title: Synthetic: Building RAG with managed vector stores',
        'Abstract: Synthetic abstract about retrieval augmented generation.',
        'Tags: Synthetic Track AI; Artificial Intelligence; Generative AI; Data; Amazon Bedrock',
      ].join('\n'),
    );
  });

  it('does not fabricate absent fields', () => {
    const raw = fixture('sessions.page-1.json').items[1];
    const res = normalizeSession(raw, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const s = res.session;
    expect(s.abstract).toBe('');
    expect(s.venue).toBeUndefined();
    expect(s.startsAt).toBe('2026-12-01T09:30');
    expect(s.endsAt).toBe('2026-12-01T11:30');
    expect(s.searchableText).not.toContain('Abstract:');
    expect(s.searchableText.startsWith('Title: ')).toBe(true);
  });

  it('strips markup safely', () => {
    expect(
      stripMarkup('<p>Hi <b>there</b></p><script>alert(1)</script> &amp; &lt;i&gt;x&lt;/i&gt;'),
    ).toBe('Hi there &amp; x'.replace('&amp;', '&'));
    expect(stripMarkup('a <unclosed')).toBe('a');
  });

  it('quarantines invalid records instead of throwing', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'x',
      {},
      { sessionId: 'a' },
      { sessionId: ' ', title: 't' },
      { sessionId: 'a', title: '<br>' },
    ]) {
      const res = normalizeSession(bad, ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.quarantine.reason.length).toBeGreaterThan(0);
    }
    const res = normalizeSession({ sessionId: 'keep-me', title: 3 }, ctx);
    expect(res.ok === false && res.quarantine.rawRef).toBe('keep-me');
  });

  it('hashes deterministically regardless of key order', () => {
    expect(computeSourceHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      computeSourceHash({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });
});
