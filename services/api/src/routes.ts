/**
 * Route table and rate-limiting configuration.
 *
 * `ROUTE_POLICIES` is the single source of truth for per-route access and
 * throttling. The CDK API stack consumes it (route authorization type and
 * per-route throttle settings) and `createApiRoutes` enforces at build time
 * that every registered route has a policy, that admin routes require IAM, and
 * that public routes carry a throttle. Admin routes are additionally wrapped
 * so an unauthenticated request is rejected before reaching the handler.
 *
 * Requirements: FR-11 (11.1, 11.2), NFR-01 (13.3).
 */
import { unauthorized } from './errors.js';
import type { RouteDefinition } from './framework.js';
import {
  createCatalogRoutes,
  type CatalogHandlerDeps,
  type DiscoveryService,
} from './catalog-handlers.js';
import { createDiscoveryService } from './catalog-handlers.js';
import { createExplainRoutes, type ExplainHandlerDeps } from './explain-handler.js';
import { createQuestRoutes } from './quest-handler.js';
import { createFeedbackRoutes, type FeedbackHandlerDeps } from './feedback-handler.js';
import {
  createAdminSyncRoutes,
  getOperatorIdentity,
  type AdminSyncHandlerDeps,
} from './admin-sync-handler.js';

export interface ThrottleConfig {
  /** Steady-state requests per second. */
  readonly rateLimit: number;
  /** Maximum burst of concurrent requests. */
  readonly burstLimit: number;
}

export type RouteAccess = 'public' | 'operator';

export interface RoutePolicy {
  readonly access: RouteAccess;
  /** API Gateway authorization type for the route. */
  readonly authorization: 'NONE' | 'AWS_IAM';
  readonly throttle: ThrottleConfig;
}

/** Stage-wide default throttle applied to any route without its own entry. */
export const DEFAULT_THROTTLE: ThrottleConfig = { rateLimit: 10, burstLimit: 20 };

export const routeKey = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

const publicRoute = (rateLimit: number, burstLimit: number): RoutePolicy => ({
  access: 'public',
  authorization: 'NONE',
  throttle: { rateLimit, burstLimit },
});

const operatorRoute = (rateLimit: number, burstLimit: number): RoutePolicy => ({
  access: 'operator',
  authorization: 'AWS_IAM',
  throttle: { rateLimit, burstLimit },
});

/** Anonymous discovery is allowed subject to rate limiting (11.2); admin requires IAM (11.1). */
export const ROUTE_POLICIES: Readonly<Record<string, RoutePolicy>> = {
  'GET /api/v1/events': publicRoute(20, 40),
  'GET /api/v1/events/{eventId}/status': publicRoute(20, 40),
  'POST /api/v1/discover': publicRoute(10, 20),
  // Explanations invoke Bedrock, so they are throttled hardest to bound spend.
  'POST /api/v1/bridges/{bridgeId}/explain': publicRoute(5, 10),
  'POST /api/v1/quests': publicRoute(10, 20),
  'POST /api/v1/feedback': publicRoute(10, 20),
  'DELETE /api/v1/feedback/{anonymousId}': publicRoute(5, 10),
  'POST /api/v1/admin/events/{eventId}/sync': operatorRoute(1, 2),
};

export interface ApiRouteDeps {
  readonly catalog: CatalogHandlerDeps;
  readonly explain: ExplainHandlerDeps;
  readonly feedback: FeedbackHandlerDeps;
  readonly admin: AdminSyncHandlerDeps;
  /** Shared discovery service; created from `catalog` when omitted. */
  readonly discovery?: DiscoveryService;
}

/** Wraps an operator route so it fails closed (401) without an IAM principal. */
function requireOperator(route: RouteDefinition): RouteDefinition {
  const inner = route.handler;
  return {
    ...route,
    handler: (ctx) => {
      if (!getOperatorIdentity(ctx.event)) throw unauthorized();
      return inner(ctx);
    },
  };
}

/**
 * Validates a route table against the policy table. Throws on a duplicate
 * route, a route without a policy, a policy without a route, an operator route
 * without IAM authorization, or a non-positive throttle.
 */
export function validateRouteTable(
  routes: readonly RouteDefinition[],
  policies: Readonly<Record<string, RoutePolicy>> = ROUTE_POLICIES,
): void {
  const seen = new Set<string>();
  for (const route of routes) {
    const key = routeKey(route.method, route.path);
    if (seen.has(key)) throw new Error(`Duplicate route: ${key}`);
    seen.add(key);
    const policy = policies[key];
    if (!policy) throw new Error(`Route has no policy: ${key}`);
    if (policy.access === 'operator' && policy.authorization !== 'AWS_IAM') {
      throw new Error(`Operator route must use AWS_IAM authorization: ${key}`);
    }
    if (route.path.includes('/admin/') && policy.access !== 'operator') {
      throw new Error(`Admin route must be operator-only: ${key}`);
    }
    const { rateLimit, burstLimit } = policy.throttle;
    if (!(rateLimit > 0) || !(burstLimit >= rateLimit)) {
      throw new Error(`Invalid throttle for route: ${key}`);
    }
  }
  for (const key of Object.keys(policies)) {
    if (!seen.has(key)) throw new Error(`Policy has no route: ${key}`);
  }
}

/** Builds and validates the full API route table. */
export function createApiRoutes(deps: ApiRouteDeps): RouteDefinition[] {
  const discovery = deps.discovery ?? createDiscoveryService(deps.catalog);
  const routes: RouteDefinition[] = [
    ...createCatalogRoutes(deps.catalog, discovery),
    ...createExplainRoutes(deps.explain, deps.catalog, discovery),
    ...createQuestRoutes(deps.catalog, discovery),
    ...createFeedbackRoutes(deps.feedback),
    ...createAdminSyncRoutes(deps.admin).map(requireOperator),
  ];
  validateRouteTable(routes);
  return routes;
}
