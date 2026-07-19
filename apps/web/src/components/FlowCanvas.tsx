'use client';

import { useEffect, useRef, useState } from 'react';

/** Mirrors the flow editor's graph shape — kept structural so the canvas stays decoupled. */
export interface CanvasNode {
  id: string;
  type: string;
  label?: string;
  mandatory?: boolean;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  priority?: number;
  conditions: Array<{ variable: string; operator: string; value?: unknown }>;
}

export interface CanvasGraph {
  entryNodeId: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface Pos {
  x: number;
  y: number;
}

const NODE_W = 184;
const NODE_H = 58;
const COL_GAP = 250;
const ROW_GAP = 96;
const PAD = 30;

const TYPE_COLORS: Record<string, string> = {
  AMD_CLASSIFY: '#a78bfa',
  SPEAK: '#38bdf8',
  PLAY: '#38bdf8',
  AI_CONVERSATION: '#f5a623',
  LISTEN_CAPTURE: '#2dd4bf',
  SEND_DTMF: '#fb923c',
  TRANSFER: '#34d399',
  BRANCH: '#f472b6',
  END: '#8b98b3',
};

const OPS: Record<string, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains: '∋',
  exists: '∃',
};

function edgeLabel(edge: CanvasEdge): string {
  if (edge.conditions.length === 0) return (edge.priority ?? 0) > 0 ? 'else' : '';
  return edge.conditions
    .map((c) => `${c.variable} ${OPS[c.operator] ?? c.operator} ${c.value === undefined ? '' : String(c.value)}`.trim())
    .join(' & ');
}

/**
 * Longest-path layered layout from the entry node: a node sits one column right
 * of its furthest predecessor, so the graph reads left → right in call order.
 */
function autoLayout(graph: CanvasGraph): Record<string, Pos> {
  const layer = new Map<string, number>();
  for (const node of graph.nodes) layer.set(node.id, 0);
  // Relax edges repeatedly; bounded by node count so a (invalid) cycle can't hang the UI.
  for (let pass = 0; pass < graph.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of graph.edges) {
      const from = layer.get(edge.from);
      const to = layer.get(edge.to);
      if (from === undefined || to === undefined) continue;
      if (from + 1 > to && from + 1 <= graph.nodes.length) {
        layer.set(edge.to, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const columns = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const l = layer.get(node.id) ?? 0;
    columns.set(l, [...(columns.get(l) ?? []), node.id]);
  }
  const maxRows = Math.max(...[...columns.values()].map((c) => c.length));
  const positions: Record<string, Pos> = {};
  for (const [l, ids] of columns) {
    // Center shorter columns vertically against the tallest one.
    const offset = ((maxRows - ids.length) * ROW_GAP) / 2;
    ids.forEach((id, row) => {
      positions[id] = { x: PAD + l * COL_GAP, y: PAD + offset + row * ROW_GAP };
    });
  }
  return positions;
}

export default function FlowCanvas({
  graph,
  selectedNodeId,
  onSelectNode,
  storageKey,
}: {
  graph: CanvasGraph;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  storageKey: string;
}) {
  const [positions, setPositions] = useState<Record<string, Pos>>({});
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const dragRef = useRef<{ id: string; pointerX: number; pointerY: number; origX: number; origY: number } | null>(null);

  const nodeKey = graph.nodes.map((n) => n.id).join('|');

  useEffect(() => {
    const auto = autoLayout(graphRef.current);
    let saved: Record<string, Pos> = {};
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, Pos>;
    } catch {
      /* stale/corrupt layout — fall back to auto */
    }
    const merged: Record<string, Pos> = {};
    for (const node of graphRef.current.nodes) {
      merged[node.id] = saved[node.id] ?? auto[node.id] ?? { x: PAD, y: PAD };
    }
    setPositions(merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, nodeKey]);

  function persist(next: Record<string, Pos>) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* private-mode etc. — layout just won't persist */
    }
  }

  function onPointerDown(e: React.PointerEvent, id: string) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const pos = positions[id];
    if (!pos) return;
    dragRef.current = { id, pointerX: e.clientX, pointerY: e.clientY, origX: pos.x, origY: pos.y };
    onSelectNode(id);
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const x = Math.max(0, drag.origX + e.clientX - drag.pointerX);
    const y = Math.max(0, drag.origY + e.clientY - drag.pointerY);
    setPositions((prev) => ({ ...prev, [drag.id]: { x, y } }));
  }

  function onPointerUp() {
    if (dragRef.current) persist({ ...positions });
    dragRef.current = null;
  }

  function resetLayout() {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
    setPositions(autoLayout(graphRef.current));
  }

  const width = Math.max(...Object.values(positions).map((p) => p.x + NODE_W), 400) + PAD;
  const height = Math.max(...Object.values(positions).map((p) => p.y + NODE_H), 200) + PAD;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
          Click a node to edit it below · drag to arrange · layout is saved per flow
        </p>
        <button className="btn btn-ghost text-xs" onClick={resetLayout}>
          Auto-arrange
        </button>
      </div>
      <div className="overflow-auto rounded-lg" style={{ background: 'var(--background)', border: '1px solid var(--border)', maxHeight: 460 }}>
        <svg width={width} height={height} onPointerMove={onPointerMove} onPointerUp={onPointerUp} style={{ display: 'block' }}>
          <defs>
            <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-dim)" />
            </marker>
            <marker id="flow-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
            </marker>
          </defs>

          {graph.edges.map((edge) => {
            const from = positions[edge.from];
            const to = positions[edge.to];
            if (!from || !to) return null;
            const hot = selectedNodeId === edge.from || selectedNodeId === edge.to;
            const sx = from.x + NODE_W;
            const sy = from.y + NODE_H / 2;
            const tx = to.x;
            const ty = to.y + NODE_H / 2;
            const backward = tx < sx;
            const bend = backward ? 90 : Math.max(50, (tx - sx) / 2);
            const dip = backward ? 80 : 0;
            const c1x = sx + bend;
            const c1y = sy + dip;
            const c2x = tx - bend;
            const c2y = ty + dip;
            // Cubic bezier midpoint (t = 0.5) for the condition label.
            const midX = (sx + 3 * c1x + 3 * c2x + tx) / 8;
            const midY = (sy + 3 * c1y + 3 * c2y + ty) / 8;
            const label = edgeLabel(edge);
            return (
              <g key={edge.id}>
                <path
                  d={`M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`}
                  fill="none"
                  stroke={hot ? 'var(--accent)' : 'var(--text-dim)'}
                  strokeOpacity={hot ? 0.9 : 0.45}
                  strokeWidth={hot ? 2 : 1.5}
                  markerEnd={hot ? 'url(#flow-arrow-hot)' : 'url(#flow-arrow)'}
                />
                {label && (
                  <text
                    x={midX}
                    y={midY - 6}
                    textAnchor="middle"
                    fontSize="10"
                    fill={hot ? 'var(--accent)' : 'var(--text-dim)'}
                    style={{ userSelect: 'none' }}
                  >
                    {label}
                  </text>
                )}
              </g>
            );
          })}

          {graph.nodes.map((node) => {
            const pos = positions[node.id];
            if (!pos) return null;
            const selected = selectedNodeId === node.id;
            const color = TYPE_COLORS[node.type] ?? 'var(--text-dim)';
            return (
              <g
                key={node.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                onPointerDown={(e) => onPointerDown(e, node.id)}
                style={{ cursor: 'grab' }}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={10}
                  fill="var(--surface)"
                  stroke={selected ? 'var(--accent)' : 'var(--border)'}
                  strokeWidth={selected ? 2 : 1}
                />
                <rect x={0} y={0} width={4} height={NODE_H} rx={2} fill={color} />
                <text x={14} y={22} fontSize="10" fontFamily="monospace" fill={color} style={{ userSelect: 'none' }}>
                  {node.type}
                  {node.mandatory ? ' ★' : ''}
                </text>
                <text x={14} y={42} fontSize="13" fill="var(--text)" style={{ userSelect: 'none' }}>
                  {(node.label ?? node.id).slice(0, 22)}
                </text>
                {graph.entryNodeId === node.id && (
                  <text x={NODE_W - 12} y={22} textAnchor="end" fontSize="10" fill="var(--good)" style={{ userSelect: 'none' }}>
                    ▶ entry
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
