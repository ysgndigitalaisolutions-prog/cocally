import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CountryPack, CountryPackDocument } from '../../schemas/country-pack.schema';
import { AU_PACK } from './au.pack';
import { isWithinCallingWindow, nextWindowOpen } from './calling-windows';

@Injectable()
export class CountryPacksService implements OnModuleInit {
  constructor(@InjectModel(CountryPack.name) private readonly packModel: Model<CountryPackDocument>) {}

  /** Ensure the AU launch pack exists (CP-02) without overwriting admin edits. */
  async onModuleInit(): Promise<void> {
    await this.packModel.updateOne({ code: 'AU' }, { $setOnInsert: AU_PACK }, { upsert: true }).exec();
  }

  async list() {
    return this.packModel.find({ active: true }).lean().exec();
  }

  async getByCode(code: string) {
    const pack = await this.packModel.findOne({ code: code.toUpperCase() }).lean().exec();
    if (!pack) throw new NotFoundException(`Country pack ${code} not found`);
    return pack;
  }

  async isCallableNow(code: string, timezone: string, at: Date = new Date()): Promise<boolean> {
    const pack = await this.getByCode(code);
    return isWithinCallingWindow(pack, timezone, at);
  }

  async nextCallableAt(code: string, timezone: string, from: Date = new Date()): Promise<Date | null> {
    const pack = await this.getByCode(code);
    return nextWindowOpen(pack, timezone, from);
  }
}
