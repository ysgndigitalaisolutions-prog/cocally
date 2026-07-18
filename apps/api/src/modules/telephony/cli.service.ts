import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CliNumber, CliNumberDocument } from '../../schemas/cli-number.schema';

/** CLI pool management per TEL-07: geo-matching, rotation, health-based rest. */
@Injectable()
export class CliService {
  private rotationCursor = 0;

  constructor(@InjectModel(CliNumber.name) private readonly cliModel: Model<CliNumberDocument>) {}

  /**
   * Pick a CLI for a dial: prefer geo-matched (e.g. 03 numbers to VIC leads),
   * skip resting/quarantined numbers, rotate within the healthy set.
   */
  async selectCli(input: {
    tenantId: string;
    poolIds: Types.ObjectId[];
    leadState?: string;
    geoMatch: boolean;
  }): Promise<CliNumberDocument | null> {
    const filter = {
      tenantId: new Types.ObjectId(input.tenantId),
      status: 'ACTIVE' as const,
      ...(input.poolIds.length > 0 ? { _id: { $in: input.poolIds } } : {}),
    };
    const candidates = await this.cliModel.find(filter).sort({ _id: 1 }).exec();
    if (candidates.length === 0) return null;

    let pool = candidates;
    if (input.geoMatch && input.leadState) {
      const matched = candidates.filter((c) => c.geoRegion === input.leadState);
      if (matched.length > 0) pool = matched;
    }

    this.rotationCursor = (this.rotationCursor + 1) % pool.length;
    return pool[this.rotationCursor % pool.length] ?? null;
  }

  async recordDial(cliId: Types.ObjectId, answered: boolean): Promise<void> {
    await this.cliModel
      .updateOne({ _id: cliId }, { $inc: { dialsToday: 1, ...(answered ? { answersToday: 1 } : {}) } })
      .exec();
    // Automatic rest on spam-flag suspicion: heavy dials with collapsing
    // answer rate sends the number to RESTING for 24h.
    const cli = await this.cliModel.findById(cliId).exec();
    if (cli && cli.dialsToday >= 50 && cli.answersToday / cli.dialsToday < 0.05) {
      cli.status = 'RESTING';
      cli.restingUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await cli.save();
    }
  }

  /** Called by the ops scheduler: wake numbers whose rest period elapsed and reset daily counters at midnight. */
  async wakeRested(): Promise<void> {
    await this.cliModel
      .updateMany({ status: 'RESTING', restingUntil: { $lte: new Date() } }, { status: 'ACTIVE', restingUntil: null })
      .exec();
  }

  async resetDailyCounters(): Promise<void> {
    await this.cliModel.updateMany({}, { dialsToday: 0, answersToday: 0 }).exec();
  }

  async addNumber(tenantId: string, input: { number: string; geoRegion?: string; countryPackCode: string }) {
    return this.cliModel.create({ tenantId: new Types.ObjectId(tenantId), ...input });
  }

  async list(tenantId: string) {
    return this.cliModel.find({ tenantId: new Types.ObjectId(tenantId) }).lean().exec();
  }
}
