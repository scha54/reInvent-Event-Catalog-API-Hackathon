import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './api-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('api client', () => {
  it('posts discover requests and validates the response', async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const client = createApiClient({
      baseUrl: 'https://api.example/',
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init };
        return jsonResponse({ catalogVersion: 'v1', bridges: [], noMatch: true });
      },
    });
    const res = await client.discover({ eventId: 'e', topics: ['ab', 'cd'] });
    expect(res.noMatch).toBe(true);
    expect(seen?.url).toBe('https://api.example/api/v1/discover');
    expect(seen?.init?.credentials).toBe('omit');
    expect(seen?.init?.headers).not.toHaveProperty('authorization');
  });

  it('maps the error envelope to ApiError', async () => {
    const client = createApiClient({
      baseUrl: '',
      fetchImpl: async () =>
        jsonResponse({ error: { code: 'THROTTLED', message: 'slow down', requestId: 'r1' } }, 429),
    });
    await expect(client.discover({ eventId: 'e', topics: ['ab'] })).rejects.toMatchObject({
      code: 'THROTTLED',
      status: 429,
      requestId: 'r1',
    });
  });

  it('rejects malformed responses and network failures', async () => {
    const bad = createApiClient({ baseUrl: '', fetchImpl: async () => jsonResponse({ nope: 1 }) });
    await expect(bad.listEvents()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const down = createApiClient({
      baseUrl: '',
      fetchImpl: async () => {
        throw new TypeError('failed');
      },
    });
    await expect(down.listEvents()).rejects.toBeInstanceOf(ApiError);
  });
});
