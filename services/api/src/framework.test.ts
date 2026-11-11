import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLogger, ErrorEnvelopeSchema } from '@serendipity/packages-contracts';
import {
  ApiError,
  createApiHandler,
  defineRoute,
  forbidden,
  notFound,
  serviceUnavailable,
  throttled,
  unauthorized,
  versionConflict,
  type ApiEvent,
} from './index.js';

const ORIGIN = 'https://app.example.com';

function setup(maxBodyBytes = 200) {
  const lines: string[] = [];
  const logger = createLogger({ sink: (l) => lines.push(l) });
  const routes = [
    defineRoute({
      method: 'POST',
      path: '/api/v1/echo/{id}',
      bodySchema: z.object({ name: z.string().min(2) }),
      handler: (ctx) => {
        ctx.annotate({ eventId: 'evt-1', catalogVersion: 'v1' });
        return {
          body: { id: ctx.pathParams['id'], name: ctx.body.name, requestId: ctx.requestId },
        };
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/boom',
      handler: () => {
        throw new Error('db connection failed hunter2');
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/err/{kind}',
      handler: (ctx) => {
        const errs: Record<string, ApiError> = {
          401: unauthorized(),
          403: forbidden(),
          404: notFound(),
          409: versionConflict(),
          429: throttled(5),
          503: serviceUnavailable(),
        };
        throw errs[ctx.pathParams['kind'] as string];
      },
    }),
  ];
  const handler = createApiHandler(
    { allowedOrigins: [ORIGIN], maxBodyBytes, logger, generateRequestId: () => 'generated-req-id' },
    routes,
  );
  return { handler, lines };
}

const ev = (over: Partial<ApiEvent> & { method?: string; path: string }): ApiEvent => ({
  rawPath: over.path,
  headers: { 'content-type': 'application/json', ...(over.headers ?? {}) },
  body: over.body ?? null,
  requestContext: { http: { method: over.method ?? 'GET', path: over.path } },
});

describe('api framework', () => {
  it('propagates a valid inbound request ID and generates one otherwise', async () => {
    const { handler } = setup();
    const body = JSON.stringify({ name: 'ab' });
    const a = await handler(
      ev({
        method: 'POST',
        path: '/api/v1/echo/7',
        body,
        headers: { 'X-Request-Id': 'client-req-1234' },
      }),
    );
    expect(a.statusCode).toBe(200);
    expect(a.headers['x-request-id']).toBe('client-req-1234');
    expect(JSON.parse(a.body).requestId).toBe('client-req-1234');

    const b = await handler(
      ev({ method: 'POST', path: '/api/v1/echo/7', body, headers: { 'x-request-id': 'bad id!' } }),
    );
    expect(b.headers['x-request-id']).toBe('generated-req-id');
  });

  it('returns 400 envelope for schema violations without echoing input', async () => {
    const { handler } = setup();
    const res = await handler(
      ev({ method: 'POST', path: '/api/v1/echo/7', body: JSON.stringify({ name: 'x' }) }),
    );
    expect(res.statusCode).toBe(400);
    const parsed = ErrorEnvelopeSchema.parse(JSON.parse(res.body));
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.requestId).toBe('generated-req-id');
  });

  it('rejects oversized bodies, bad JSON and wrong content type with 400', async () => {
    const { handler } = setup(50);
    const big = await handler(
      ev({
        method: 'POST',
        path: '/api/v1/echo/7',
        body: JSON.stringify({ name: 'a'.repeat(100) }),
      }),
    );
    expect(big.statusCode).toBe(400);
    const bad = await handler(ev({ method: 'POST', path: '/api/v1/echo/7', body: '{nope' }));
    expect(bad.statusCode).toBe(400);
    const ct = await handler(
      ev({
        method: 'POST',
        path: '/api/v1/echo/7',
        body: '{"name":"ab"}',
        headers: { 'content-type': 'text/plain' },
      }),
    );
    expect(ct.statusCode).toBe(400);
    const missing = await handler(ev({ method: 'POST', path: '/api/v1/echo/7' }));
    expect(missing.statusCode).toBe(400);
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'VERSION_CONFLICT'],
    [429, 'THROTTLED'],
    [503, 'SERVICE_UNAVAILABLE'],
  ])('maps %i to the error envelope', async (status, code) => {
    const { handler } = setup();
    const res = await handler(ev({ path: `/err/${status}` }));
    expect(res.statusCode).toBe(status);
    expect(ErrorEnvelopeSchema.parse(JSON.parse(res.body)).error.code).toBe(code);
    if (status === 429) expect(res.headers['retry-after']).toBe('5');
  });

  it('returns 404 for unknown routes', async () => {
    const { handler } = setup();
    expect((await handler(ev({ path: '/nope' }))).statusCode).toBe(404);
  });

  it('hides internals on unexpected errors and logs without stack or secrets', async () => {
    const { handler, lines } = setup();
    const res = await handler(ev({ path: '/boom' }));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/hunter2|stack|\.ts/);
    expect(JSON.parse(res.body).error.message).toBe('Internal server error');
    const all = lines.join('\n');
    expect(all).not.toMatch(/\n\s+at /);
  });

  it('enforces a strict CORS allowlist', async () => {
    const { handler } = setup();
    const ok = await handler(ev({ path: '/err/404', headers: { origin: ORIGIN } }));
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['vary']).toBe('Origin');

    const denied = await handler(
      ev({ path: '/err/404', headers: { origin: 'https://evil.example' } }),
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    const pre = await handler(
      ev({ method: 'OPTIONS', path: '/api/v1/echo/7', headers: { origin: ORIGIN } }),
    );
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toContain('POST');

    expect(() => createApiHandler({ allowedOrigins: ['*'] }, [])).toThrow();
  });

  it('emits a structured log line with request correlation fields', async () => {
    const { handler, lines } = setup();
    await handler(ev({ method: 'POST', path: '/api/v1/echo/7', body: '{"name":"ab"}' }));
    const entry = JSON.parse(lines[lines.length - 1] as string);
    expect(entry).toMatchObject({
      requestId: 'generated-req-id',
      eventId: 'evt-1',
      catalogVersion: 'v1',
      operation: 'POST /api/v1/echo/{id}',
      status: 200,
    });
    expect(typeof entry.latencyMs).toBe('number');
  });
});
