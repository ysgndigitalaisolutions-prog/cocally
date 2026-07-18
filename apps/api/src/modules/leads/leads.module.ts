import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { Lead, LeadImport, LeadImportSchema, LeadList, LeadListSchema, LeadSchema } from '../../schemas/lead.schema';
import { DncWashRecord, DncWashRecordSchema, SuppressionEntry, SuppressionEntrySchema } from '../../schemas/suppression.schema';
import { AuditModule } from '../audit/audit.module';
import { CountryPacksModule } from '../country-packs/country-packs.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { SuppressionService } from './suppression.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Lead.name, schema: LeadSchema },
      { name: LeadList.name, schema: LeadListSchema },
      { name: LeadImport.name, schema: LeadImportSchema },
      { name: SuppressionEntry.name, schema: SuppressionEntrySchema },
      { name: DncWashRecord.name, schema: DncWashRecordSchema },
      { name: Campaign.name, schema: CampaignSchema },
    ]),
    AuditModule,
    CountryPacksModule,
  ],
  controllers: [LeadsController],
  providers: [LeadsService, SuppressionService],
  exports: [LeadsService, SuppressionService],
})
export class LeadsModule {}
