import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AgentActivity, AgentActivitySchema } from '../../schemas/agent-activity.schema';
import { Call, CallSchema } from '../../schemas/call.schema';
import { Lead, LeadSchema } from '../../schemas/lead.schema';
import { Recording, RecordingSchema } from '../../schemas/recording.schema';
import { Transfer, TransferSchema } from '../../schemas/transfer.schema';
import { User, UserSchema } from '../../schemas/user.schema';
import { AgentInsightsController } from './agent-insights.controller';
import { AgentInsightsService } from './agent-insights.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Call.name, schema: CallSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Transfer.name, schema: TransferSchema },
      { name: Recording.name, schema: RecordingSchema },
      { name: AgentActivity.name, schema: AgentActivitySchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [AnalyticsController, AgentInsightsController],
  providers: [AnalyticsService, AgentInsightsService],
  exports: [AnalyticsService, AgentInsightsService],
})
export class AnalyticsModule {}
