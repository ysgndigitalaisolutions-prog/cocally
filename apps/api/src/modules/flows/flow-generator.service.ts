import { Injectable, Logger } from '@nestjs/common';
import { flowGraphSchema, validateFlowGraph, type FlowGraph } from '@cocally/shared';
import { PalService } from '../providers/pal.service';

export interface GenerateFlowInput {
  name: string;
  /** Plain-language campaign description the admin writes. */
  description: string;
  /** Default step: on VOICEMAIL, speak a drop message (TEL-05). On by default. */
  voicemailStep: boolean;
  /** Default step: on IVR ("press 1 to connect"), send DTMF and re-classify (TEL-06). On by default. */
  ivrKeypressStep: boolean;
  ivrDigits?: string;
}

/** Campaign-specific content the LLM writes; structure stays deterministic. */
interface GeneratedContent {
  conversationPrompt: string;
  disclosureText: string;
  voicemailDropText: string;
  fallbackText: string;
  notInterestedText: string;
  captureVariables: string[];
}

/**
 * Prompt → workflow generation. The graph STRUCTURE is assembled
 * deterministically from a proven outbound pattern (AMD branch → optional
 * voicemail/IVR default steps → mandatory disclosure → AI qualification →
 * transfer → fallback → typed ends) so every generated flow is valid and
 * executable. The LLM writes only the CONTENT — conversation prompt,
 * disclosure, voicemail drop, fallback lines, capture variables — from the
 * admin's description. With no LLM key configured, a template fallback
 * derives content directly from the description.
 */
@Injectable()
export class FlowGeneratorService {
  private readonly logger = new Logger(FlowGeneratorService.name);

  constructor(private readonly pal: PalService) {}

  async generate(tenantId: string, input: GenerateFlowInput): Promise<{ graph: FlowGraph; contentSource: 'llm' | 'template' }> {
    const { content, source } = await this.generateContent(tenantId, input.description);
    const graph = this.assembleGraph(input, content);

    // Belt and braces: a generated flow must always pass the same validation
    // a hand-built one does before it can be saved.
    const parsed = flowGraphSchema.parse(graph);
    const errors = validateFlowGraph(parsed).filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      throw new Error(`Generated flow failed validation: ${errors.map((e) => e.code).join(', ')}`);
    }
    return { graph: parsed, contentSource: source };
  }

  private async generateContent(
    tenantId: string,
    description: string,
  ): Promise<{ content: GeneratedContent; source: 'llm' | 'template' }> {
    try {
      const completion = await this.pal.llm(
        { tenantId, llmRole: 'CONVERSATION' },
        {
          jsonMode: true,
          temperature: 0.4,
          maxTokens: 900,
          messages: [
            {
              role: 'system',
              content: [
                'You design outbound call-centre scripts. From the campaign description, produce JSON with exactly these keys:',
                '"conversationPrompt": a system prompt for the AI voice agent (persona, goal, the qualification questions to work through one at a time, tone rules: brief, warm, never pushy, never re-ask answered questions).',
                '"disclosureText": one spoken sentence greeting {{firstName}}, identifying the AI and the client, and disclosing recording. Use {{firstName}} and {{clientName}} placeholders.',
                '"voicemailDropText": a ≤2 sentence voicemail message for {{firstName}} that creates a callback reason without sounding like spam.',
                '"fallbackText": one sentence spoken when no human agent is free, promising a prompt callback, addressing {{firstName}}.',
                '"notInterestedText": one graceful goodbye sentence for uninterested customers.',
                '"captureVariables": array of 3-6 snake/camelCase fact keys the agent should capture (e.g. owner, billHigh).',
                'Respond with ONLY the JSON object.',
              ].join('\n'),
            },
            { role: 'user', content: description },
          ],
        },
      );
      const jsonStart = completion.text.indexOf('{');
      const jsonEnd = completion.text.lastIndexOf('}');
      const parsed = JSON.parse(completion.text.slice(jsonStart, jsonEnd + 1)) as Partial<GeneratedContent>;
      if (
        typeof parsed.conversationPrompt === 'string' &&
        parsed.conversationPrompt.length > 40 &&
        typeof parsed.disclosureText === 'string'
      ) {
        return {
          source: 'llm',
          content: {
            conversationPrompt: parsed.conversationPrompt,
            disclosureText: parsed.disclosureText,
            voicemailDropText: parsed.voicemailDropText ?? this.templateContent(description).voicemailDropText,
            fallbackText: parsed.fallbackText ?? this.templateContent(description).fallbackText,
            notInterestedText: parsed.notInterestedText ?? this.templateContent(description).notInterestedText,
            captureVariables:
              Array.isArray(parsed.captureVariables) && parsed.captureVariables.length > 0
                ? parsed.captureVariables.map(String)
                : this.templateContent(description).captureVariables,
          },
        };
      }
      this.logger.warn('LLM content generation returned unusable shape; using template fallback');
    } catch (err) {
      this.logger.warn(`LLM content generation failed (${(err as Error).message}); using template fallback`);
    }
    return { content: this.templateContent(description), source: 'template' };
  }

  /** No-LLM fallback: the admin's description becomes the core of the conversation prompt. */
  private templateContent(description: string): GeneratedContent {
    return {
      conversationPrompt: [
        'You are a warm, natural outbound assistant on a phone call.',
        `CAMPAIGN BRIEF: ${description.trim()}`,
        'Work through the qualification naturally, one question at a time. Be brief and conversational — spoken language, not written. Never pushy. Acknowledge objections gracefully and never contradict the customer.',
      ].join('\n'),
      disclosureText:
        "Hi {{firstName}}, I'm an AI assistant calling on behalf of {{clientName}}. This call may be recorded for quality purposes.",
      voicemailDropText:
        "Hi {{firstName}}, it's the team at {{clientName}} — we have something worth a quick chat about your account. We'll try you again soon.",
      fallbackText:
        'All of our specialists are helping other customers right now — we will call you back shortly to lock in a time. Thanks {{firstName}}!',
      notInterestedText: 'No worries at all — thanks for your time, and have a great day.',
      captureVariables: ['owner', 'billHigh', 'appointmentInterest'],
    };
  }

  /** Deterministic structure; the two default steps are included per their toggles. */
  private assembleGraph(input: GenerateFlowInput, content: GeneratedContent): FlowGraph {
    const nodes: FlowGraph['nodes'] = [];
    const edges: FlowGraph['edges'] = [];
    let y = 0;
    const at = (x: number) => ({ x, y: (y += 120) });

    nodes.push({ id: 'amd', type: 'AMD_CLASSIFY', label: 'Who answered?', mandatory: false, config: {}, position: at(400) });

    // Default step 1 — voicemail drop (TEL-05), toggleable.
    if (input.voicemailStep) {
      nodes.push({
        id: 'voicemail-drop',
        type: 'SPEAK',
        label: 'Default step: voicemail drop',
        mandatory: false,
        config: { text: content.voicemailDropText, interruptible: false },
        position: { x: 750, y: 240 },
      });
      nodes.push({
        id: 'end-voicemail',
        type: 'END',
        label: 'Voicemail left',
        mandatory: false,
        config: { outcome: 'VOICEMAIL_DROPPED' },
        position: { x: 750, y: 360 },
      });
      edges.push({ id: 'e-amd-vm', from: 'amd', to: 'voicemail-drop', conditions: [{ variable: 'amd.class', operator: 'eq', value: 'VOICEMAIL' }], priority: 1 });
      edges.push({ id: 'e-vm-end', from: 'voicemail-drop', to: 'end-voicemail', conditions: [], priority: 0 });
    }

    // Default step 2 — IVR keypress ("press 1 to connect", TEL-06), toggleable.
    if (input.ivrKeypressStep) {
      nodes.push({
        id: 'ivr-keypress',
        type: 'SEND_DTMF',
        label: 'Default step: IVR keypress',
        mandatory: false,
        config: { digits: input.ivrDigits ?? '1', maxMenuDepth: 3 },
        position: { x: 60, y: 240 },
      });
      nodes.push({ id: 'amd-recheck', type: 'AMD_CLASSIFY', label: 'Re-classify after keypress', mandatory: false, config: {}, position: { x: 60, y: 360 } });
      edges.push({ id: 'e-amd-ivr', from: 'amd', to: 'ivr-keypress', conditions: [{ variable: 'amd.class', operator: 'eq', value: 'IVR' }], priority: 2 });
      edges.push({ id: 'e-ivr-recheck', from: 'ivr-keypress', to: 'amd-recheck', conditions: [], priority: 0 });
      edges.push({ id: 'e-recheck-human', from: 'amd-recheck', to: 'disclosure', conditions: [{ variable: 'amd.class', operator: 'eq', value: 'HUMAN' }], priority: 0 });
      edges.push({ id: 'e-recheck-default', from: 'amd-recheck', to: 'end-missed', conditions: [], priority: 10 });
    }

    nodes.push({
      id: 'disclosure',
      type: 'SPEAK',
      label: 'Compliance disclosure',
      mandatory: true,
      config: { text: content.disclosureText, interruptible: false },
      position: at(400),
    });
    nodes.push({
      id: 'qualify',
      type: 'AI_CONVERSATION',
      label: 'AI qualification',
      mandatory: false,
      config: {
        prompt: content.conversationPrompt,
        exitIntents: ['qualified', 'callback', 'not_interested', 'silence', 'max_turns', 'capture_failed'],
        captureVariables: content.captureVariables,
        maxTurns: 16,
      },
      position: at(400),
    });
    nodes.push({
      id: 'transfer',
      type: 'TRANSFER',
      label: 'Warm transfer',
      mandatory: false,
      config: { strategy: 'LONGEST_IDLE', whisperEnabled: false, acceptWindowSeconds: 13 },
      position: at(400),
    });
    nodes.push({
      id: 'transfer-fallback',
      type: 'SPEAK',
      label: 'No agent free — promise callback',
      mandatory: false,
      config: { text: content.fallbackText, interruptible: false },
      position: at(400),
    });
    nodes.push({
      id: 'goodbye-nurture',
      type: 'SPEAK',
      label: 'Graceful goodbye',
      mandatory: false,
      config: { text: content.notInterestedText, interruptible: false },
      position: { x: 750, y: 600 },
    });

    nodes.push({ id: 'end-qualified', type: 'END', label: 'Qualified', mandatory: false, config: { outcome: 'QUALIFIED' }, position: at(400) });
    nodes.push({ id: 'end-nurture', type: 'END', label: 'Nurture', mandatory: false, config: { outcome: 'NURTURE' }, position: { x: 750, y: 720 } });
    nodes.push({ id: 'end-missed', type: 'END', label: 'No contact', mandatory: false, config: { outcome: 'COMPLETE' }, position: { x: 60, y: 480 } });

    edges.push({ id: 'e-amd-human', from: 'amd', to: 'disclosure', conditions: [{ variable: 'amd.class', operator: 'eq', value: 'HUMAN' }], priority: 0 });
    edges.push({ id: 'e-amd-default', from: 'amd', to: 'end-missed', conditions: [], priority: 10 });
    edges.push({ id: 'e-disc-qualify', from: 'disclosure', to: 'qualify', conditions: [], priority: 0 });
    edges.push({ id: 'e-qualified', from: 'qualify', to: 'transfer', conditions: [{ variable: 'intent', operator: 'eq', value: 'qualified' }], priority: 0 });
    edges.push({ id: 'e-not-interested', from: 'qualify', to: 'goodbye-nurture', conditions: [{ variable: 'intent', operator: 'eq', value: 'not_interested' }], priority: 1 });
    edges.push({ id: 'e-qualify-default', from: 'qualify', to: 'end-missed', conditions: [], priority: 10 });
    edges.push({ id: 'e-goodbye-end', from: 'goodbye-nurture', to: 'end-nurture', conditions: [], priority: 0 });
    edges.push({ id: 'e-transfer-fallback', from: 'transfer', to: 'transfer-fallback', conditions: [], priority: 0 });
    edges.push({ id: 'e-fallback-end', from: 'transfer-fallback', to: 'end-qualified', conditions: [], priority: 0 });

    return { entryNodeId: 'amd', nodes, edges };
  }
}
