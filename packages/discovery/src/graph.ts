/**
 * Graph builder (FR-06 6.1, NFR-03 15.2).
 *
 * Builds topic and session nodes with `topic-match`, `shared-concept`, and
 * `inferred-bridge` edges. Edges carry a weight in [0,1], supporting session IDs,
 * and evidence spans. Relationships are inferred thematic links, not official
 * AWS endorsements. The graph is capped (40 nodes / 80 edges by default) and
 * always referentially intact: every edge endpoint is a node, and every session
 * node resolves in the catalog. Bridges are added atomically in input order, so
 * a bridge that would exceed a cap is skipped rather than partially added.
 */
import type {
  Bridge,
  Evidence,
  Graph,
  GraphEdge,
  GraphNode,
} from '@serendipity/packages-contracts';
import type { TopicRetrieval } from './retrieval.js';

export const DEFAULT_MAX_GRAPH_NODES = 40;
export const DEFAULT_MAX_GRAPH_EDGES = 80;

/** Session fields needed to label a session node. */
export interface GraphSession {
  readonly sessionId: string;
  readonly title: string;
  readonly track?: string | undefined;
}

export interface BuildGraphInput {
  readonly catalogVersion: string;
  /** Normalized topics the user entered (one or two). */
  readonly topics: readonly string[];
  readonly bridges: readonly Bridge[];
  /** Sessions available in the catalog, keyed by session ID. */
  readonly sessions: ReadonlyMap<string, GraphSession>;
  /** Optional per-topic retrievals; used for topic-match edge weights. */
  readonly retrievals?: readonly TopicRetrieval[] | undefined;
  readonly maxNodes?: number | undefined;
  readonly maxEdges?: number | undefined;
}

export const topicNodeId = (topic: string): string => `topic:${topic.trim().toLowerCase()}`;
export const sessionNodeId = (sessionId: string): string => `session:${sessionId}`;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function buildGraph(input: BuildGraphInput): Graph {
  const maxNodes = Math.max(0, Math.floor(input.maxNodes ?? DEFAULT_MAX_GRAPH_NODES));
  const maxEdges = Math.max(0, Math.floor(input.maxEdges ?? DEFAULT_MAX_GRAPH_EDGES));
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  // Topic nodes first (deduplicated, bounded by the node cap).
  const topicIds: { topic: string; id: string }[] = [];
  for (const topic of input.topics) {
    const id = topicNodeId(topic);
    if (id === 'topic:' || nodes.has(id) || nodes.size >= maxNodes) continue;
    nodes.set(id, { id, type: 'topic', label: topic, catalogVersion: input.catalogVersion });
    topicIds.push({ topic, id });
  }

  const relevanceOf = (topic: string, sessionId: string): number | undefined =>
    input.retrievals
      ?.find((r) => topicNodeId(r.topic) === topicNodeId(topic))
      ?.candidates.find((c) => c.sessionId === sessionId)?.relevance;

  for (const bridge of input.bridges) {
    const sessionIds = [...new Set(bridge.sessionIds)];
    const sessions = sessionIds.map((id) => input.sessions.get(id));
    // Provenance: every session must resolve in the catalog.
    if (sessions.some((s) => s === undefined)) continue;

    const newNodes: GraphNode[] = [];
    for (const s of sessions) {
      if (!s) continue;
      const id = sessionNodeId(s.sessionId);
      if (nodes.has(id)) continue;
      newNodes.push({
        id,
        type: 'session',
        label: s.title,
        catalogVersion: input.catalogVersion,
        metadata: { sessionId: s.sessionId, ...(s.track ? { track: s.track } : {}) },
      });
    }

    const newEdges: GraphEdge[] = [];
    const addEdge = (e: GraphEdge): void => {
      if (!edges.has(e.id) && !newEdges.some((x) => x.id === e.id)) newEdges.push(e);
    };

    if (sessionIds.length === 1) {
      const sid = sessionIds[0] as string;
      for (const t of topicIds) {
        addEdge({
          id: `edge:topic-match:${t.id}|${sessionNodeId(sid)}`,
          source: t.id,
          target: sessionNodeId(sid),
          type: 'topic-match',
          weight: clamp01(relevanceOf(t.topic, sid) ?? bridge.score),
          supportingSessionIds: [sid],
          evidence: bridge.evidence.filter((e: Evidence) => e.sessionId === sid),
        });
      }
    } else {
      // Topic-match edges link each topic to the sessions retrieved for it.
      for (const sid of sessionIds) {
        for (const t of topicIds) {
          const rel = relevanceOf(t.topic, sid);
          if (rel === undefined) continue;
          addEdge({
            id: `edge:topic-match:${t.id}|${sessionNodeId(sid)}`,
            source: t.id,
            target: sessionNodeId(sid),
            type: 'topic-match',
            weight: clamp01(rel),
            supportingSessionIds: [sid],
            evidence: bridge.evidence.filter((e: Evidence) => e.sessionId === sid),
          });
        }
      }
      // Pairwise bridge edges between consecutive sessions (typed by the bridge relationship).
      const sorted = [...sessionIds].sort();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sessionNodeId(sorted[i] as string);
          const b = sessionNodeId(sorted[j] as string);
          addEdge({
            id: `edge:${bridge.relationship}:${a}|${b}`,
            source: a,
            target: b,
            type: bridge.relationship,
            weight: clamp01(bridge.score),
            supportingSessionIds: [sorted[i] as string, sorted[j] as string],
            evidence: [...bridge.evidence],
          });
        }
      }
    }

    // Atomic add: skip the whole bridge if it would exceed a cap.
    if (nodes.size + newNodes.length > maxNodes || edges.size + newEdges.length > maxEdges) {
      continue;
    }
    for (const n of newNodes) nodes.set(n.id, n);
    for (const e of newEdges) edges.set(e.id, e);
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
