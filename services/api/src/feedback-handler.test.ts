import { describe, expect, it } from 'vitest';
import { createLogger } from '@serendipity/packages-contracts';
import {
  createApiHandler,
  createFeedbackRoutes,
  InMemoryFeedbackStore,
  type ApiEvent,
} from './index.js';

const NOW = Date.parse('2025-01-01T00:00:00Z');
const ANON = 'abcdefghijklmnop1234';

function setup() {
  const store = new InMemoryFeedbackStore();
  const handler = createApiHandler(
    { allowedOrigins: [], logger: createLogger({ sink: () => undefined }) },
    createFeedbackRoutes({ store, now: () => NOW, ttlSeconds: 100 }),
  );
  const call = async (method: string, path: string, body?: unknown) => {
    const event: ApiEvent = {
      rawPath: path,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.9',
        'user-agent': 'test',
      },
      requestContext: { http: { method } },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await handler(event);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
  };
  return { store, call };
}

const fb = { bridgeId: 'b1', eventId: 'evt', catalogVersion: 'v1', rating: 'up' };

describe('feedback', () => {
  it('stores a minimal record with TTL and no IP or header data', async () => {
    const { store, call } = setup();
    const r = await call('POST', '/api/v1/feedback', { ...fb, anonymousId: ANON });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ anonymousId: ANON, recorded: true });
    const [rec] = [...store.records.values()];
    expect(rec).toEqual({
      pk: `FEEDBACK#${ANON}`,
      sk: '2025-01-01T00:00:00.000Z#b1',
      bridgeId: 'b1',
      eventId: 'evt',
      catalogVersion: 'v1',
      rating: 'up',
      createdAt: '2025-01-01T00:00:00.000Z',
      ttl: NOW / 1000 + 100,
    });
    expect(JSON.stringify(rec)).not.toContain('203.0.113.9');
  });

  it('issues an anonymous ID when none is supplied', async () => {
    const { call } = setup();
    const r = await call('POST', '/api/v1/feedback', fb);
    expect(r.status).toBe(201);
    expect(r.json.anonymousId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it('rejects invalid rating and malformed anonymous ID, storing nothing', async () => {
    const { store, call } = setup();
    expect((await call('POST', '/api/v1/feedback', { ...fb, rating: 'meh' })).status).toBe(400);
    const bad = await call('POST', '/api/v1/feedback', { ...fb, anonymousId: 'short' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('VALIDATION_ERROR');
    expect(store.records.size).toBe(0);
  });

  it('deletes all feedback for an anonymous ID only', async () => {
    const { store, call } = setup();
    await call('POST', '/api/v1/feedback', { ...fb, anonymousId: ANON });
    await call('POST', '/api/v1/feedback', { ...fb, bridgeId: 'b2', anonymousId: ANON });
    await call('POST', '/api/v1/feedback', { ...fb, anonymousId: 'other-anon-id-0000' });
    const r = await call('DELETE', `/api/v1/feedback/${ANON}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ deleted: 2 });
    expect(store.records.size).toBe(1);
    expect((await call('DELETE', '/api/v1/feedback/bad')).status).toBe(400);
  });
});
