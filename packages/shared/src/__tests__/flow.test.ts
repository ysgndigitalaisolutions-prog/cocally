import { describe, expect, it } from 'vitest';
import { flowGraphSchema, validateFlowGraph, type FlowGraph } from '../flow.js';

function minimalFlow(): FlowGraph {
  return flowGraphSchema.parse({
    entryNodeId: 'amd',
    nodes: [
      { id: 'amd', type: 'AMD_CLASSIFY', config: {} },
      { id: 'speak', type: 'SPEAK', config: { text: 'Hello {{firstName}}' } },
      { id: 'end', type: 'END', config: { outcome: 'COMPLETE' } },
    ],
    edges: [
      { id: 'e1', from: 'amd', to: 'speak', conditions: [{ variable: 'amd.class', operator: 'eq', value: 'HUMAN' }] },
      { id: 'e2', from: 'amd', to: 'end', conditions: [], priority: 10 },
      { id: 'e3', from: 'speak', to: 'end', conditions: [] },
    ],
  });
}

describe('validateFlowGraph', () => {
  it('accepts a well-formed flow', () => {
    const issues = validateFlowGraph(minimalFlow());
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('flags dead-end nodes', () => {
    const flow = minimalFlow();
    flow.edges = flow.edges.filter((e) => e.id !== 'e3');
    const issues = validateFlowGraph(flow);
    expect(issues.some((i) => i.code === 'DEAD_END' && i.nodeId === 'speak')).toBe(true);
  });

  it('flags missing END', () => {
    const flow = flowGraphSchema.parse({
      entryNodeId: 'a',
      nodes: [{ id: 'a', type: 'SPEAK', config: { text: 'hi' } }],
      edges: [{ id: 'loop', from: 'a', to: 'a', conditions: [] }],
    });
    const issues = validateFlowGraph(flow);
    expect(issues.some((i) => i.code === 'NO_END')).toBe(true);
  });

  it('flags edges pointing at missing nodes', () => {
    const flow = minimalFlow();
    flow.edges.push({ id: 'bad', from: 'speak', to: 'ghost', conditions: [], priority: 0 });
    const issues = validateFlowGraph(flow);
    expect(issues.some((i) => i.code === 'EDGE_BAD_TARGET')).toBe(true);
  });
});
