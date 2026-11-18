import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CallAlert, CallAlertSchema } from '../../schemas/call-alert.schema';
import { Call, CallSchema } from '../../schemas/call.schema';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { Lead, LeadSchema } from '../../schemas/lead.schema';
import { PlatformSettings, PlatformSettingsSchema } from '../../schemas/platform-settings.schema';
import { CallAlertsService } from './alerts.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PlatformSettings.name, schema: PlatformSettingsSchema },
      { name: CallAlert.name, schema: CallAlertSchema },
      { name: Call.name, schema: CallSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: Lead.name, schema: LeadSchema },
    ]),
  ],
  providers: [CallAlertsService],
  exports: [CallAlertsService],
})
export class AlertsModule {}
