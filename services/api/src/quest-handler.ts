/**
 * Quests handler.
 *
 * - `POST /api/v1/quests`  ordered 2-4 step quest with conflicts and unknown schedule
 *
 * The catalog version is required; a different active version fails with 409.
 * The bridge is re-derived server-side from the discovery inputs (never trusted
 * from the client), and every step links to a real catalog session.
 *
 * Requirements: FR-07 (7.1-7.6).
 */
import { QuestRequestSchema, type QuestResponse } from '@serendipity/packages-contracts';
import { planQuest } from '@serendipity/packages-discovery';
import { notFound } from './errors.js';
import {
  createDiscoveryService,
  type CatalogHandlerDeps,
  type DiscoveryService,
} from './catalog-handlers.js';
import { defineRoute, type RouteDefinition } from './framework.js';

const LOOKUP_LIMIT = 50;

export function createQuestRoutes(
  catalogDeps: CatalogHandlerDeps,
  discovery: DiscoveryService = createDiscoveryService(catalogDeps),
): RouteDefinition[] {
  const quests = defineRoute({
    method: 'POST',
    path: '/api/v1/quests',
    bodySchema: QuestRequestSchema,
    handler: async (ctx): Promise<{ body: QuestResponse }> => {
      const req = ctx.body as ReturnType<typeof QuestRequestSchema.parse>;

      const run = await discovery.run(ctx, {
        eventId: req.eventId,
        topics: req.topics,
        novelty: req.novelty,
        seed: req.seed,
        limit: LOOKUP_LIMIT,
        expectedCatalogVersion: req.catalogVersion,
      });

      const bridge = run.scored.bridges.find((b) => b.id === req.bridgeId);
      if (!bridge) throw notFound('Bridge not found');

      // Adjacent concepts: sessions from the other qualified bridges.
      const adjacentSessionIds = run.scored.bridges
        .filter((b) => b.id !== bridge.id)
        .flatMap((b) => b.sessionIds);

      const plan = planQuest({
        bridge,
        catalog: run.sessions,
        adjacentSessionIds,
        ...(req.steps !== undefined ? { steps: req.steps } : {}),
      });
      // Fewer than two distinct real sessions: no quest can be built honestly.
      if (!plan) throw notFound('Not enough sessions to build a quest for this bridge');

      return {
        body: {
          catalogVersion: run.version,
          bridgeId: bridge.id,
          steps: plan.quest.steps,
          conflicts: plan.quest.conflicts,
          unknownSchedule: plan.quest.unknownSchedule,
          alternatives: plan.alternatives,
        },
      };
    },
  });

  return [quests];
}
