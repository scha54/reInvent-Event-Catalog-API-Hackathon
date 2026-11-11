import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Graph } from '@serendipity/packages-contracts';
import {
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  ZOOM_STEP,
  buildListRows,
  clampZoom,
  layoutGraph,
  neighborInDirection,
  nodeDescription,
  sessionIdOfNode,
  type Direction,
} from './graph-view';

export interface GraphViewProps {
  readonly graph: Graph | undefined;
  /** Open the official session details for a session node. */
  readonly onOpenSession: (sessionId: string, trigger: HTMLElement) => void;
}

const ARROWS: Readonly<Record<string, Direction>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/** Dash patterns distinguish relationship types without relying on color. */
const EDGE_DASH: Readonly<Record<string, string | undefined>> = {
  'topic-match': undefined,
  'shared-concept': '8 4',
  'inferred-bridge': '2 4',
};

type ViewMode = 'graph' | 'list';

/** Graph with an equivalent table view; the user can switch between them at any time. */
export function GraphView({ graph, onOpenSession }: GraphViewProps) {
  const [mode, setMode] = useState<ViewMode>('graph');
  const headingId = useId();
  if (!graph || graph.nodes.length === 0) {
    return (
      <section aria-labelledby={headingId} className="graph-section">
        <h3 id={headingId}>Connection graph</h3>
        <p>No graph is available for these results.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby={headingId} className="graph-section">
      <h3 id={headingId}>Connection graph</h3>
      <div role="group" aria-label="Choose how to view connections" className="view-toggle">
        {(['graph', 'list'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
            {m === 'graph' ? 'Graph view' : 'List view'}
          </button>
        ))}
      </div>
      {mode === 'graph' ? (
        <GraphCanvas graph={graph} onOpenSession={onOpenSession} />
      ) : (
        <GraphList graph={graph} onOpenSession={onOpenSession} />
      )}
    </section>
  );
}

function GraphCanvas({
  graph,
  onOpenSession,
}: { readonly graph: Graph } & Pick<GraphViewProps, 'onOpenSession'>) {
  const model = useMemo(() => layoutGraph(graph), [graph]);
  const [zoom, setZoom] = useState(1);
  const [activeId, setActiveId] = useState(() => model.nodes[0]?.node.id ?? '');
  const [selectedTopicId, setSelectedTopicId] = useState<string | undefined>();
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const helpId = useId();
  const infoId = useId();

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of model.edges) {
      m.set(e.edge.source, (m.get(e.edge.source) ?? 0) + 1);
      m.set(e.edge.target, (m.get(e.edge.target) ?? 0) + 1);
    }
    return m;
  }, [model]);

  const active = model.nodes.find((n) => n.node.id === activeId) ?? model.nodes[0];

  function focusNode(id: string) {
    setActiveId(id);
    nodeRefs.current.get(id)?.focus();
  }

  function activate(id: string, element: SVGGElement) {
    const n = model.nodes.find((x) => x.node.id === id);
    if (!n) return;
    const sessionId = sessionIdOfNode(n.node);
    if (sessionId) {
      onOpenSession(sessionId, element as unknown as HTMLElement);
    } else {
      setSelectedTopicId((prev) => (prev === id ? undefined : id));
    }
  }

  function onKeyDown(e: KeyboardEvent<SVGGElement>, id: string) {
    const dir = ARROWS[e.key];
    if (dir) {
      e.preventDefault();
      const next = neighborInDirection(model.nodes, id, dir);
      if (next) focusNode(next);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      const first = model.nodes[0];
      if (first) focusNode(first.node.id);
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = model.nodes[model.nodes.length - 1];
      if (last) focusNode(last.node.id);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(id, e.currentTarget);
    } else if (e.key === '+' || e.key === '=') {
      setZoom((z) => clampZoom(z + ZOOM_STEP));
    } else if (e.key === '-') {
      setZoom((z) => clampZoom(z - ZOOM_STEP));
    } else if (e.key === '0') {
      setZoom(1);
    }
  }

  const selectedTopic = selectedTopicId
    ? model.nodes.find((n) => n.node.id === selectedTopicId)
    : undefined;
  const topicRows = selectedTopic
    ? buildListRows(graph).find((r) => r.nodeId === selectedTopic.node.id)
    : undefined;

  return (
    <div>
      <p id={helpId} className="section-note">
        Use arrow keys to move between nodes, Enter to select, plus and minus to zoom. Topics are
        circles; sessions are squares. Line style shows the relationship type. A list view with the
        same information is available above.
      </p>
      <div className="zoom-controls" role="group" aria-label="Zoom">
        <button
          type="button"
          onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
          aria-label="Zoom out"
        >
          −
        </button>
        <span aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
          aria-label="Zoom in"
        >
          +
        </button>
        <button type="button" onClick={() => setZoom(1)}>
          Reset zoom
        </button>
      </div>
      <div className="graph-scroll" tabIndex={-1}>
        <svg
          className="graph-svg"
          viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
          style={{ width: `${zoom * 100}%` }}
          role="group"
          aria-label="Graph of topics and sessions"
          aria-describedby={helpId}
        >
          <g>
            {model.edges.map((e) => (
              <g key={e.edge.id} className="graph-edge">
                <title>{e.description}</title>
                <line
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                  stroke="currentColor"
                  strokeWidth={1 + e.edge.weight * 3}
                  {...(EDGE_DASH[e.edge.type] ? { strokeDasharray: EDGE_DASH[e.edge.type] } : {})}
                />
                <text
                  x={(e.x1 + e.x2) / 2}
                  y={(e.y1 + e.y2) / 2}
                  textAnchor="middle"
                  className="graph-edge-label"
                >
                  {e.label}
                </text>
              </g>
            ))}
          </g>
          <g>
            {model.nodes.map((n) => {
              const isActive = n.node.id === active?.node.id;
              const label = n.node.label || n.node.id;
              const isTopic = n.kindLabel === 'Topic';
              return (
                <g
                  key={n.node.id}
                  ref={(el) => {
                    if (el) nodeRefs.current.set(n.node.id, el);
                    else nodeRefs.current.delete(n.node.id);
                  }}
                  className="graph-node"
                  role="button"
                  tabIndex={isActive ? 0 : -1}
                  aria-label={nodeDescription(n, counts.get(n.node.id) ?? 0)}
                  aria-haspopup={isTopic ? undefined : 'dialog'}
                  aria-expanded={isTopic ? selectedTopicId === n.node.id : undefined}
                  onFocus={() => setActiveId(n.node.id)}
                  onClick={(e) => {
                    setActiveId(n.node.id);
                    activate(n.node.id, e.currentTarget);
                  }}
                  onKeyDown={(e) => onKeyDown(e, n.node.id)}
                >
                  <title>{nodeDescription(n, counts.get(n.node.id) ?? 0)}</title>
                  {isTopic ? (
                    <circle cx={n.x} cy={n.y} r={22} className="graph-shape" />
                  ) : (
                    <rect
                      x={n.x - 18}
                      y={n.y - 18}
                      width={36}
                      height={36}
                      className="graph-shape"
                    />
                  )}
                  <text
                    x={n.x}
                    y={n.y + 4}
                    textAnchor="middle"
                    className="graph-kind"
                    aria-hidden="true"
                  >
                    {isTopic ? 'T' : 'S'}
                  </text>
                  <text
                    x={n.x}
                    y={n.y + 38}
                    textAnchor="middle"
                    className="graph-label"
                    aria-hidden="true"
                  >
                    {label.length > 28 ? `${label.slice(0, 27)}…` : label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      {active && (
        <p id={infoId} className="graph-info" aria-live="polite">
          Focused — {nodeDescription(active, counts.get(active.node.id) ?? 0)}
        </p>
      )}
      {selectedTopic && topicRows && (
        <div className="status-box">
          <h4>Connections for {selectedTopic.node.label || selectedTopic.node.id}</h4>
          {topicRows.connections.length === 0 ? (
            <p>No connections.</p>
          ) : (
            <ul>
              {topicRows.connections.map((c) => (
                <li key={c.edgeId}>
                  {c.otherLabel} — {c.relationship}, {c.weightPercent}%
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function GraphList({
  graph,
  onOpenSession,
}: { readonly graph: Graph } & Pick<GraphViewProps, 'onOpenSession'>) {
  const rows = useMemo(() => buildListRows(graph), [graph]);
  const nodes = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  return (
    <table className="graph-table">
      <caption>All topics and sessions with their connections</caption>
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Type</th>
          <th scope="col">Connected to</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const node = nodes.get(row.nodeId);
          const sessionId = node ? sessionIdOfNode(node) : undefined;
          return (
            <tr key={row.nodeId}>
              <th scope="row">
                {sessionId ? (
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    onClick={(e) => onOpenSession(sessionId, e.currentTarget)}
                  >
                    {row.label}
                    <span className="visually-hidden"> (open session details)</span>
                  </button>
                ) : (
                  row.label
                )}
              </th>
              <td>{row.kind}</td>
              <td>
                {row.connections.length === 0 ? (
                  'No connections'
                ) : (
                  <ul>
                    {row.connections.map((c) => (
                      <li key={c.edgeId}>
                        {c.otherLabel} — {c.relationship}, strength {c.weightPercent}%,{' '}
                        {c.supportingSessionCount} supporting session
                        {c.supportingSessionCount === 1 ? '' : 's'}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
