import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Call, CallSchema } from '../../schemas/call.schema';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { CliNumber, CliNumberSchema } from '../../schemas/cli-number.schema';
import { Lead, LeadSchema } from '../../schemas/lead.schema';
import { Tenant, TenantSchema } from '../../schemas/tenant.schema';
import { CountryPacksModule } from '../country-packs/country-packs.module';
import { EngineModule } from '../engine/engine.module';
import { FlowsModule } from '../flows/flows.module';
import { LeadsModule } from '../leads/leads.module';
import { ProvidersModule } from '../providers/providers.module';
import { RecordingsModule } from '../recordings/recordings.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { CallOrchestratorService } from './call-orchestrator.service';
import { CallsController } from './calls.controller';
import { CliService } from './cli.service';
import { DialerService } from './dialer.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Call.name, schema: CallSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: CliNumber.name, schema: CliNumberSchema },
    ]),
    CountryPacksModule,
    EngineModule,
    FlowsModule,
    LeadsModule,
    ProvidersModule,
    RecordingsModule,
    WebhooksModule,
    WorkspaceModule,
  ],
  controllers: [CallsController],
  providers: [CallOrchestratorService, CliService, DialerService],
  exports: [CallOrchestratorService, CliService, DialerService],
})
export class TelephonyModule {}
