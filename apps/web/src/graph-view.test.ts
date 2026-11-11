import { describe, expect, it } from 'vitest';
import type { Graph } from '@serendipity/packages-contracts';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  buildListRows,
  clampZoom,
  layoutGraph,
  neighborInDirection,
  sessionIdOfNode,
} from './graph-view';

const graph: Graph = {
  nodes: [
    { id: 't1', type: 'topic', label: 'Serverless', catalogVersion: 'v1' },
    { id: 't2', type: 'topic', label: 'Music', catalogVersion: 'v1' },
    {
      id: 'n1',
      type: 'session',
      label: 'Lambda talk',
      catalogVersion: 'v1',
      metadata: { sessionId: 's1' },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 't1',
      target: 'n1',
      type: 'topic-match',
      weight: 0.8,
      supportingSessionIds: ['s1'],
    },
    {
      id: 'e2',
      source: 't2',
      target: 'missing',
      type: 'inferred-bridge',
      weight: 0.2,
      supportingSessionIds: [],
    },
  ],
};

describe('graph-view', () => {
  it('lays out every node and drops edges to unknown nodes', () => {
    const m = layoutGraph(graph);
    expect(m.nodes).toHaveLength(3);
    expect(m.edges.map((e) => e.edge.id)).toEqual(['e1']);
    expect(m.edges[0]?.label).toBe('Direct topic match');
  });

  it('list rows match graph nodes and edges', () => {
    const rows = buildListRows(graph);
    expect(rows.map((r) => r.nodeId)).toEqual(layoutGraph(graph).nodes.map((n) => n.node.id));
    expect(rows.find((r) => r.nodeId === 'n1')?.connections[0]?.otherLabel).toBe('Serverless');
  });

  it('navigates by direction and returns undefined at the edge', () => {
    const m = layoutGraph(graph);
    const down = neighborInDirection(m.nodes, 't1', 'down');
    const up = neighborInDirection(m.nodes, 't1', 'up');
    expect(down === undefined && up === undefined).toBe(false);
    expect(neighborInDirection(m.nodes, 'nope', 'left')).toBeUndefined();
  });

  it('clamps zoom and resolves session ids', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(sessionIdOfNode(graph.nodes[2]!)).toBe('s1');
    expect(sessionIdOfNode(graph.nodes[0]!)).toBeUndefined();
  });
});
