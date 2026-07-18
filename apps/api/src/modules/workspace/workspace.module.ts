import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AgentActivity, AgentActivitySchema } from '../../schemas/agent-activity.schema';
import { Call, CallSchema } from '../../schemas/call.schema';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { Lead, LeadSchema } from '../../schemas/lead.schema';
import { Transfer, TransferSchema } from '../../schemas/transfer.schema';
import { User, UserSchema } from '../../schemas/user.schema';
import { PresenceService } from './presence.service';
import { RealtimeGateway } from './realtime.gateway';
import { TransfersService } from './transfers.service';
import { WorkspaceController } from './workspace.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Call.name, schema: CallSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: Transfer.name, schema: TransferSchema },
      { name: AgentActivity.name, schema: AgentActivitySchema },
    ]),
  ],
  controllers: [WorkspaceController],
  providers: [PresenceService, RealtimeGateway, TransfersService],
  exports: [PresenceService, RealtimeGateway, TransfersService],
})
export class WorkspaceModule {}
