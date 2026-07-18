import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { FlowVersion, FlowVersionSchema } from '../../schemas/flow.schema';
import { Client, ClientSchema } from '../../schemas/tenant.schema';
import { AuditModule } from '../audit/audit.module';
import { CountryPacksModule } from '../country-packs/country-packs.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Campaign.name, schema: CampaignSchema },
      { name: Client.name, schema: ClientSchema },
      { name: FlowVersion.name, schema: FlowVersionSchema },
    ]),
    AuditModule,
    CountryPacksModule,
  ],
  controllers: [CampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
