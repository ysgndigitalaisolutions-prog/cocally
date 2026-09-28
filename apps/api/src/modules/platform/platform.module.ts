import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CreditEntry, CreditEntrySchema, Invoice, InvoiceSchema } from '../../schemas/billing.schema';
import { Call, CallSchema } from '../../schemas/call.schema';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { PlatformSettings, PlatformSettingsSchema } from '../../schemas/platform-settings.schema';
import { Tenant, TenantSchema } from '../../schemas/tenant.schema';
import { User, UserSchema } from '../../schemas/user.schema';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PlatformService } from './platform.service';
import { UsageService } from './usage.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Call.name, schema: CallSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: User.name, schema: UserSchema },
      { name: PlatformSettings.name, schema: PlatformSettingsSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: CreditEntry.name, schema: CreditEntrySchema },
      { name: Invoice.name, schema: InvoiceSchema },
    ]),
  ],
  controllers: [BillingController],
  providers: [PlatformService, BillingService, UsageService],
  exports: [PlatformService, BillingService, UsageService],
})
export class PlatformModule {}
