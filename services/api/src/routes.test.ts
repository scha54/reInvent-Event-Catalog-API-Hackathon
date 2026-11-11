import { describe, expect, it } from 'vitest';
import { createApiHandler, defineRoute } from './framework.js';
import {
  ROUTE_POLICIES,
  createApiRoutes,
  routeKey,
  validateRouteTable,
  type ApiRouteDeps,
} from './routes.js';
import { InMemoryFeedbackStore } from './feedback-handler.js';

const deps = {
  catalog: {} as unknown as ApiRouteDeps['catalog'],
  explain: {} as unknown as ApiRouteDeps['explain'],
  feedback: { store: new InMemoryFeedbackStore() },
  admin: {
    starter: { start: async () => ({}) },
    generateExecutionId: () => 'sync-test',
  },
  discovery: {
    run: async () => {
      throw new Error('unused');
    },
  },
} as unknown as ApiRouteDeps;

describe('route table', () => {
  it('registers every policy route exactly once', () => {
    const routes = createApiRoutes(deps);
    expect(routes.map((r) => routeKey(r.method, r.path)).sort()).toEqual(
      Object.keys(ROUTE_POLICIES).sort(),
    );
  });

  it('marks admin routes operator-only with IAM and public routes throttled', () => {
    for (const [key, policy] of Object.entries(ROUTE_POLICIES)) {
      if (key.includes('/admin/')) {
        expect(policy.access).toBe('operator');
        expect(policy.authorization).toBe('AWS_IAM');
      } else {
        expect(policy.access).toBe('public');
        expect(policy.authorization).toBe('NONE');
      }
      expect(policy.throttle.rateLimit).toBeGreaterThan(0);
    }
  });

  it('rejects routes without a policy and duplicates', () => {
    const r = defineRoute({ method: 'GET', path: '/x', handler: () => ({}) });
    expect(() => validateRouteTable([r])).toThrow(/no policy/);
    const dup = createApiRoutes(deps);
    expect(() => validateRouteTable([...dup, dup[0] as (typeof dup)[number]])).toThrow(/Duplicate/);
  });

  it('returns 401 for admin sync without an IAM principal and 202 with one', async () => {
    const handler = createApiHandler({ allowedOrigins: [] }, createApiRoutes(deps));
    const base = {
      rawPath: '/api/v1/admin/events/evt1/sync',
      requestContext: { http: { method: 'POST' } },
    };
    expect((await handler(base)).statusCode).toBe(401);
    const ok = await handler({
      ...base,
      requestContext: {
        http: { method: 'POST' },
        authorizer: { iam: { userArn: 'arn:aws:iam::1:role/Operator' } },
      },
    });
    expect(ok.statusCode).toBe(202);
  });
});
