/**
 * Pure view-model helpers for the accessible graph and its equivalent list view.
 * Layout is deterministic so the same graph always renders identically.
 */
import type { Graph, GraphEdge, GraphNode } from '@serendipity/packages-contracts';
import { RELATIONSHIP_LABELS, toPercent } from './bridge-view';

export const GRAPH_WIDTH = 640;
export const GRAPH_HEIGHT = 480;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 0.25;

export interface PositionedNode {
  readonly node: GraphNode;
  readonly x: number;
  readonly y: number;
  /** Plain-text kind used in labels so type never depends on shape or color. */
  readonly kindLabel: 'Topic' | 'Session';
}

export interface PositionedEdge {
  readonly edge: GraphEdge;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly label: string;
  readonly weightPercent: number;
  /** Full tooltip / accessible description. */
  readonly description: string;
}

export interface GraphModel {
  readonly nodes: readonly PositionedNode[];
  readonly edges: readonly PositionedEdge[];
}

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

/** Topic nodes on an inner ring, session nodes on an outer ring. Edges to unknown nodes are dropped. */
export function layoutGraph(graph: Graph): GraphModel {
  const cx = GRAPH_WIDTH / 2;
  const cy = GRAPH_HEIGHT / 2;
  const topics = graph.nodes.filter((n) => n.type === 'topic');
  const sessions = graph.nodes.filter((n) => n.type === 'session');

  const place = (
    list: readonly GraphNode[],
    radius: number,
    kindLabel: PositionedNode['kindLabel'],
    offset: number,
  ): PositionedNode[] =>
    list.map((node, i) => {
      if (list.length === 1 && radius < 100) {
        return { node, x: cx, y: cy, kindLabel };
      }
      const angle = offset + (2 * Math.PI * i) / list.length;
      return {
        node,
        x: Math.round((cx + radius * Math.cos(angle)) * 100) / 100,
        y: Math.round((cy + radius * Math.sin(angle)) * 100) / 100,
        kindLabel,
      };
    });

  const nodes = [
    ...place(topics, topics.length <= 1 ? 0 : 90, 'Topic', -Math.PI / 2),
    ...place(sessions, 200, 'Session', -Math.PI / 2),
  ];
  const byId = new Map(nodes.map((n) => [n.node.id, n]));

  const edges: PositionedEdge[] = [];
  for (const edge of graph.edges) {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b) continue;
    const label = RELATIONSHIP_LABELS[edge.type];
    const weightPercent = toPercent(edge.weight);
    edges.push({
      edge,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      label,
      weightPercent,
      description: `${label} between ${a.node.label || a.node.id} and ${b.node.label || b.node.id}, strength ${weightPercent}%`,
    });
  }
  return { nodes, edges };
}

/** Accessible name for a node, including its kind and connection count. */
export function nodeDescription(n: PositionedNode, connections: number): string {
  const label = n.node.label || n.node.id;
  return `${n.kindLabel}: ${label}, ${connections} connection${connections === 1 ? '' : 's'}`;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/**
 * Next node in an arrow-key direction: nearest node whose offset lies within a 90° cone
 * around that direction. Returns undefined when nothing lies that way.
 */
export function neighborInDirection(
  nodes: readonly PositionedNode[],
  currentId: string,
  direction: Direction,
): string | undefined {
  const current = nodes.find((n) => n.node.id === currentId);
  if (!current) return undefined;
  let best: { id: string; dist: number } | undefined;
  for (const n of nodes) {
    if (n.node.id === currentId) continue;
    const dx = n.x - current.x;
    const dy = n.y - current.y;
    const inCone =
      (direction === 'right' && dx > 0 && Math.abs(dy) <= dx) ||
      (direction === 'left' && dx < 0 && Math.abs(dy) <= -dx) ||
      (direction === 'down' && dy > 0 && Math.abs(dx) <= dy) ||
      (direction === 'up' && dy < 0 && Math.abs(dx) <= -dy);
    if (!inCone) continue;
    const dist = dx * dx + dy * dy;
    if (!best || dist < best.dist) best = { id: n.node.id, dist };
  }
  return best?.id;
}

export interface ListRow {
  readonly nodeId: string;
  readonly kind: 'Topic' | 'Session';
  readonly label: string;
  readonly connections: readonly {
    readonly edgeId: string;
    readonly otherId: string;
    readonly otherLabel: string;
    readonly relationship: string;
    readonly weightPercent: number;
    readonly supportingSessionCount: number;
  }[];
}

/** Table/list rows carrying exactly the same nodes and edges as the graph (FR-06 6.3 parity). */
export function buildListRows(graph: Graph): readonly ListRow[] {
  const model = layoutGraph(graph);
  const labels = new Map(model.nodes.map((n) => [n.node.id, n.node.label || n.node.id]));
  return model.nodes.map((n) => ({
    nodeId: n.node.id,
    kind: n.kindLabel,
    label: n.node.label || n.node.id,
    connections: model.edges
      .filter((e) => e.edge.source === n.node.id || e.edge.target === n.node.id)
      .map((e) => {
        const otherId = e.edge.source === n.node.id ? e.edge.target : e.edge.source;
        return {
          edgeId: e.edge.id,
          otherId,
          otherLabel: labels.get(otherId) ?? otherId,
          relationship: e.label,
          weightPercent: e.weightPercent,
          supportingSessionCount: e.edge.supportingSessionIds.length,
        };
      }),
  }));
}

/** Session ID carried by a session node's metadata, falling back to the node ID. */
export function sessionIdOfNode(node: GraphNode): string | undefined {
  if (node.type !== 'session') return undefined;
  return node.metadata?.['sessionId'] ?? node.id;
}
