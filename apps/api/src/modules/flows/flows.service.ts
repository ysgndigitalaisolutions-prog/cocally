import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { flowGraphSchema, validateFlowGraph, type FlowGraph } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { Flow, FlowDocument, FlowVersion, FlowVersionDocument } from '../../schemas/flow.schema';
import { AuditService } from '../audit/audit.service';
import { CountryPacksService } from '../country-packs/country-packs.service';

@Injectable()
export class FlowsService {
  constructor(
    @InjectModel(Flow.name) private readonly flowModel: Model<FlowDocument>,
    @InjectModel(FlowVersion.name) private readonly versionModel: Model<FlowVersionDocument>,
    private readonly packs: CountryPacksService,
    private readonly audit: AuditService,
  ) {}

  async create(tenantId: string, input: { name: string; direction?: 'OUTBOUND' | 'INBOUND' }) {
    return this.flowModel.create({
      tenantId: new Types.ObjectId(tenantId),
      name: input.name,
      direction: input.direction ?? 'OUTBOUND',
    });
  }

  async list(tenantId: string) {
    const flows = await this.flowModel.find({ tenantId: new Types.ObjectId(tenantId) }).lean().exec();
    const versions = await this.versionModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .select('flowId version state')
      .lean()
      .exec();
    return flows.map((f) => ({
      ...f,
      versions: versions.filter((v) => v.flowId.toString() === f._id.toString()),
    }));
  }

  /** Save a draft version per FLOW-04. Drafts are mutable until published. */
  async saveDraft(tenantId: string, flowId: string, graph: unknown, changeNote?: string) {
    const flow = await this.flowModel
      .findOne({ _id: new Types.ObjectId(flowId), tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!flow) throw new NotFoundException('Flow not found');

    const parsed = flowGraphSchema.safeParse(graph);
    if (!parsed.success) {
      throw new BadRequestException({ message: 'Invalid flow graph', issues: parsed.error.issues });
    }

    const existing = await this.versionModel.findOne({ flowId: flow._id, state: 'DRAFT' }).exec();
    if (existing) {
      existing.graph = parsed.data;
      if (changeNote) existing.changeNote = changeNote;
      await existing.save();
      return existing;
    }

    const latest = await this.versionModel.findOne({ flowId: flow._id }).sort({ version: -1 }).lean().exec();
    return this.versionModel.create({
      tenantId: flow.tenantId,
      flowId: flow._id,
      version: (latest?.version ?? 0) + 1,
      state: 'DRAFT',
      graph: parsed.data,
      changeNote,
    });
  }

  /**
   * Publish per FLOW-04: validates structure, enforces mandatory compliance
   * nodes per AI-08 for the campaign's country pack, freezes the version.
   */
  async publish(
    tenantId: string,
    actor: { id: string; label: string },
    flowId: string,
    countryPackCode = 'AU',
  ) {
    const draft = await this.versionModel
      .findOne({ flowId: new Types.ObjectId(flowId), tenantId: new Types.ObjectId(tenantId), state: 'DRAFT' })
      .exec();
    if (!draft) throw new NotFoundException('No draft version to publish');

    const issues = validateFlowGraph(draft.graph);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      throw new BadRequestException({ message: 'Flow failed validation', issues: errors });
    }

    // Compliance-line enforcement per AI-08: when the pack requires the
    // recording disclosure, the graph must contain a mandatory SPEAK/PLAY
    // node carrying it before any AI_CONVERSATION node can run.
    const pack = await this.packs.getByCode(countryPackCode);
    if (pack.disclosures.recordingDisclosureRequired) {
      const hasDisclosure = draft.graph.nodes.some(
        (n) => n.mandatory && (n.type === 'SPEAK' || n.type === 'PLAY_AUDIO'),
      );
      if (!hasDisclosure) {
        throw new BadRequestException({
          message: `Country pack ${countryPackCode} requires a mandatory recording-disclosure node (mark a SPEAK/PLAY_AUDIO node as mandatory).`,
        });
      }
    }

    draft.state = 'PUBLISHED';
    draft.publishedBy = new Types.ObjectId(actor.id);
    draft.publishedAt = new Date();
    await draft.save();

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'flow.publish',
      entityType: 'FlowVersion',
      entityId: draft._id.toString(),
      after: { flowId, version: draft.version },
    });

    return draft;
  }

  async getVersion(tenantId: string, versionId: string) {
    const version = await this.versionModel
      .findOne({ _id: new Types.ObjectId(versionId), tenantId: new Types.ObjectId(tenantId) })
      .lean()
      .exec();
    if (!version) throw new NotFoundException('Flow version not found');
    return version;
  }

  async getPublishedGraph(versionId: Types.ObjectId): Promise<FlowGraph> {
    const version = await this.versionModel.findById(versionId).lean().exec();
    if (!version || version.state !== 'PUBLISHED') {
      throw new NotFoundException('Published flow version not found');
    }
    return version.graph;
  }

  async listVersions(tenantId: string, flowId: string) {
    return this.versionModel
      .find({ flowId: new Types.ObjectId(flowId), tenantId: new Types.ObjectId(tenantId) })
      .sort({ version: -1 })
      .select('-graph')
      .lean()
      .exec();
  }
}
