import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Call, CallSchema } from '../../schemas/call.schema';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { CliNumber, CliNumberSchema } from '../../schemas/cli-number.schema';
import { Lead, LeadSchema } from '../../schemas/lead.schema';
import { Tenant, TenantSchema } from '../../schemas/tenant.schema';
import { Transfer, TransferSchema } from '../../schemas/transfer.schema';
import { User, UserSchema } from '../../schemas/user.schema';
import { AuditModule } from '../audit/audit.module';
import { CountryPacksModule } from '../country-packs/country-packs.module';
import { EngineModule } from '../engine/engine.module';
import { FlowsModule } from '../flows/flows.module';
import { LeadsModule } from '../leads/leads.module';
import { ProvidersModule } from '../providers/providers.module';
import { RecordingsModule } from '../recordings/recordings.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SupervisionController } from '../workspace/supervision.controller';
import { SupervisionService } from '../workspace/supervision.service';
import { CallControlController, CurrentCallController } from './call-control.controller';
import { CallControlService } from './call-control.service';
import { CallOrchestratorService } from './call-orchestrator.service';
import { CallProgressService } from './call-progress.service';
import { CallsController } from './calls.controller';
import { LiveCallDriver } from './live-call.driver';
import { LivekitWebhookController } from './livekit-webhook.controller';
import { CliController } from './cli.controller';
import { CliService } from './cli.service';
import { DialerController } from './dialer.controller';
import { DialerService } from './dialer.service';
import { LivekitService } from './livekit.service';
import { ManualDialController } from './manual-dial.controller';
import { ManualDialService } from './manual-dial.service';
import { PredictiveDialerController } from './predictive-dialer.controller';
import { PredictiveDialerService } from './predictive-dialer.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Call.name, schema: CallSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: CliNumber.name, schema: CliNumberSchema },
      { name: User.name, schema: UserSchema },
      // Call-bar recovery re-serves the AI transfer card, so the Transfer
      // model has to be reachable from this module too.
      { name: Transfer.name, schema: TransferSchema },
    ]),
    AuditModule,
    CountryPacksModule,
    EngineModule,
    FlowsModule,
    LeadsModule,
    ProvidersModule,
    RecordingsModule,
    WebhooksModule,
    WorkspaceModule,
  ],
  controllers: [
    CallsController,
    CliController,
    DialerController,
    ManualDialController,
    PredictiveDialerController,
    // Agent call control (hold, agent-to-agent transfer) and the call-bar
    // recovery endpoint. `CurrentCallController` is mounted here rather than
    // in WorkspaceModule because it needs LivekitService to mint a fresh
    // room token, and TelephonyModule already imports WorkspaceModule —
    // registering it the other way round would be a module cycle.
    CallControlController,
    CurrentCallController,
    // Supervisor monitor/whisper/barge — same reasoning: it needs LivekitService.
    SupervisionController,
    LivekitWebhookController,
  ],
  providers: [
    CallOrchestratorService,
    CliService,
    DialerService,
    ManualDialService,
    LivekitService,
    PredictiveDialerService,
    LiveCallDriver,
    CallProgressService,
    CallControlService,
    SupervisionService,
  ],
  exports: [
    CallOrchestratorService,
    CliService,
    DialerService,
    LivekitService,
    PredictiveDialerService,
    LiveCallDriver,
    CallProgressService,
    CallControlService,
  ],
})
export class TelephonyModule {}
