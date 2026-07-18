import { z } from 'zod';

/**
 * Flow graph contract per FLOW-01/02: a call is a directed graph of typed
 * nodes with conditions on edges. Validated at publish time and re-validated
 * by the executor at load time.
 */

export const conditionOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
  'exists',
]);

export const edgeConditionSchema = z.object({
  /** Variable path, e.g. "amd.class", "score", "vars.owner", "attempt". */
  variable: z.string().min(1),
  operator: conditionOperatorSchema,
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
});
export type EdgeCondition = z.infer<typeof edgeConditionSchema>;

export const flowEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  /** All conditions must hold (AND). Empty/absent = unconditional default edge. */
  conditions: z.array(edgeConditionSchema).default([]),
  /** Lower runs first when several edges match. */
  priority: z.number().int().default(0),
  label: z.string().optional(),
});
export type FlowEdge = z.infer<typeof flowEdgeSchema>;

const baseNode = {
  id: z.string().min(1),
  label: z.string().optional(),
  /** Per-node PAL overrides per PAL-04 (provider/model ids by capability). */
  providerOverrides: z
    .object({
      tts: z.string().optional(),
      stt: z.string().optional(),
      llm: z.string().optional(),
    })
    .optional(),
  /** Mandatory compliance nodes cannot be deleted when the pack requires them (AI-08). */
  mandatory: z.boolean().default(false),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
};

export const playAudioNodeSchema = z.object({
  ...baseNode,
  type: z.literal('PLAY_AUDIO'),
  config: z.object({
    assetId: z.string().min(1),
    interruptible: z.boolean().default(false),
  }),
});

export const speakNodeSchema = z.object({
  ...baseNode,
  type: z.literal('SPEAK'),
  config: z.object({
    /** Text with {{variable}} interpolation. */
    text: z.string().min(1),
    interruptible: z.boolean().default(true),
  }),
});

export const aiConversationNodeSchema = z.object({
  ...baseNode,
  type: z.literal('AI_CONVERSATION'),
  config: z.object({
    prompt: z.string().min(1),
    /** Intents that exit this node, matched against LLM-emitted intent. */
    exitIntents: z.array(z.string()).default([]),
    /** Variables the node is expected to capture into call state. */
    captureVariables: z.array(z.string()).default([]),
    maxTurns: z.number().int().positive().default(20),
  }),
});

export const listenCaptureNodeSchema = z.object({
  ...baseNode,
  type: z.literal('LISTEN_CAPTURE'),
  config: z.object({
    variable: z.string().min(1),
    fieldType: z.enum(['text', 'number', 'phone', 'yes_no', 'datetime']),
    promptText: z.string().min(1),
    /** Read-back confirmation per NFR accuracy for numbers/phones. */
    confirm: z.boolean().default(false),
    maxRetries: z.number().int().min(0).default(2),
  }),
});

export const amdClassifyNodeSchema = z.object({
  ...baseNode,
  type: z.literal('AMD_CLASSIFY'),
  config: z.object({}).default({}),
});

export const sendDtmfNodeSchema = z.object({
  ...baseNode,
  type: z.literal('SEND_DTMF'),
  config: z.object({
    digits: z.string().regex(/^[0-9*#,]+$/),
    /** Loop guard per TEL-06. */
    maxMenuDepth: z.number().int().positive().default(3),
  }),
});

export const branchNodeSchema = z.object({
  ...baseNode,
  type: z.literal('BRANCH'),
  config: z.object({}).default({}),
});

export const transferNodeSchema = z.object({
  ...baseNode,
  type: z.literal('TRANSFER'),
  config: z.object({
    strategy: z
      .enum(['LONGEST_IDLE', 'ROUND_ROBIN', 'LEAST_TALK_TIME', 'SKILL_PRIORITY', 'STICKY'])
      .default('LONGEST_IDLE'),
    whisperEnabled: z.boolean().default(false),
    /** Seconds an agent has to accept before cascade (XFER-04). */
    acceptWindowSeconds: z.number().int().min(5).max(30).default(13),
    summaryTemplateId: z.string().optional(),
  }),
});

export const webhookNodeSchema = z.object({
  ...baseNode,
  type: z.literal('WEBHOOK'),
  config: z.object({
    url: z.string().url(),
    method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
    /** Variables from call state to include in the payload. */
    includeVariables: z.array(z.string()).default([]),
  }),
});

export const setRetryNodeSchema = z.object({
  ...baseNode,
  type: z.literal('SET_RETRY'),
  config: z.object({
    delayMinutes: z.number().int().min(0),
    shiftTimeBand: z.boolean().default(false),
  }),
});

export const endNodeSchema = z.object({
  ...baseNode,
  type: z.literal('END'),
  config: z.object({
    disposition: z.enum([
      'BOOKED',
      'CALLBACK',
      'NOT_INTERESTED',
      'NOT_QUALIFIED',
      'WRONG_NUMBER',
      'DO_NOT_CALL',
      'FOLLOW_UP',
    ]).optional(),
    outcome: z.enum(['QUALIFIED', 'NURTURE', 'RELEASE', 'OPT_OUT', 'VOICEMAIL_DROPPED', 'COMPLETE']).default('COMPLETE'),
  }),
});

export const flowNodeSchema = z.discriminatedUnion('type', [
  playAudioNodeSchema,
  speakNodeSchema,
  aiConversationNodeSchema,
  listenCaptureNodeSchema,
  amdClassifyNodeSchema,
  sendDtmfNodeSchema,
  branchNodeSchema,
  transferNodeSchema,
  webhookNodeSchema,
  setRetryNodeSchema,
  endNodeSchema,
]);
export type FlowNode = z.infer<typeof flowNodeSchema>;

export const flowGraphSchema = z.object({
  entryNodeId: z.string().min(1),
  nodes: z.array(flowNodeSchema).min(1),
  edges: z.array(flowEdgeSchema),
});
export type FlowGraph = z.infer<typeof flowGraphSchema>;

export interface FlowValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

/**
 * Structural validation beyond the zod schema: referential integrity,
 * reachability, terminality, and per-node-type edge rules.
 */
export function validateFlowGraph(graph: FlowGraph): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  if (graph.nodes.length !== nodeIds.size) {
    issues.push({ severity: 'error', code: 'DUPLICATE_NODE_ID', message: 'Node ids must be unique.' });
  }
  if (!nodeIds.has(graph.entryNodeId)) {
    issues.push({
      severity: 'error',
      code: 'MISSING_ENTRY',
      message: `Entry node "${graph.entryNodeId}" does not exist.`,
    });
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from)) {
      issues.push({
        severity: 'error',
        code: 'EDGE_BAD_SOURCE',
        message: `Edge "${edge.id}" references missing source node "${edge.from}".`,
        edgeId: edge.id,
      });
    }
    if (!nodeIds.has(edge.to)) {
      issues.push({
        severity: 'error',
        code: 'EDGE_BAD_TARGET',
        message: `Edge "${edge.id}" references missing target node "${edge.to}".`,
        edgeId: edge.id,
      });
    }
  }

  // Reachability from entry.
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  const reachable = new Set<string>();
  const stack = [graph.entryNodeId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) {
      issues.push({
        severity: 'warning',
        code: 'UNREACHABLE_NODE',
        message: `Node "${node.id}" is unreachable from the entry node.`,
        nodeId: node.id,
      });
    }
  }

  // Every non-END reachable node needs at least one outgoing edge.
  for (const node of graph.nodes) {
    if (node.type === 'END') continue;
    if (!reachable.has(node.id)) continue;
    const outgoing = graph.edges.filter((e) => e.from === node.id);
    if (outgoing.length === 0) {
      issues.push({
        severity: 'error',
        code: 'DEAD_END',
        message: `Node "${node.id}" (${node.type}) has no outgoing edges; calls would stall.`,
        nodeId: node.id,
      });
    } else if (node.type !== 'AMD_CLASSIFY' && node.type !== 'BRANCH' && node.type !== 'AI_CONVERSATION') {
      const hasDefault = outgoing.some((e) => e.conditions.length === 0);
      if (!hasDefault) {
        issues.push({
          severity: 'warning',
          code: 'NO_DEFAULT_EDGE',
          message: `Node "${node.id}" has only conditional edges; add a default edge to avoid stalls.`,
          nodeId: node.id,
        });
      }
    }
  }

  // At least one reachable END node.
  const hasEnd = graph.nodes.some((n) => n.type === 'END' && reachable.has(n.id));
  if (!hasEnd) {
    issues.push({ severity: 'error', code: 'NO_END', message: 'Flow has no reachable END node.' });
  }

  return issues;
}
