import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Call, CallSchema } from '../../schemas/call.schema';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { FlowVersion, FlowVersionSchema } from '../../schemas/flow.schema';
import { Lead, LeadSchema } from '../../schemas/lead.schema';
import { CountryPacksModule } from '../country-packs/country-packs.module';
import { LeadsModule } from '../leads/leads.module';
import { ProvidersModule } from '../providers/providers.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { EngineController } from './engine.controller';
import { FlowExecutorService } from './flow-executor.service';

@Module({
  imports: [
    ProvidersModule,
    LeadsModule,
    CountryPacksModule,
    WorkspaceModule,
    MongooseModule.forFeature([
      { name: Call.name, schema: CallSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: FlowVersion.name, schema: FlowVersionSchema },
    ]),
  ],
  controllers: [EngineController],
  providers: [FlowExecutorService],
  exports: [FlowExecutorService],
})
export class EngineModule {}
