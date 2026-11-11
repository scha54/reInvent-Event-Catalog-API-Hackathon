/**
 * Explain handler.
 *
 * - `POST /api/v1/bridges/{bridgeId}/explain`  evidence-validated explanation
 *
 * The catalog version is required; if it differs from the active version the
 * request fails with 409 so clients never see an explanation for a stale bridge.
 * The bridge is re-derived server-side from the discovery inputs, so evidence and
 * relationship are never taken from the client. Explanations come from the
 * orchestrator, which always resolves to a validated explanation (model output or
 * deterministic fallback).
 *
 * Requirements: FR-05 (5.1), FR-10 (10.2), AI (20.4).
 */
import {
  ExplainRequestSchema,
  type ExplainResponse,
  type Session,
} from '@serendipity/packages-contracts';
import type { ExplanationOrchestrator } from '@serendipity/packages-discovery';
import { notFound, serviceUnavailable } from './errors.js';
import {
  createDiscoveryService,
  type CatalogHandlerDeps,
  type DiscoveryService,
} from './catalog-handlers.js';
import { defineRoute, type RouteDefinition } from './framework.js';

/** Upper bound on bridges re-derived when locating the requested one. */
const LOOKUP_LIMIT = 50;
const MAX_BRIDGE_ID_LENGTH = 512;

export interface ExplainHandlerDeps {
  readonly orchestrator: Pick<ExplanationOrchestrator, 'explain'>;
}

export function createExplainRoutes(
  deps: ExplainHandlerDeps,
  catalogDeps: CatalogHandlerDeps,
  discovery: DiscoveryService = createDiscoveryService(catalogDeps),
): RouteDefinition[] {
  const explain = defineRoute({
    method: 'POST',
    path: '/api/v1/bridges/{bridgeId}/explain',
    bodySchema: ExplainRequestSchema,
    handler: async (ctx): Promise<{ body: ExplainResponse }> => {
      const req = ctx.body as ReturnType<typeof ExplainRequestSchema.parse>;
      const bridgeId = ctx.pathParams['bridgeId'] as string;
      if (bridgeId.length > MAX_BRIDGE_ID_LENGTH) throw notFound('Bridge not found');

      const run = await discovery.run(ctx, {
        eventId: req.eventId,
        topics: req.topics,
        novelty: req.novelty,
        seed: req.seed,
        limit: LOOKUP_LIMIT,
        expectedCatalogVersion: req.catalogVersion,
      });

      const bridge = run.scored.bridges.find((b) => b.id === bridgeId);
      if (!bridge) throw notFound('Bridge not found');

      const sessions = bridge.sessionIds
        .map((id) => run.sessions.get(id))
        .filter((s): s is Session => s !== undefined);
      if (sessions.length !== bridge.sessionIds.length) {
        throw serviceUnavailable('Catalog data is unavailable');
      }

      const result = await deps.orchestrator.explain({
        bridgeId: bridge.id,
        catalogVersion: run.version,
        topics: run.topics,
        relationship: bridge.relationship,
        sessions,
        evidence: bridge.evidence,
      });

      return {
        body: {
          catalogVersion: run.version,
          bridgeId: bridge.id,
          explanation: result.explanation,
          source: result.source,
          ...(result.fallbackReason !== undefined ? { fallbackReason: result.fallbackReason } : {}),
        },
      };
    },
  });

  return [explain];
}
